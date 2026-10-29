/**
 * Windows 上的 PTY 派生。
 *
 * ## 为什么需要这个模块（而不是直接用 ctx.subprocess.spawnTerminal）
 *
 * 上游 `ctx.subprocess.spawnTerminal` 在 Windows 上的实现会让本插件的会话必死：
 * 经 `confine` 包装后由 ACL 沙箱 runner 派生 PTY，runner 在启动约 1.3 秒后以
 * **自己的失败码 127**（`RUNNER_FAILURE_EXIT`）退出，且 stderr 不进入 PTY，
 * 于是表现为「127 + 零输出」——本插件在这台机器上从未成功起过一次终端。
 *
 * 生态里的参考实现（`dsh-bash-terminal`）同样绕过了这条接缝，其 README 记载：
 * 「Windows 上因上游 `spawnTerminal` 的 process inspector 仅支持 POSIX，
 * 由 `lib/terminal.js` 直连 node-pty」。本模块采用同一做法。
 *
 * ## 为什么不是"降级"
 *
 * 这不是"沙箱失败后偷偷换成无沙箱"。判定发生在 **spawn 之前**，依据是平台与
 * 配置，与"某次运行失败"无关；而且插件**不提供**任何基于失败的自动降级路径。
 * 实际隔离等级由 `enforcement` 字段如实上报，见 `session-state.mjs`。
 *
 * ## 沙箱边界（必须如实告知）
 *
 * 直连 node-pty 派生出的 shell **不受 DSH ACL 沙箱约束**：可写工作区外、可读任意
 * 文件、网络不受限。这与宿主自带侧栏终端、以及生态内所有 PTY 插件的处境相同。
 * 需要文件写入隔离时，应使用官方工具。
 */

import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'

/** node-pty 的原生模块加载结果缓存（成功或失败都只记一次，避免反复触发异常）。 */
let cachedModule
/**
 * 载入 node-pty。
 *
 * node-pty 是 CJS，本包是 ESM，因此走 `createRequire`。载入失败**必须抛出**
 * 结构化错误——绝不静默退回别的路径（那会变成隐式降级）。
 *
 * @returns {object} node-pty 模块
 */
export function loadNodePty() {
  if (cachedModule !== undefined) {
    if (cachedModule.ok) return cachedModule.module
    throw cachedModule.error
  }
  try {
    // 用 import.meta.url 定位，避免依赖 CWD（宿主可能从任意目录启动）
    const require = createRequire(import.meta.url)
    const module = require('node-pty')
    if (module === null || typeof module.spawn !== 'function') {
      throw new Error('node-pty did not expose spawn()')
    }
    cachedModule = { ok: true, module }
    return module
  } catch (error) {
    const wrapped = new Error(
      `background-terminal: cannot load node-pty (${error?.message ?? error}). ` +
        'A Windows PTY needs this module; it is declared in package.json dependencies, ' +
        'so a missing copy means the plugin dependencies were not installed.',
    )
    wrapped.code = 'PTY_MODULE_UNAVAILABLE'
    wrapped.cause = error
    cachedModule = { ok: false, error: wrapped }
    throw wrapped
  }
}

/**
 * 尽力清理派生失败后残留的 node-pty 内部状态。
 *
 * 纯粹是**防泄漏**：不改变抛出的错误、不影响判定。任何一步失败都忽略——
 * 收口动作本身再抛错只会掩盖真正的失败原因。
 *
 * @param {unknown} child 可能未赋值的 node-pty 句柄
 * @param {unknown} error 触发清理的原始错误（用于定位残留字段）
 */
function cleanupFailedSpawn(child, error) {
  try {
    // node-pty 的 WindowsTerminal 在构造失败时会把半成品 agent 挂在自身或错误上
    const candidates = [child, error?.agent, error?.process]
    for (const candidate of candidates) {
      if (candidate === null || typeof candidate !== 'object') continue
      if (typeof candidate.destroy === 'function') candidate.destroy()
      else if (typeof candidate.kill === 'function') candidate.kill()
    }
  } catch {
    // 收口失败无所谓：原始错误才是要传播的东西
  }
}

/**
 * 从「拿到的环境」里剥掉会让 Electron 程序退化成 Node 的变量。
 *
 * ## 为什么必须剥
 *
 * DSH 宿主自己可能是用 Electron 二进制以 Node 模式起的，于是 `process.env` 里带着
 * `ELECTRON_RUN_AS_NODE=1`。这个变量**会被所有子进程继承**：持久 shell 里只要启动
 * 任何 Electron 程序（`electron .`、`npm run electron:dev`、打包脚本），它都会以纯
 * Node 模式运行——不报错、不开窗口，行为看起来像「程序卡住了」，而真正的原因藏在
 * 环境变量里。
 *
 * 剥掉的边界：只影响**本插件派生出来的 shell**，不碰宿主自己的进程；需要
 * Electron-as-Node 的场景可以在 shell 里显式 `set ELECTRON_RUN_AS_NODE=1`。
 *
 * @param {object|undefined|null} env
 * @param {boolean} [keep] true = 原样保留（配置 `passElectronRunAsNode`）
 * @returns {object|undefined|null} 新对象（不改入参）
 */
export function sanitizeEnv(env, keep = false) {
  if (env === undefined || env === null || typeof env !== 'object') return env
  if (keep === true) return env
  const out = {}
  let stripped = false
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') {
      stripped = true
      continue
    }
    out[key] = value
  }
  return stripped ? out : env
}

/** terminate() 等退出确认的默认预算；调用方（集成层）通常传 config.disposeGraceMs。 */
export const DEFAULT_TERMINATE_GRACE_MS = 3000

/**
 * 等一个退出信号落定，超时返回 false。
 *
 * `child.kill()` 只是"请求终止"：ConPTY 的 exit 事件是异步到达的。若 terminate 在
 * 请求之后立即返回，上层会把"还没死"当成"已清理干净"并提前释放容量——那正是
 * `disposeGraceMs` 当初只被记录、没人执行的那一块。这里把"等退出"变成一次有界等待：
 * 超时由调用方按失败上报（→ cleanup-failed，容量保留），而不是默认成功。
 *
 * 定时器 unref：等待本身不该把宿主进程钉住。
 *
 * @param {Promise<unknown>} done handle 的退出承诺（resolve 或 reject 都算已退出）
 * @param {number} graceMs 上限
 * @returns {Promise<boolean>} 是否在预算内确认退出
 */
export function awaitExit(done, graceMs) {
  return new Promise((resolve) => {
    let timer
    const settle = (value) => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      resolve(value)
    }
    // exit 事件先结束时立刻返回；reject 同样意味着"已经不会有更多退出信号了"
    Promise.resolve(done).then(() => settle(true), () => settle(true))
    timer = setTimeout(() => settle(false), graceMs)
    timer.unref?.()
  })
}

/**
 * 派生出 PTY。
 *
 * 返回**与 `ctx.subprocess.spawnTerminal` 相同的 handle 形状**，这样 controller
 * 与集成层不需要区分两种来源：
 *
 * ```js
 * { pid, write(data) -> Promise, terminate() -> Promise,
 *   signalForeground(signal) -> Promise, done -> Promise<{exitCode, signal}>,
 *   output: Readable<'data'|'end'> }
 * ```
 *
 * 成员必须与 `lib/contract.mjs` 的 `PtyHandle` 一致。**曾漏过 `signalForeground`，
 * 导致默认后端下 `terminal_signal` 抛 TypeError 而 221 条测试全绿**——原因是共享假
 * PTY 实现了它、比这个生产件更完整。教训：新增/替换端口实现时，成员守卫必须逐项
 * 对照契约，不能依赖"假件已经实现了"。
 *
 * @param {{argv:string[], cwd?:string, cols?:number, rows?:number, env?:object, terminalType?:string}} spec
 * @returns {Promise<object>} handle
 */
export async function spawnPty(spec) {
  const argv = spec?.argv
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('background-terminal: spawnPty requires a non-empty argv')
  }
  const pty = loadNodePty()
  const file = argv[0]
  const args = argv.slice(1)

  let child
  try {
    child = pty.spawn(file, args, {
      name: spec.terminalType ?? 'xterm-256color',
      cols: spec.cols ?? 120,
      rows: spec.rows ?? 30,
      cwd: spec.cwd,
      env: sanitizeEnv(spec.env ?? process.env, spec.passElectronRunAsNode === true),
    })
  } catch (error) {
    // ConPTY 派生失败时，node-pty 可能已经把 WindowsPtyAgent 建起来（它持有
    // 命名管道与 conhost 句柄），随后才抛错。若不收口，那份内部状态会在事件
    // 循环的后续回合里触发 "Cannot read properties of undefined (reading 'destroy')"
    // ——那会在**测试或进程收尾阶段**才冒出，极难归因。
    // 这里尽力把残留的 agent 清掉，然后把原始错误抛出去（错误本身不掩盖）。
    cleanupFailedSpawn(child, error)
    throw error
  }

  // 复刻 handle 契约。真实 `LocalTerminalHandle.output` 是 `PassThrough`（带背压），
  // 不是裸 EventEmitter —— 所以这里也用 PassThrough，并在缓冲满时暂停 PTY。
  // 集成层按 `handle.output.on('data'|'end')` 消费，两者兼容。
  const output = new PassThrough()
  let resolveDone
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })
  let exited = false
  let outputPaused = false

  const resume = () => {
    if (!outputPaused) return
    outputPaused = false
    if (!exited) child.resume()
  }
  output.on('drain', resume)

  child.onData((chunk) => {
    // write() 返回 false 表示缓冲已满：暂停 PTY，避免无界增长。
    if (!output.write(Buffer.from(chunk, 'utf8')) && !outputPaused && !exited) {
      outputPaused = true
      child.pause()
    }
  })
  child.onExit((event) => {
    exited = true
    // 先结束输出流再落定 done——与真实 LocalTerminalHandle 的顺序一致。
    // 顺序反了会让"退出瞬间到达的尾部输出"在读之前就结算，尾部丢失。
    output.end()
    resolveDone({ exitCode: event?.exitCode ?? null, signal: event?.signal ?? null })
  })

  return {
    pid: child.pid,
    output,
    done,
    async write(data) {
      // 契约：进程已退出时抛错（`contract.mjs` 的 `write`）。不抛的话调用方会以为
      // 输入送达了，而实际上永远不会有反应——这正是最难查的一类"静默失效"。
      if (exited) throw new Error('background-terminal: PTY has exited; cannot write')
      child.write(data)
    },
    /**
     * 向前台进程组发信号。
     *
     * ConPTY 下**没有**向"前台进程组"发信号的 Win32 能力，唯一的手段是把对应的
     * 控制字符写进输入流，由控制台把它交给前台进程。因此：
     *
     *  · `SIGINT` → `\x03`（Ctrl+C）。这是本机唯一真正可用的"中断前台命令"路径，
     *    也是本插件 README 承诺的能力。
     *  · 其它**命名信号**（`SIGTERM` / `SIGKILL` / `SIGTSTP` / `SIGHUP`）→ **抛错**。
     *
     * 为什么不把其它信号退化成 `child.kill()`：那会**关掉整个会话**，而本插件的
     * 既有不变量是"SIGINT/SIGTERM 只作用于前台、不关会话；要关会话必须显式
     * `close: true`"。静默终止会让"我按了 Ctrl+C 结果 shell 没了"这种事故无法解释。
     *
     * @param {string} signal
     * @returns {Promise<number|undefined>} 前台进程组 id；ConPTY 不提供，返回 undefined
     */
    async signalForeground(signal) {
      if (exited) throw new Error(`background-terminal: PTY has exited; cannot deliver ${signal}`)
      if (signal === 'SIGINT') {
        child.write('\x03')
        return undefined
      }
      throw new Error(
        `background-terminal: signalForeground(${signal}) is not supported on Windows ConPTY; `
          + 'only SIGINT (delivered as Ctrl+C) is available. Closing the session requires close: true.',
      )
    },
    /**
     * 终止会话，并**等到退出落定**才返回。
     *
     * 两段式在这里只能是"请求终止 + 有界等待"：ConPTY 没有向进程树发 SIGTERM 的
     * Win32 能力（同 signalForeground 那节），所以没有"先礼后兵"的第二只手可用。
     * 能保证的是**不提前声称成功**——预算内没等到 exit 就按失败抛出，上层据此进入
     * cleanup-failed 并保留容量与围栏。
     *
     * @param {{graceMs?:number}} [options]
     */
    async terminate(options) {
      if (exited) return
      const graceMs = Number.isSafeInteger(options?.graceMs) && options.graceMs > 0
        ? options.graceMs
        : DEFAULT_TERMINATE_GRACE_MS
      try {
        child.kill()
      } catch (error) {
        // 与 LocalTerminalHandle 一致：terminate 失败必须抛出，让上层进入
        // cleanup-failed 并保留容量，而不是误判为"已清理干净"。
        throw new Error(`background-terminal: PTY terminate failed: ${error?.message ?? error}`)
      }
      const gone = await awaitExit(done, graceMs)
      if (!gone) {
        throw new Error(
          `background-terminal: PTY did not report exit within ${graceMs}ms after terminate; `
            + 'the process tree may still be alive (verify with terminal_state diagnostics)',
        )
      }
    },
  }
}
