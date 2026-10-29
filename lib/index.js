/**
 * 集成层：把各模块接成一个插件，并注册四个模型面工具。
 *
 * 本文件是唯一允许同时 import 各模块**实现**的地方（见 lib/contract.mjs 硬约束 3）。
 * 不 import 任何 `@deepseek-ai/*`：工具用普通对象注册（`ctx.tools.register` 接受普通对象
 * 定义），配置校验用普通函数抛错，不引入 schemastery/cordis。
 */

import { createAdmission } from './records.mjs'
import { createSandboxFence } from './fence.mjs'
import { createController } from './controller.mjs'
import { detectReadiness, extractFrame, startupPreamble, wrapCommand } from './shell-bash.mjs'
import { createProtocolResponder } from './protocol.mjs'
import { createPump } from './pump.mjs'
import { createCursor, read } from './reader.mjs'
import { INPUT_ERRORS } from './contract.mjs'
import { MAX_WAIT_MS, assertShellSupported, resolveConfig, resolveCwd } from './config.mjs'
import { randomUUID } from 'node:crypto'

import { createLog } from './log.mjs'
import { spawnPty } from './pty-windows.mjs'
import { SANDBOX_PTY_START_FAILED, classifyStartupOutcome, createDiagnostics } from './diagnostic.mjs'
import { DEFAULT_PROGRESS_INTERVAL_MS, createProgressTracker, renderProgress } from './progress.mjs'
import { outputFinalOf, snapshotSession, snapshotSessions, unreadBytesOf } from './session-state.mjs'
import { dangerousCommandError, detectDangerous } from './danger.mjs'
import { resolveShellPath, shellFlavorOf, shellNotFoundMessage, validateShellPath } from './shell-resolve.mjs'
import { loadBundledSkill } from './bundled-skill.mjs'

/**
 * 每个会话允许的**唤醒次数上限**。
 *
 * 宿主对唤醒次数**没有任何全局上限**：`dsh-agent-loop` 的 `wakeDriver` 只有并发闩锁
 * （非 idle 时置 `wakeRequested`、收尾时重放），唯一的预算 `spentWakes` 是
 * `dsh-tool-jobs` 自己闭包里的 WeakMap。所以这个上限必须由插件自己持有——
 * 否则"事件→唤醒→回合→新事件→再唤醒"可以无限循环。
 */
const MAX_WAKES_PER_SESSION = 8

/**
 * 有界等待窗口的默认值与上限。
 *
 * 默认 10s：覆盖大多数安装/构建的启动段，又不至于让一次工具调用久等。
 * 上限 30s：超时的语义是"把控制权还给我"，不是"命令失败"——真长任务应当走
 * 超时返回 + 之后自己 `terminal_read` / `terminal_state`，而不是把调用挂成几分钟。
 */
const DEFAULT_WAIT_MS = 10_000

/** `readCount` 的上限：一次调用最多读 20 次（每次上限 `maxOutputChars`）。 */
const MAX_READ_COUNT = 20

/**
 * 卸载时推迟 Jobs 结算的兜底时长。
 *
 * 卸载先把结算挂起，好让宿主的 teardown 来得及给 job 打上 `cause: 'teardown'`
 * ——那是 dsh-tool-jobs 唯一会抑制完成通知的条件，也是「关 DSH 不该惊动模型」的开关。
 * 宿主若不在退出（插件热重载），没有任何人会来 cancel，于是这个定时器按普通结算放行。
 * 宿主退出时进程早就没了，定时器根本不会触发。
 */
const TEARDOWN_SETTLE_FALLBACK_MS = 1_500

/** 固定信号枚举——禁止把任意 OS signal 字符串透传（FINAL.md §11.3）。 */
const ALLOWED_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL'])

/**
 * 插件版本，回显在每个 terminal_exec 结果里。
 *
 * 存在的理由：宿主重启后到底有没有加载到新代码，靠"看日志"是看不见的
 * （日志只在宿主控制台）。一个能被工具返回值读到的版本号，把这件事变成可观测的。
 * 改动行为时同步递增它。
 */
export const PLUGIN_VERSION = '1.0.0'

/** 终态 phase：此后的读取视为 final。 */
const TERMINAL_PHASES = new Set(['exited', 'killed', 'failed', 'cleanup-failed'])

/**
 * 只有进程**确认消失**的终态才允许对残缺 UTF-8 做一次 replacement。
 * cleanup-failed 的进程可能还活着，此时吐替换字符会把"后面还有字节"这件事说死。
 */
const FLUSH_PHASES = new Set(['exited', 'killed', 'failed'])

function inputError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * 首条命令队列。
 *
 * 语义：命令在 reserve 时（同步、早于任何 spawn）入队；只有 shell 就绪后才被
 * `drain()` 取走并写入 stdin。未就绪时 `drain()` 返回空数组——这就是
 * 「启动超时也不会丢首条命令」的那条保证（FINAL.md §6.7 例 4）。
 */
function createCommandQueue() {
  const entries = []
  let ready = false
  return {
    push(entry) {
      entries.push(entry)
    },
    markReady() {
      ready = true
    },
    isReady() {
      return ready
    },
    drain() {
      if (!ready || entries.length === 0) return []
      return entries.splice(0)
    },
    size() {
      return entries.length
    },
  }
}

function requireSession(admission, owner, rawId) {
  const record = admission.find(owner, rawId)
  if (record === undefined) throw new Error(`unknown terminal session ${JSON.stringify(rawId)}`)
  return record
}

/**
 * 安全读取**可选**的 ctx 服务。
 *
 * Cordis 的两个坑都在这里一次挡掉：
 *  1. ctx 是代理，读**未 inject** 的服务属性会抛 `cannot get property "…" without inject`
 *     （`?.` 与 `=== undefined` 都拦不住）；
 *  2. 可选服务不能用 `inject` 声明——`inject` 是**硬依赖**，声明了但组合里没有，
 *     整条 entry 会停在 `pending (waiting for service: …)` 永不激活。
 *
 * 所以可选服务优先走 `ctx.get(name)`（Cordis 官方的可选取法），属性读法只作为兜底。
 */
function optionalService(ctx, name) {
  try {
    if (typeof ctx.get === 'function') return ctx.get(name) ?? undefined
  } catch {
    // get 不可用或抛错时落到属性读法
  }
  try {
    const value = ctx[name]
    return value === null ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * 沙箱 provider 标签（如 `windows-acl`）：runner 的原始报错里出现的就是这个名字，
 * 诊断里必须能对上。服务没自报名字时写 `unknown`——不猜。
 */
function providerLabel(sandbox) {
  if (sandbox === undefined || sandbox === null) return 'unknown'
  for (const key of ['provider', 'name', 'id']) {
    try {
      const value = sandbox[key]
      if (typeof value === 'string' && value.length > 0) return value
    } catch {
      // 读属性可能抛（代理服务），继续试下一个
    }
  }
  return 'unknown'
}

/**
 * 建立插件运行时。
 * @param {object} ctx Cordis 上下文
 * @param {object} [rawConfig]
 */
export function createRuntime(ctx, rawConfig = {}) {
  // shell 解析放在这里而不是 config.mjs：config 保持纯解析（不碰文件系统），
  // 发现逻辑集中在一个模块里，且**挂载期就失败得早**，不等到第一次 terminal_exec。
  // 显式配置的 shellPath 原样信任（运维的断言）；只有发现出来的路径必须真实存在。
  const dialectHint = typeof rawConfig.shellDialect === 'string' ? rawConfig.shellDialect : 'bash'
  const shellChoice = resolveShellPath({
    dialect: dialectHint,
    platform: process.platform,
    env: process.env,
    explicit: rawConfig.shellPath,
  })
  if (shellChoice.path === undefined) {
    throw new Error(shellNotFoundMessage({ dialect: dialectHint, platform: process.platform, tried: shellChoice.tried }))
  }
  const config = resolveConfig({ ...rawConfig, shellPath: shellChoice.path })

  /**
   * 硬依赖校验。这些服务都在 `inject` 里声明过，因此**直接属性读是安全的**
   * （Cordis 只对未 inject 的属性抛）。不能走 optionalService：那是给可选取法用的。
   */
  const requireService = (name, check) => {
    const service = ctx[name]
    if (service === undefined || service === null || (check !== undefined && !check(service))) {
      throw new Error(`background-terminal: missing required service "${name}"`)
    }
    return service
  }

  requireService('sessionProjections', (s) => typeof s.stateOf === 'function')
  requireService('sandboxPolicy', (s) => typeof s.resolve === 'function')
  requireService('subprocess', (s) => typeof s.spawnTerminal === 'function')

  const lifecycle = { closed: false }
  const log = createLog(optionalService(ctx, 'logger'), config.logLevel)
  const warn = (msg) => log.warn(msg)
  // 启动证据链（lib/diagnostic.mjs）：只观测、只描述，不参与任何判定或重试
  const diagnostics = createDiagnostics()

  // 活动会话的进度定时器。终态即停，teardown 统一兜底清扫——绝不泄漏定时器。
  const progressTrackers = new Set()

  /**
   * 每个会话已用掉的唤醒次数（`MAX_WAKES_PER_SESSION` 的账本）。
   *
   * 用 WeakMap 以 record 为键：会话被回收时账本一起消失，不需要手工清理，
   * 也就不会有"账本泄漏一条终态会话"的问题。
   */
  const wakeSpent = new WeakMap()

  const admission = createAdmission({
    maxSessionsPerAgent: config.maxSessionsPerAgent,
    maxSettledRetainedPerAgent: config.maxSettledRetainedPerAgent,
    settledRetainMs: config.settledRetainMs,
    maxPendingWriteBytes: config.maxPendingWriteBytes,
    maxPendingWriteCount: config.maxPendingWriteCount,
    maxPendingSignalCount: config.maxPendingSignalCount,
    log: warn,
  })
  const fence = createSandboxFence(ctx)
  admission.setFence(fence)

  // 终态记录的保留期清扫：registry 自身不持定时器（sweepNow 是显式接口），
  // 否则 swept 的记录会一直占着注册表内存。周期取保留期的一半，下限 30s。
  const sweepIntervalMs = Math.max(30_000, Math.floor(config.settledRetainMs / 2))
  const sweepTimer = setInterval(() => {
    try {
      admission.sweepNow()
    } catch (error) {
      warn(`background-terminal: retention sweep failed: ${String(error)}`)
    }
  }, sweepIntervalMs)
  sweepTimer.unref?.()

  /**
   * 运行时自有资源的清理：保留期清扫定时器 + 活动会话的进度定时器。
   *
   * 必须由 `apply()` 的 teardown 经 `runtime.shutdown()` 调用，而不是在 effect 回调里
   * 直接写 `clearInterval(sweepTimer)`：`sweepTimer`/`progressTrackers` 都是本函数的局部量，
   * 在 `apply()` 的作用域里不可见——那行代码一直抛 ReferenceError，
   * 于是 teardown 从第一行起就整体中断（定时器、围栏、会话、工具注册全部漏掉）。
   */
  function shutdown() {
    clearInterval(sweepTimer)
    for (const tracker of progressTrackers) tracker.stop()
    progressTrackers.clear()
  }

  const controller = createController({
    config,
    admission,
    lifecycle,
    log: warn,
    diagnostics,
    // 结构化日志留给 controller 自己决定细节
    logEvent: (level, ...args) => log[level]?.(...args),
    spawnTerminal: (spec) =>
      config.ptyBackend === 'node-pty'
        ? spawnPty({ ...spec, cwd: spec.cwd, env: spec.env, passElectronRunAsNode: config.passElectronRunAsNode })
        : ctx.subprocess.spawnTerminal(spec),
    // 直连后端要裸 shell argv（record.ptyArgv）；host 后端要 confine 包装后的 argv。
    spawnArgvOf: (record) =>
      config.ptyBackend === 'node-pty' && Array.isArray(record.ptyArgv) ? record.ptyArgv : undefined,
    onPublished: (record, handle) => publishSession(record, handle),
    terminateRecord: (record) => attemptTerminate(record),
    flushPump: (record) => record.pump?.flush(),
  })

  log.info('mounted', {
    shellDialect: config.shellDialect,
    shellPath: config.shellPath,
    shellArgs: config.shellArgs,
    logLevel: config.logLevel,
    sandboxProvider: optionalService(ctx, 'sandbox') !== undefined ? 'present' : 'absent',
    maxSessionsPerAgent: config.maxSessionsPerAgent,
  })

  // ── 会话发布：建唯一 pump、挂输出、起 readiness 监视 ──────────────────────
  function publishSession(record, handle) {
    const pump = createPump({ maxBufferBytes: config.maxBufferBytes })
    record.pump = pump
    record.cursor = createCursor() // 模型侧的唯一读取游标
    record.session = { pump, cursor: record.cursor, handle }
    // 发布时刻：`terminal_state` 的 elapsedMs 以它为锚（只观测，不参与任何判定）
    record.publishedAt = Date.now()

    log.info('pty published', { session: record.id, pid: handle.pid })

    // 终端协议应答（DA1/DA2/DSR）：程序问「光标在哪」时必须有回答，否则它会卡到
    // 自己的超时，看起来和进程卡死一模一样。近似范围见 lib/protocol.mjs 文件头。
    const responder = config.respondToTerminalQueries === true
      ? createProtocolResponder({ cols: record.cols ?? config.cols })
      : undefined

    // 唯一的 output 消费点：PTY output 只被这里读一次。
    pump.attachSink({
      write: (chunk) => {
        record.readyBuffer = `${record.readyBuffer ?? ''}${chunk}`.slice(-(config.maxOutputChars * 2))
        if (record.ready !== true) maybeReady(record)
      },
      // 输出流结束**不是**就绪证据——它恰恰是"这个 shell 可能已经挂了"的信号。
      // 这里绝不能调 markReady：markReady 会置 record.served，而 controller 只用
      // served 区分"跑完退出"与"起来就挂"。EOF 置 served，会让真机上的
      // "127 + 零输出"重新被判成 natural-exit（phase exited、"exit code 127"）。
      // 队列放行交给信标（maybeReady → markReady）或静默兜底定时器；
      // shell 未就绪就死掉时会话直接进 failed，本来也不该再有机会收命令。
      // 这个空 end 必须保留：pump.flush() 会无差别调用每个 sink 的 end()，
      // 缺了它 flush 会抛错，后面的 sink（等待中的读取）就再也收不到通知。
      end: () => {},
    })

    // jobs 输出环：把**清洗后**的同一份文本再推给 job（模型读到什么，/jobs 面板就看到什么）。
    // pump 的 sinks 是 Set，多挂一个 sink 即可——不需要改 pump 内部。
    // job 结算后 handle.append 由注册表自行丢弃（并打警告），这里不做额外处理。
    pump.attachSink({
      write: (chunk) => {
        const jobHandle = record.jobHandle
        if (jobHandle === undefined || typeof jobHandle.append !== 'function') return
        try {
          jobHandle.append(chunk)
        } catch (error) {
          // 输出环故障绝不能打断 PTY 管道：emitSink 没有逐 sink 容错，
          // 这里抛出去会沿 appendRaw → 'data' 事件一路冒成未捕获异常。
          log.debug('job append failed', { session: record.id, error })
        }
      },
      end: () => {},
    })

    handle.output.on('data', (chunk) => {
      if (record.outputClosed === true) return
      const bytes = chunk?.length ?? 0
      // 进度观测：原始 PTY 字节数与"最后一次输出"的时刻（只观测，不改 pump 内部）
      record.outputBytes = (record.outputBytes ?? 0) + bytes
      record.lastOutputAt = Date.now()
      // 同时喂给进度 tracker。**不能只靠 `describe` 提供这两个值**：
      // `createProgressTracker.snapshot()` 里 tracker 自己的 `outputBytes` /
      // `lastOutputAgoMs` 是在 `...dynamicFields()` **之后**写入的（progress.mjs:176-183），
      // 会把 describe 给的值覆盖掉。不调 `noteOutput` 的后果实测是进度行**永远是**
      // `out 0B · no output yet`——长任务看不出在干活，正是这个功能存在的理由。
      record.progressTracker?.noteOutput?.(bytes)
      // 命令级 framing：从原始 chunk 里累积帧窗口并判定"这条命令结束了没有"。
      // 用原始文本而非清洗后文本即可——帧标记与退出码都是纯 ASCII，不含 ANSI；
      // 窗口里混入 ANSI 只影响 `done.text`（本实现不消费它），不影响标记匹配与退出码。
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      onFrameText(record, text)
      if (responder !== undefined) {
        for (const reply of responder.feed(text)) {
          handle.write(reply).catch((error) => {
            log.debug('terminal protocol reply failed', { session: record.id, error })
          })
        }
      }
      // 启动期的原始输出在 debug 下可见——"起来就挂"时这是唯一线索
      log.debug('pty data', { session: record.id, bytes })
      pump.appendRaw(chunk)
    })
    handle.output.on('error', (error) => log.error('pty output error', { session: record.id, error }))
    // 输出流结束 = 尾部数据已全部投递（Node 保证 'end' 在最后一个 'data' 之后），
    // 所以这里必须**真正 flush pump**：收尾 ANSI 剥离器、抛出不完整 UTF-8 尾部、
    // 并通知每个 sink 的 end 回调。不能只靠 controller 结算时的 flushPump：
    // 会话迟迟不落定（例如 handle.done 不落定）时，等待中的 terminal_read
    // 将收不到任何"输出到此为止"的通知，只能等满 waitMs。
    handle.output.on('end', () => {
      record.outputEnded = true
      log.debug('pty output ended', { session: record.id, totalBytes: pump.totalBytes?.() })
      Promise.resolve(pump.flush()).catch((error) => {
        log.error('pump flush failed', { session: record.id, error })
      })
    })

    // 启动序列：抑制回显（bash）并打印就绪信标。信标是"可以收命令了"的正面证据，
    // 不去猜提示符——PowerShell 的 `PS C:\…>` 与命令输出无法可靠区分。
    const preamble = startupPreamble(config.shellDialect)
    log.debug('writing startup preamble', { session: record.id, preamble })
    handle.write(`${preamble}\r`).catch((error) => {
      log.error('startup preamble failed', { session: record.id, error })
    })

    startProgressTracking(record)
  }

  /**
   * 启动 jobs 实时进度行。**只汇报观测值**（已经过多久、产出多少字节、距上次输出多久、
   * 进程是否已退出），绝不判断"是否卡死"——`npm install` 能静默工作数分钟。
   *
   * 终态即停且**不推最后一帧**：进度行只在"等待期间"有意义，终态由 job 状态本身表达；
   * 这样"进入终态后不再更新"是一条能被断言的不变量。
   */
  function startProgressTracking(record) {
    const tracker = createProgressTracker({
      intervalMs: config.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS,
      // `outputBytes` / `lastOutputAgoMs` 由 data 回调喂给 tracker 的 `noteOutput`
      // （权威来源）；这里额外提供一份**回退值**，避免任何接入遗漏导致进度行
      // 永远显示 `out 0B · no output yet` 却看不出异常。
      // 只提供**观察不到就不该编**的字段（phase / exited）。
      //
      // `outputBytes` / `lastOutputAgoMs` 不在这里给：它们由 data 回调经
      // `tracker.noteOutput(bytes)` 喂入，那是 tracker 的设计意图，也是
      // `createProgressTracker.snapshot()` 里后写入、会覆盖 describe 的字段。
      // 两处都提供等于互为兜底——单点变异将测不出任何一侧，反而掩盖真实覆盖。
      // 所以要保证的是**这一条链**：`handle.output.on('data')` → `noteOutput`。
      describe: () => ({
        phase: record.phase,
        exited: TERMINAL_PHASES.has(record.phase),
      }),
      onTick: (state) => {
        const jobHandle = record.jobHandle
        if (jobHandle === undefined || typeof jobHandle.updateProgress !== 'function') return
        try {
          jobHandle.updateProgress(renderProgress(state))
        } catch (error) {
          // 进度行是观测，不是产品功能：失败只记日志，绝不影响会话生命周期
          log.debug('updateProgress failed', { session: record.id, error })
        }
      },
    })
    record.progressTracker = tracker
    progressTrackers.add(tracker)
    tracker.start()
    // 会话落定（含 cleanup-failed）即停：复用既有生命周期信号，不新增判定
    record.outcomeGate?.promise?.then(() => stopProgress(record), () => stopProgress(record))
  }

  function stopProgress(record) {
    const tracker = record.progressTracker
    if (tracker === undefined) return
    record.progressTracker = undefined
    progressTrackers.delete(tracker)
    tracker.stop()
  }

  /**
   * readiness 组合判定（FINAL.md §7.2）：prompt 标记先到就立即就绪；
   * 否则等一段静默期作为兜底。绝不把 inspectActivity()==='unknown' 当 idle。
   */
  function maybeReady(record) {
    if (record.ready === true) return
    const buffered = record.readyBuffer ?? ''
    if (buffered.length > 0 && detectReadiness(buffered)) {
      markReady(record)
      return
    }
    if (record.readyTimer === undefined) {
      record.readyTimer = setTimeout(() => {
        record.readyTimer = undefined
        if (record.ready !== true && (record.readyBuffer ?? '').length > 0) markReady(record)
      }, config.readyQuietMs)
      record.readyTimer.unref?.()
    }
  }

  function markReady(record) {
    if (record.ready === true) return
    record.ready = true
    if (record.readyTimer !== undefined) {
      clearTimeout(record.readyTimer)
      record.readyTimer = undefined
    }
    // 就绪 = 这个 shell 真正开始服役。controller 用它区分"跑完退出"（natural-exit）
    // 与"起来就挂"（shell-exited → phase failed）：**发布成功不等于能服役**，
    // 真机上的崩溃正是"发布完成、信标未到"那一形态。
    record.served = true
    log.info('shell ready', { session: record.id, evidence: 'startup beacon' })
    record.commandQueue.markReady()
    // 发布后唯一的一次队列 flush：首条命令（序号 0）在此时才写入。
    void firstCommandFlush(record)
  }

  /**
   * 把队列里待写的命令字面输入写进 shell。
   *
   * 两处共用：就绪时的首条命令（firstCommandFlush），以及续签（会话已 running，
   * 入队后立刻 flush）。写失败只记日志、不抛——收口交给帧/等待窗口，避免一次写失败
   * 把整个会话判死。
   */
  async function flushCommandQueue(record, label) {
    for (const entry of record.commandQueue.drain()) {
      try {
        log.info(label, { session: record.id, generation: entry.seq, bytes: entry.text.length })
        await record.handle.write(entry.text)
      } catch (error) {
        log.error('command write failed', { session: record.id, error })
      }
    }
  }

  async function firstCommandFlush(record) {
    await flushCommandQueue(record, 'writing first command')
    for (const entry of record.pendingWrites.splice(0)) {
      try {
        await record.handle.write(entry.text)
      } catch (error) {
        warn(`background-terminal: ${record.id} queued write failed: ${String(error)}`)
      }
    }
    for (const entry of record.pendingSignals.splice(0)) {
      // 排队的中断在这里才真正送达；中断事实同样要落地（见 beginInterrupt）。
      beginInterrupt(record)
      try {
        await record.handle.signalForeground(entry.signal)
      } catch (error) {
        failInterrupt(record, error)
        warn(`background-terminal: ${record.id} queued ${entry.signal} failed: ${String(error)}`)
      }
    }
  }

  // ── 终止：唯一入口由 controller 拥有；这里只提供底层动作 ─────────────────
  /**
   * 底层终止动作。契约（controller 依赖它）：**失败即 reject**。
   *
   * 这里绝不能吞异常：吞掉会让 controller 把「清理失败、进程可能还在」
   * 当成成功，从而提前释放容量并解除围栏（FINAL.md §6.9 / R7-03）。
   * 错误原文由 controller 记入 record.terminal.detail，用户可用
   * terminal_signal close: true 重试。
   */
  async function attemptTerminate(record) {
    const handle = record.handle
    if (handle === undefined) {
      record.terminateReportedGone = true
      return
    }
    // 传 disposeGraceMs：terminate 内部会等退出落定，超时按失败抛出（→ cleanup-failed）。
    await handle.terminate({ graceMs: config.disposeGraceMs })
    record.terminateReportedGone = true
  }

  // ── terminal_exec ────────────────────────────────────────────────────────
  /**
   * 把一条命令包帧后入队，并把帧标识记在 record 上供输出侧提取。
   *
   * `wrapCommand` **只在这里调一次**：它每次生成新的 nonce，调两次会得到两组互不
   * 匹配的标记，输出侧就永远闭不上帧。
   *
   * @param {object} record
   * @param {string} command 原始命令行
   * @param {number} seq
   * @returns {{start:string, end:string}} 该命令的帧标识
   */
  function enqueueCommand(record, command, seq) {
    const wrapped = wrapCommand(command, config.shellDialect)
    // 代次在**唯一签发点**递增：命令级事实（commandRunning / lastCommandExitCode /
    // interrupt）从此都归属于某个代次。以前只允许一条帧命令时它恒为 1，字段被撤过；
    // 现在续签是一条真实可走的路径（terminal_exec 的 sessionId），它才有意义。
    record.commandGeneration = (Number.isSafeInteger(record.commandGeneration) ? record.commandGeneration : 0) + 1
    record.pendingFrame = { start: wrapped.start, end: wrapped.end }
    // 这里**不做**「中断确认」：续签虽然存在（toolExecExisting），但它要求调用方显式
    // `reset: true` 才放弃旧帧——插件不会因为"下一条命令来了"就自动替上一帧收口。
    // 曾经挂在这里的 confirmInterruptByNewCommand 实测是**永远走不到的死代码**，已删除；
    // 中断的未知性因此**如实留在 `interrupt.state` 上**，不假装已确认。
    // 帧窗口从本命令的 start 标记之后开始累积（见 onFrameText）
    record.frameWindow = ''
    // 等待完成用的等待者：`awaitCommand` 挂一个，帧闭合时收口并带上退出码。
    // 用"一次性 resolve + 置空"而不是队列：同一时刻只可能有一条在跑的命令。
    record.commandDone = undefined
    record.commandQueue.push({ seq, text: `${wrapped.text}\r`, submit: true })
    return { start: wrapped.start, end: wrapped.end }
  }

  /**
   * 中断事实（P0-INT-1 冻结契约）。
   *
   * 三条收口路径里，**只有 interrupt 这条路**在插件视野内拿不到可靠的结束证据：
   * Ctrl+C 打断的是整行输入，行尾那句"打印结束标记"的语句一并没执行，所以帧永不闭合，
   * 而 `commandRunning` 正是由"帧未闭合"推出的 —— 它会永久停在 true。
   *
   * 写入点分工（两个模块，各管一段，别把它当成一处）：
   *   · lib/index.js      —— 送货：delivered / failed；
   *   · lib/controller.mjs —— 会话落定时做未确认降级：delivered → interrupt-pending。
   *
   * **`interrupted` 在本实现里不可达**：它需要「进程组已确认消失」这一会话侧事实，
   * 而本插件没有独立探针通道，拿不到该事实。
   * 所以如实停在 `delivered`（未确认），**不伪造一个「已确认」**。
   * 该事实只能由调用方在插件之外核验（进程树 / 端口）。
   *
   * 这里**不改** `commandRunning` 的既有语义（它如实反映"帧没闭合"这一观测事实），
   * 而是把"中断这件事"记成结构化事实，让投影层据此标出 `commandStateTrustworthy: false`。
   * 调用方因此知道此刻那个字段不可信，而不是被它永久骗住。
   */
  function beginInterrupt(record) {
    record.interruptSeq = (record.interruptSeq ?? 0) + 1
    const at = Date.now()
    record.interrupt = {
      id: `intr-${record.interruptSeq}`,
      state: 'delivered',
      requestedAt: at,
      deliveredAt: at,
      verifiedAt: null,
      // externalSide 恒为 null：目标进程树与服务端口不在插件视野内，绝不假装观测到。
      evidence: { sessionSide: null, externalSide: null },
      detail: null,
    }
    return record.interrupt
  }

  /** 信号没能写进 PTY。如实记 failed，不留下一个看起来"已送达"的假记录。 */
  function failInterrupt(record, error) {
    const current = record.interrupt
    if (current === undefined) return
    current.state = 'failed'
    current.detail = `signal delivery failed: ${String(error?.message ?? error)}`
  }

  /**
   * 等一条命令结束，最多等 `waitMs`。
   *
   * 这是"有界等待"的实现：命令在窗口内结束就拿到退出码，超时就返回 undefined 把
   * 控制权还给调用方——**会话照旧活着**，所以调用方可以稍后自己
   * `terminal_read` / `terminal_state` 看进展，或者换策略。
   *
   * @param {object} record
   * @param {number} waitMs
   * @returns {Promise<{exitCode:number}|undefined>} 超时返回 undefined
   */
  function awaitCommand(record, waitMs) {
    // 没有未闭合的帧 = 这条命令已经结束（帧闭合是一次性的）
    if (record.pendingFrame === undefined) return Promise.resolve(record.lastCommand)
    return new Promise((resolve) => {
      let timer
      const finish = (value) => {
        if (timer !== undefined) clearTimeout(timer)
        record.commandDone = undefined
        resolve(value)
      }
      record.commandDone = (value) => finish(value)
      // **不要 unref**：这个定时器承载"这次调用最多等多久"的语义，被回收会让
      // 调用方永远拿不到超时结果（表现为 pending 不落定）。
      timer = setTimeout(() => finish(undefined), waitMs)
    })
  }

  /**
   * 输出侧的帧提取：判断**一条命令**是否已结束，并拿到它的退出码。
   *
   * 这是 `terminal_exec` 与 `extractFrame` 之间原本缺失的那根线——没有它，插件只知道
   * **会话**何时结束，不知道**命令**何时结束，因此命令级退出码与"命令跑完了"这个
   * 事件都不存在（会话是持久 shell，永远不结算）。
   *
   * 只保留上一处 start 标记之后的文本：命令输出里无法预知 nonce（SH4），所以窗口不会
   * 被伪造内容顶掉，也不会随会话时长无界增长。
   *
   * @param {object} record
   * @param {string} text 本 chunk 的 clean 文本
   */
  function onFrameText(record, text) {
    const frame = record.pendingFrame
    if (frame === undefined) return
    record.frameWindow = `${record.frameWindow ?? ''}${text}`
    // 窗口裁剪：留最后一处 start 标记之后的全部内容（含极长的单行输出）
    const startAt = record.frameWindow.lastIndexOf(frame.start)
    if (startAt > 0) record.frameWindow = record.frameWindow.slice(startAt)
    const done = extractFrame(record.frameWindow, frame)
    if (done === undefined) return
    record.pendingFrame = undefined
    record.frameWindow = ''
    record.lastCommand = {
      seq: record.lastCommand === undefined ? 0 : record.lastCommand.seq + 1,
      generation: record.commandGeneration ?? null,
      exitCode: done.exitCode,
      at: Date.now(),
      // 帧自己闭合了 = 命令自然结束。中断路径永远走不到这里（帧闭不上），
      // 那种情况的收口事实记在 record.interrupt 上，见 beginInterrupt。
      endReason: 'natural',
    }
    log.debug('command frame closed', { session: record.id, exitCode: done.exitCode })
    // 唤醒在等这条命令的调用方（有界等待），并清掉等待者
    const waiter = record.commandDone
    record.commandDone = undefined
    waiter?.(record.lastCommand)
    // 命令结束 → 询问式送达（只有 `notifyOnExit: true` 才会真的发）
    onCommandSettled(record, done.exitCode)
  }

  /**
   * 命令结束后的**按需**送达。
   *
   * ## 为什么是"按需"而不是默认送
   *
   * 宿主对**唤醒次数没有任何全局上限**（`dsh-agent-loop` 的 `wakeDriver` 只有并发闩锁；
   * 唯一的唤醒预算 `spentWakes` 在 `dsh-tool-jobs` 自己的闭包里）。也就是说插件一旦
   * 默认唤醒，就能造出"事件→唤醒→回合→新事件→再唤醒"的无界循环，而宿主不会拦。
   *
   * 所以本插件的纪律是：**只有调用方明确声明"我在等这条命令"（`notifyOnExit: true`）
   * 才送达**；没声明就不打扰——该看的时候自己用 `terminal_read` 去看。
   *
   * ## 自造消息的理由与约束
   *
   * 插件**不能 import `@deepseek-ai/*`**（profile 里解析不到），拿不到
   * `createUserMessage`；而既有三条唤起通路（`agentTeams.sendMessage` / 子代理
   * `sendMessage` / `schedule.create`）**没有一条允许插件唤起终端 owner 自己**。
   * 因此只能自造消息，且必须**严格守住最小合法形状**——该校验只在 adopt/restore
   * 路径执行（`dsh-session` 的 `assertMessageEventShape`），畸形消息**当场不报错、
   * 重启后才判死会话日志**，所以四个字段一个都不能凑合。
   *
   * @param {object} record
   * @param {number} exitCode
   */
  function onCommandSettled(record, exitCode) {
    if (record.notifyOnExit !== true) return
    // 卸载中不再唤醒：此刻会话正在被收掉，叫醒 agent 只会换来一次对着尸体发问的回合。
    if (lifecycle.closed === true) return
    const agent = record.ownerAgent
    if (agent === undefined || agent === null) return

    // 护栏①：预算。调用方声明"我在等"不等于允许无限唤醒。
    const spent = wakeSpent.get(record) ?? 0
    if (spent >= MAX_WAKES_PER_SESSION) {
      log.debug('wake budget exhausted', { session: record.id, spent })
      return
    }

    // 护栏②：严格四字段形状（见上方说明）。source.kind 自报为 'terminal'。
    const payload = {
      id: randomUUID(),
      role: 'user',
      source: { kind: 'terminal', sessionId: record.id, jobId: record.jobId, form: 'notice' },
      content: [{
        type: 'text',
        // 三条收口路径（自然 / 人类触发 / 主动中断）必须可分辨，而这条异步唤醒消息是 agent
        // **唯一被动看到**的信号 —— 路径不写清楚，"结束了"就还是糊的。
        // 取不到就写 unknown，不得默认写 natural（那等于把"不知道"伪装成"自然结束"）。
        text: `[background-terminal] 命令已结束（会话 ${record.id} 仍在运行）：exit code ${exitCode}。`
          + `endReason=${record.lastCommand?.endReason ?? 'unknown'}。`
          + '用 terminal_read 读取输出。',
      }],
    }

    try {
      // 护栏③：idle 才 followup（开会话），忙时 inject（只排队，不递归唤醒）。
      // 与 `dsh-tool-jobs` 的分流一致，也正是"自唤起不会递归"的原因。
      if (agent.status === 'idle') agent.followup(payload)
      else agent.inject(payload)
      wakeSpent.set(record, spent + 1)
      log.info('wake delivered', { session: record.id, exitCode, idle: agent.status === 'idle', spent: spent + 1 })
    } catch (error) {
      // 护栏④：送达失败不得影响终端会话本身（通道是观测，不是产品功能）
      log.warn('wake delivery failed', { session: record.id, error: String(error) })
    }
  }

  /**
   * 读次数（`readCount`）的合法化：整数、1..20。
   *
   * 选"次数"而不是"字符数"作为模型面参数，是因为它直接对应"我要看多少屏"；
   * 每次读的上限由既有的 `maxOutputChars` 决定，不必再引入第二个量纲。
   * 非法输入静默回落到默认 1——参数错了不该让整个调用失败。
   */
  function clampReadCount(value) {
    if (!Number.isSafeInteger(value) || value < 1) return 1
    return Math.min(value, MAX_READ_COUNT)
  }

  /** 等待窗口的合法化：整数、1..30000ms，默认 10000ms。 */
  function clampWaitMs(value) {
    if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_WAIT_MS
    return Math.min(value, MAX_WAIT_MS)
  }

  /**
   * 从**当前会话游标**起增量读取命令输出，最多读 `readCount` 次。
   *
   * 用会话自己的游标（`record.cursor`）而不是另起一个：命令的输出本来就该被这位
   * 调用方消费掉，复制一份会造成"同一段输出既进 here 又留在 ring 里"的重复语义。
   * 每次都复用同一个 reader 预算（`maxOutputChars`），因此字符串长度有界。
   *
   * @param {object} record
   * @param {number} readCount
   */
  function readCommandOutput(record, readCount) {
    const parts = []
    let reads = 0
    let lossy = false
    let truncated = false
    let nextCursor = record.cursor?.offset ?? 0
    for (let i = 0; i < readCount; i += 1) {
      const chunk = read(record.pump, record.cursor, { budgetChars: config.maxOutputChars })
      reads += 1
      nextCursor = chunk.nextOffset
      if (chunk.lossy === true) lossy = true
      if (chunk.truncated === true) truncated = true
      if (typeof chunk.text === 'string' && chunk.text.length > 0) parts.push(chunk.text)
      // 没有更多可读数据就停，避免空转读取
      if (chunk.text.length === 0 && chunk.truncated !== true) break
    }
    return { text: parts.join(''), reads, lossy, truncated, nextCursor }
  }

  async function toolExec(owner, args) {
    if (owner === undefined) throw new Error('terminal_exec requires an owning agent session')
    // 给了 sessionId = 对既有会话续签（不是新建）。两条路径共用一个工具名，
    // 因为模型的心智模型是"执行一条命令"，不是"先建会话再发命令"。
    const existing = typeof args?.sessionId === 'string' ? args.sessionId.trim() : ''
    if (existing !== '') return toolExecExisting(owner, args, existing)
    const command = typeof args?.command === 'string' ? args.command : ''
    if (command.trim().length === 0) throw new Error('terminal_exec: command must be a non-empty string')

    // ⓪ 危险命令前置提醒/拦截。
    //
    // 放在**预留之前**：被拒绝的命令不该占用容量、不该起 shell、也不该留下任何痕迹。
    // 措辞与定位见 lib/danger.mjs 的文件头——它是减速带，不是安全边界；
    // 这点必须在错误信息里写清楚，否则会给人"没被拦就是安全"的错觉。
    //
    // `terminal_write` **不做这个检查**：它是交互输入通道（喂 REPL、回答确认、发控制字符），
    // 按 `docs/sandbox-design/…:105` 的定调"不承诺完整的逐条命令审批"，
    // 而且在那里拦会直接毁掉交互能力。
    if (args?.allowDangerous !== true) {
      const hit = detectDangerous(command)
      if (hit !== undefined) {
        log.warn('dangerous command refused', { dangerId: hit.id, excerpt: hit.excerpt })
        throw dangerousCommandError(command, hit)
      }
    }

    // ⓪b shell 路径覆盖（AI 发现的路径）。在校验与预留之前完成：
    // 被拒绝的路径不该占用容量、也不该起 shell。
    let sessionShellPath = config.shellPath
    const requestedShell = typeof args?.shellPath === 'string' ? args.shellPath.trim() : ''
    if (requestedShell !== '') {
      if (config.allowShellOverride !== true) {
        throw new Error('terminal_exec: shellPath override is disabled by the host config (allowShellOverride: false)')
      }
      const problem = validateShellPath({ shellPath: requestedShell, dialect: config.shellDialect })
      if (problem !== null) throw new Error(`terminal_exec: ${problem}`)
      sessionShellPath = requestedShell
      log.info('shell override requested by caller', { shellPath: requestedShell, flavor: shellFlavorOf(requestedShell, config.shellDialect) })
    }

    // ① 同步预留：容量 + 围栏 + 四个 Gate + 首条命令入队（序号 0）
    const record = admission.reserve(owner, {
      command,
      shellPath: sessionShellPath,
      shellFlavor: shellFlavorOf(sessionShellPath, config.shellDialect),
      label: typeof args.label === 'string' ? args.label : undefined,
      cwd: args.cwd,
      cols: Number.isSafeInteger(args.cols) ? args.cols : undefined,
      rows: Number.isSafeInteger(args.rows) ? args.rows : undefined,
    })

    // 按需送达（默认关）：只有调用方声明"我在等这条命令"才在命令结束时唤醒。
    // 存活的 agent 实例直接留在 record 上作为送达目标——它就是 `exec.agent`，
    // 是权威对象，不必再经 `ctx.get('agents').get(id)` 查一次。
    record.notifyOnExit = args?.notifyOnExit === true
    if (record.notifyOnExit) record.ownerAgent = owner

    // 有界等待窗口：默认 10s（覆盖大多数安装/构建的启动段），上限 30s。
    // 上限的意义：超时不是"命令失败"，而是"把控制权还给我"——真长任务该走
    // 超时返回 + 自己轮询/要通知，而不是把一次工具调用挂成几十秒。
    const waitMs = clampWaitMs(args?.waitMs)
    // 输出读次数：每次读 `maxOutputChars` 个字符。默认 1（够看小结），上限 20（防止
    // 一次工具调用把整个 ring 拖出来）。
    const readCount = clampReadCount(args?.readCount)

    // 首条命令在任何异步操作之前入队：启动超时也不会丢它。
    // `enqueueCommand` 负责包帧并记录帧标识（只调一次 wrapCommand）。
    record.commandQueue = createCommandQueue()
    enqueueCommand(record, command, 0)

    try {
      const policy = ctx.sandboxPolicy.resolve({ session: owner.session })
      const cwd = resolveCwd(args.cwd, policy, owner.session?.header?.cwd)
      log.info('terminal_exec', { session: record.id, label: args.label, policyMode: policy.mode, cwd })

      // ②a 能力矩阵：不支持的方言/模式组合**在 spawn 之前**拒绝。
      //
      // 为什么必须在启动前拦：受限 Windows 下的 Git Bash 会以 `exit code 127` 结束、
      // 且**没有任何输出**（Cygwin 需要命名管道，受限令牌拿不到），调用方只能对着
      // "127 + 零输出"猜。这里直接给出可操作的原因与替代方案。
      //
      // 这条判定原先只有测试在调（`assertShellSupported` 零生产调用点），等于白写。
      assertShellSupported({
        platform: process.platform,
        policyMode: policy.mode,
        dialect: config.shellDialect,
      })

      // ②b 选择派生方式，并在需要时经 confine。
      //
      // 后端在 confine **之前**决定：直连 node-pty 本来就不走 confine，
      // 它不是"confine 失败后的降级"，而是 platform/config 的选择。
      // 实际隔离等级一律记进 record.enforcement，由 terminal_state 如实上报。
      const shellArgv = [record.shellPath ?? config.shellPath, ...config.shellArgs]
      const directPty = config.ptyBackend === 'node-pty'
      let finalArgv = shellArgv
      if (directPty) {
        // Windows 唯一可行的路径：上游 spawnTerminal 经 ACL runner 派生 PTY 必失败
        // （runner 以自己的失败码 127 退出、stderr 不进 PTY）。详见 lib/pty-windows.mjs。
        //
        // 记下**未包装**的 argv：controller.begin 拿到的仍是 finalArgv（下面用），
        // 但直接派生时要交的是裸 shell argv —— 交错了会变成"用脚本去跑 runner"。
        record.ptyArgv = shellArgv
        record.enforcement = policy.mode === 'danger-full-access'
          ? 'unconfined'
          : (process.platform === 'win32' ? 'windows-pty-unconfined' : 'pty-unconfined')
        log.info('pty backend: node-pty (direct)', {
          session: record.id, argv: shellArgv, enforcement: record.enforcement,
        })
      } else if (policy.mode !== 'danger-full-access') {
        // 普通受限模式缺 sandbox provider 必须 fail-closed。
        // `sandbox` 是可选服务：既不在 inject 里，也不能直接读属性，只能经 ctx.get 取。
        const sandbox = optionalService(ctx, 'sandbox')
        if (sandbox === undefined || typeof sandbox.confine !== 'function') {
          throw new Error(`background-terminal: sandbox mode "${policy.mode}" requires a ctx.sandbox provider in the execution world; refusing to run the shell unconfined`)
        }
        const confined = await sandbox.confine(shellArgv, { ...policy, mode: policy.mode }, record.abort.signal)
        finalArgv = confined.argv
        record.enforcement = 'confined'
        // 这是唯一的权限边界，把它记下来：真机上 argv 是否正确往往是成败分界
        log.info('confined argv', { session: record.id, argv: finalArgv })
      } else {
        record.enforcement = 'unconfined'
        log.warn('sandbox bypassed: danger-full-access', { session: record.id, argv: finalArgv })
      }
      if (record.cancelRequested !== null) {
        await controller.finish(record, { origin: 'cancelled-before-spawn' })
        throw new Error(`terminal_exec was cancelled during confine: ${record.cancelRequested}`)
      }

      // ③ 同步注册 job（run 同步返回 hooks，只观察 outcomeGate）
      record.jobId = ctx.jobs.start({
        kind: 'terminal',
        label: typeof args.label === 'string' && args.label.length > 0 ? args.label : command.slice(0, 80),
        owner: owner.id,
        outputLimitBytes: config.maxOutputChars,
        run: (handle) => {
          record.jobHandle = handle
          const done = record.outcomeGate.promise
          done.catch(() => {})
          return { done, cancel: (reason) => controller.cancel(record, reason) }
        },
      })

      // ④ 唯一一次启动
      // 先落证据：confine 之后的 argv 才是真机上要核对的那一份，失败时它是唯一坐标
      diagnostics.recordSpec(record, {
        argv: finalArgv,
        cwd,
        cols: Number.isSafeInteger(args.cols) ? args.cols : config.cols,
        rows: Number.isSafeInteger(args.rows) ? args.rows : config.rows,
        graceMs: config.disposeGraceMs,
        confined: policy.mode !== 'danger-full-access',
        policyMode: policy.mode,
        shellDialect: config.shellDialect,
        provider: policy.mode === 'danger-full-access' ? 'none (danger-full-access)' : providerLabel(optionalService(ctx, 'sandbox')),
      })
      log.debug('spawn spec', {
        session: record.id,
        argv: finalArgv,
        cwd,
        cols: Number.isSafeInteger(args.cols) ? args.cols : config.cols,
        rows: Number.isSafeInteger(args.rows) ? args.rows : config.rows,
        graceMs: config.disposeGraceMs,
      })
      controller.begin(record, {
        argv: finalArgv,
        cwd,
        cols: Number.isSafeInteger(args.cols) ? args.cols : config.cols,
        rows: Number.isSafeInteger(args.rows) ? args.rows : config.rows,
      }).catch(() => {})

      // ⑤ 等发布；超时只决定返回值，不释放任何东西
      let published
      try {
        published = await raceStart(record, config.startTimeoutMs)
      } catch (startError) {
        // startGate 拒绝 = PTY 已被尝试创建但宿主/runner 明确失败（或 shell 服役前退出）。
        //
        // 依审阅 R001-02：这里**不能**再抛一个裸错误让调用方去猜，也不能伪装成 'starting'——
        // 必须返回明确的 `startup-failed` 状态 + 诊断证据（argv、退出码、耗时、127 提示）。
        // 只有 "PTY 从未尝试创建" 的 setup 失败（confine / jobs.start）才继续走外层 catch。
        const startup = classifyStartupOutcome(record)
        if (startup === 'startup-failed' && record.phase !== 'reserved') {
          log.error('startup failed', { sessionId: record.id, jobId: record.jobId, phase: record.phase, error: startError })
          return {
            sessionId: record.id,
            jobId: record.jobId,
            status: 'startup-failed',
            code: SANDBOX_PTY_START_FAILED,
            shell: { dialect: config.shellDialect, path: record.shellPath ?? config.shellPath, version: PLUGIN_VERSION },
            spawnArgv: finalArgv,
            confined: finalArgv !== shellArgv,
            detail: record.terminal?.detail ?? String(startError),
            diagnostics: diagnostics.render(record),
            // D1（P1-EXEC-1）：启动未就绪 ≠ 等待窗口到期。
            commandSettled: false,
            waitExpired: false,
            note: 'the host could not create the PTY; no retry and no unconfined fallback were attempted (the sandbox decision belongs to the upstream policy, not to this plugin).',
          }
        }
        throw startError
      }
      if (published === 'timeout') {
        log.warn('start timeout, returning "starting"', {
          session: record.id,
          jobId: record.jobId,
          startTimeoutMs: config.startTimeoutMs,
          note: 'capacity and the sandbox-mode fence remain held; the session keeps starting',
        })
        return {
          sessionId: record.id,
          jobId: record.jobId,
          status: 'starting',
          commandGeneration: record.commandGeneration ?? null,
          shell: { dialect: config.shellDialect, path: record.shellPath ?? config.shellPath, version: PLUGIN_VERSION },
          // 两条 starting 路径都回显 argv：真机诊断要看的就是它（confine 是否生效、参数是否传对）
          spawnArgv: finalArgv,
          confined: finalArgv !== shellArgv,
          // D1（P1-EXEC-1）：把「这次调用为什么返回」分开报告，别让调用方去猜 note。
          // 启动未就绪 ≠ 等待窗口到期，两者不得混为一谈。
          commandSettled: false,
          waitExpired: false,
          note: `the shell was not published within ${config.startTimeoutMs}ms; it is still starting in the background, capacity and the sandbox-mode fence remain held. Continue with terminal_read, or close it with terminal_signal close: true.`,
        }
      }

      const banner = read(record.pump, record.cursor, { budgetChars: config.maxOutputChars })
      if (record.ready !== true && (await settledFast(record))) {
        // 已发布但 shell 在观察窗内就死了（未就绪）：宿主的 PTY 创建被明确拒绝。
        //
        // 真机证据：`terminal_exec` 曾返回 `starting`，而 job 同一毫秒就报
        // `shell exited during startup (exit code 127)` —— 调用方必须读第二次才知道失败，
        // 这正是审阅 R001-02 要求消灭的形态。发布 ≠ 服役，先给它一个短窗落定。
        log.error('startup failed after publish', {
          sessionId: record.id, jobId: record.jobId, phase: record.phase, exitCode: record.rawExit?.exitCode,
        })
        return {
          sessionId: record.id,
          jobId: record.jobId,
          status: 'startup-failed',
          commandGeneration: record.commandGeneration ?? null,
          code: SANDBOX_PTY_START_FAILED,
          shell: { dialect: config.shellDialect, path: record.shellPath ?? config.shellPath, version: PLUGIN_VERSION },
          spawnArgv: finalArgv,
          confined: finalArgv !== shellArgv,
          detail: record.terminal?.detail ?? 'the shell exited before signalling readiness',
          diagnostics: diagnostics.render(record),
          // D1（P1-EXEC-1）：把「这次调用为什么返回」分开报告，别让调用方去猜 note。
          // 启动未就绪 ≠ 等待窗口到期，两者不得混为一谈。
          commandSettled: false,
          waitExpired: false,
          note: 'the host could not create the PTY; no retry and no unconfined fallback were attempted.',
        }
      }
      if (record.ready !== true) {
        // 已发布但 shell 还没就绪：立刻返回，队列会在就绪后自动 flush。
        //
        // 这里回显 spawnArgv 是**诊断用**：真机上 PTY 起不来时只看得到
        // "starting → exit 127"，没有 argv 就无法判断 confine 是否生效、
        // 参数是否被正确传递。argv 是我们自己构造的，不含用户机密。
        log.warn('published but not ready yet', { session: record.id, phase: record.phase })
        return {
          sessionId: record.id,
          jobId: record.jobId,
          status: 'starting',
          commandGeneration: record.commandGeneration ?? null,
          shell: { dialect: config.shellDialect, path: record.shellPath ?? config.shellPath, version: PLUGIN_VERSION },
          spawnArgv: finalArgv,
          confined: finalArgv !== shellArgv,
          // D1（P1-EXEC-1）：把「这次调用为什么返回」分开报告，别让调用方去猜 note。
          // 启动未就绪 ≠ 等待窗口到期，两者不得混为一谈。
          commandSettled: false,
          waitExpired: false,
          note: 'the PTY is published but the shell has not signalled readiness yet; the queued first command will be written as soon as it does.',
        }
      }
      log.info('session running', { session: record.id, jobId: record.jobId, bannerChars: banner.text.length })

      // ⑥ 有界等待：命令在 `waitMs` 内结束就把成功/失败直接交回去；超时则把控制权还给
      // 调用方（会话照旧活着，可稍后 terminal_read / terminal_state 自己看，或换策略）。
      const settled = await awaitCommand(record, waitMs)
      if (settled === undefined) {
        const state = snapshotSession(record)
        log.info('command still running after wait', { session: record.id, waitMs, outputBytes: state.outputBytes })
        return {
          sessionId: record.id,
          jobId: record.jobId,
          status: 'running',
          commandGeneration: record.commandGeneration ?? null,
          // 不能硬编码 true：中断之后帧永不闭合，这个字面量会把调用方永久骗住。
          // 一律取快照字段，并同时带上"它此刻可不可信"（P0-INT-1）。
          commandRunning: state.commandRunning,
          commandStateTrustworthy: state.commandStateTrustworthy,
          interruptId: state.interrupt?.id ?? null,
          interruptState: state.interrupt?.state ?? null,
          shell: { dialect: config.shellDialect, path: record.shellPath ?? config.shellPath, version: PLUGIN_VERSION },
          banner: banner.text,
          bannerLossy: banner.lossy,
          bannerTruncated: banner.truncated,
          outputBytes: state.outputBytes,
          lastOutputAgoMs: state.lastOutputAgoMs,
          commandSettled: false,
          waitExpired: true,
          note: `the command did not finish within waitMs=${waitMs}; the session is still alive and the command keeps running. `
            + 'Check progress with terminal_state, read output with terminal_read, or interrupt with terminal_signal (SIGINT).',
        }
      }

      // 命令已结束：按 `readCount` 次增量读取把输出一并交回，省掉一次往返。
      const out = readCommandOutput(record, readCount)
      log.info('command finished within wait', {
        session: record.id, exitCode: settled.exitCode, readCount, chars: out.text.length,
      })
      return {
        sessionId: record.id,
        jobId: record.jobId,
        status: settled.exitCode === 0 ? 'completed' : 'failed',
        commandGeneration: record.commandGeneration ?? null,
        commandSettled: true,
        waitExpired: false,
        commandExitCode: settled.exitCode,
        shell: { dialect: config.shellDialect, path: record.shellPath ?? config.shellPath, version: PLUGIN_VERSION },
        banner: banner.text,
        bannerLossy: banner.lossy,
        bannerTruncated: banner.truncated,
        output: out.text,
        outputReads: out.reads,
        outputLossy: out.lossy,
        outputTruncated: out.truncated,
        outputNextCursor: out.nextCursor,
      }
    } catch (error) {
      // 只有 setup 阶段的失败会走到这里：那时还没有 PTY
      log.error('terminal_exec failed', { session: record.id, phase: record.phase, error })
      if (record.phase === 'reserved') {
        await controller.finish(record, { origin: 'setup-failed', error })
      }
      throw error
    }
  }

  /**
   * 对**已有会话**续签一条带帧命令（terminal_exec 的 sessionId 形态）。
   *
   * ## 为什么需要它
   *
   * 一个会话只签发一条命令时，「换一条命令」的唯一出路是新开 PTY——丢掉 cwd、导出的
   * 变量、REPL 里的上下文，还多占一份容量。官方那套（dsh-tool-terminal）用反复 send
   * 解决同一问题，代价是命令结束与否只能靠推断；这里保留帧，所以退出码仍是硬事实。
   *
   * ## 准入规则（两条，故意收得很紧）
   *
   *  1. 上一条帧已闭合 → 直接续签；
   *  2. 上一条帧没闭合 → 只有显式 `reset: true` 才续签。这条路径的代价是**放弃**上一条
   *     命令的退出码（典型来源：SIGINT 打断了整行，行尾那句打印结束标记的语句没执行）。
   *     `reset` 不是「帮我清理一下」，而是调用方明确说「那条命令的事实我不要了」。
   *
   * 帧标记每次签发都换 nonce，所以被放弃的旧帧即使迟到，也匹配不上新帧。
   *
   * @param {object} owner
   * @param {object} args
   * @param {string} sessionId
   */
  async function toolExecExisting(owner, args, sessionId) {
    if (typeof args?.shellPath === 'string' && args.shellPath.trim() !== '') {
      throw new Error('terminal_exec: shellPath is only accepted when opening a NEW session; an existing session keeps its shell')
    }
    const record = requireSession(admission, owner, sessionId)
    if (record.phase !== 'running' || record.ready !== true) {
      throw new Error(
        `terminal_exec: session ${JSON.stringify(sessionId)} cannot take a new command `
          + `(phase=${record.phase}, ready=${record.ready === true}). Open a new session instead.`,
      )
    }
    const command = typeof args?.command === 'string' ? args.command : ''
    if (command.trim().length === 0) throw new Error('terminal_exec: command must be a non-empty string')

    // 与新建会话那条路径同一道减速带（措辞与定位见 lib/danger.mjs 文件头）。
    if (args?.allowDangerous !== true) {
      const hit = detectDangerous(command)
      if (hit !== undefined) {
        log.warn('dangerous command refused', { dangerId: hit.id, excerpt: hit.excerpt })
        throw dangerousCommandError(command, hit)
      }
    }

    const stranded = record.pendingFrame !== undefined
    if (stranded && args?.reset !== true) {
      throw new Error(
        `terminal_exec: session ${JSON.stringify(sessionId)} still has an open command frame `
          + '(the previous command has not reported its exit). Pass reset: true to re-baseline '
          + `and accept losing that command's exit code, or open a new session.`,
      )
    }
    if (stranded) {
      // 显式重置：旧帧永远闭不上，这里放弃它的事实，并清掉等待者。
      log.warn('re-baselining a stranded command frame', {
        session: record.id, generation: record.commandGeneration ?? 0,
      })
      record.pendingFrame = undefined
      record.frameWindow = ''
      record.commandDone = undefined
    }

    // notifyOnExit 是**会话级**开关：省略 = 保持原值（不静默关掉之前开着的唤醒）。
    if (args?.notifyOnExit === true) {
      record.notifyOnExit = true
      record.ownerAgent = owner
    } else if (args?.notifyOnExit === false) {
      record.notifyOnExit = false
    }

    const waitMs = clampWaitMs(args?.waitMs)
    const readCount = clampReadCount(args?.readCount)
    enqueueCommand(record, command, record.commandGeneration ?? 0)
    const generation = record.commandGeneration
    await flushCommandQueue(record, 'writing framed command')

    const settled = await awaitCommand(record, waitMs)
    if (settled === undefined) {
      const state = snapshotSession(record)
      log.info('command still running after wait (re-sign)', {
        session: record.id, generation, waitMs, outputBytes: state.outputBytes,
      })
      return {
        sessionId: record.id,
        jobId: record.jobId,
        status: 'running',
        reused: true,
        commandGeneration: generation,
        commandRunning: state.commandRunning,
        commandStateTrustworthy: state.commandStateTrustworthy,
        interruptId: state.interrupt?.id ?? null,
        interruptState: state.interrupt?.state ?? null,
        shell: { dialect: config.shellDialect, path: record.shellPath ?? config.shellPath, version: PLUGIN_VERSION },
        outputBytes: state.outputBytes,
        lastOutputAgoMs: state.lastOutputAgoMs,
        commandSettled: false,
        waitExpired: true,
        note: `the command did not finish within waitMs=${waitMs}; the session is still alive and `
          + 'the command keeps running. Check progress with terminal_state, read output with terminal_read, or interrupt with terminal_signal (SIGINT).',
      }
    }

    const out = readCommandOutput(record, readCount)
    log.info('command finished within wait (re-sign)', {
      session: record.id, generation, exitCode: settled.exitCode, readCount, chars: out.text.length,
    })
    return {
      sessionId: record.id,
      jobId: record.jobId,
      status: settled.exitCode === 0 ? 'completed' : 'failed',
      reused: true,
      commandGeneration: generation,
      commandSettled: true,
      waitExpired: false,
      commandExitCode: settled.exitCode,
      shell: { dialect: config.shellDialect, path: record.shellPath ?? config.shellPath, version: PLUGIN_VERSION },
      output: out.text,
      outputReads: out.reads,
      outputLossy: out.lossy,
      outputTruncated: out.truncated,
      outputNextCursor: out.nextCursor,
    }
  }

  /**
   * 等 startGate 落定。startGate 的拒绝必须作为错误抛出，
   * 绝不能被伪装成 'starting'（否则 shell 一启动就崩会被报成"仍在启动"）。
   */
  function raceStart(record, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve('timeout'), timeoutMs)
      timer.unref?.()
      record.startGate.promise.then(
        () => {
          clearTimeout(timer)
          resolve('published')
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  /**
   * 发布后的短观察窗：如果在 `startupGraceMs` 内 shell 就死了且**从未就绪**，
   * 说明宿主拒绝了 PTY 创建，本次调用应当场返回 `startup-failed`。
   *
   * 为什么需要它：PTY 发布（startGate 落定）与 shell 猝死之间只差几毫秒，
   * 若只等 startGate，`terminal_exec` 会先返回 `starting`，调用方必须再读一次
   * 才能发现失败——审阅 R001-02 明确要求区分这两种状态。
   *
   * 判据用 `classifyStartupOutcome`，与 startGate 拒绝路径共用同一套事实位，
   * 不引入第二套判断。就绪（`served`）后立即返回 false：那是正常运行，不该多等。
   */
  async function settledFast(record) {
    const deadline = Date.now() + config.startupGraceMs
    while (Date.now() < deadline) {
      if (record.ready === true || record.served === true) return false
      if (classifyStartupOutcome(record) === 'startup-failed') return true
      await new Promise((r) => setTimeout(r, config.startupGraceMs > 50 ? 10 : 1))
    }
    return classifyStartupOutcome(record) === 'startup-failed'
  }

  // ── terminal_read ────────────────────────────────────────────────────────
  // 注意：以下工具实现都是 async。校验失败必须是 rejected Promise，
  // 不能同步 throw——否则错误会逃出调用方的 Promise 处理链（实测：
  // 同步 throw 不会被 assert.rejects 捕获）。
  async function toolRead(owner, args) {
    const record = requireSession(admission, owner, args?.sessionId)
    // pump.consume 要求 budgetChars 是正整数（否则抛 TypeError），这里统一收敛
    const budget =
      Number.isSafeInteger(args?.maxOutputChars) && args.maxOutputChars > 0
        ? args.maxOutputChars
        : config.maxOutputChars
    const waitMs = Math.min(Math.max(0, Number.isFinite(args?.waitMs) ? args.waitMs : 0), MAX_WAIT_MS)
    // P1-READ-1：peekTail 是**只读尾部快照**，必须抢在 waitMs 之前处理 ——
    // peek 不等待也不订阅（它读的是此刻已有的字节），给它等一次没有任何意义。
    const peekTail =
      Number.isSafeInteger(args?.peekTail) && args.peekTail > 0 ? args.peekTail : undefined

    const doRead = () => {
      // 没有 PTY 的会话（setup/spawn 失败）没有 pump。这里绝不能抛：
      // 最难排查的失败恰恰是这种——调用方要读的只是 terminal.detail 里的证据。
      if (record.pump === undefined) {
        return {
          text: '',
          nextCursor: 0,
          lossy: false,
          gapBefore: null,
          truncated: false,
          status: viewStatus(record),
          ...statusExtras(record),
          unreadBytes: unreadBytesOf(record, record.cursor),
          outputFinal: outputFinalOf(record),
        }
      }
      const result = read(record.pump, record.cursor, {
        budgetChars: budget,
        // 只有确认进程消失的终态才 final：cleanup-failed 的进程可能仍在跑
        final: FLUSH_PHASES.has(record.phase),
      })
      return {
        text: result.text,
        nextCursor: result.nextOffset,
        lossy: result.lossy,
        gapBefore: result.gapBefore ?? null,
        truncated: result.truncated,
        status: viewStatus(record),
        ...statusExtras(record),
        unreadBytes: unreadBytesOf(record, record.cursor),
        outputFinal: outputFinalOf(record),
      }
    }

    /**
     * 只读尾部快照（P1-READ-1）。
     *
     * 用 `pump.peek`：它天生不推进任何游标，所以模型侧的增量游标分毫不动 ——
     * 调用方可以先看结尾，再照常从头读，审计证据一点不丢。
     * 这也正是**不能靠把游标挪到末尾来读尾**的原因：那会真的把中间那段消费掉。
     */
    const doPeekTail = (chars) => {
      const status = viewStatus(record)
      if (record.pump === undefined) {
        return {
          text: '', nextCursor: record.cursor?.offset ?? 0, lossy: false, gapBefore: null,
          truncated: false, tail: null, peek: true, status, ...statusExtras(record),
          unreadBytes: unreadBytesOf(record, record.cursor),
          outputFinal: outputFinalOf(record),
        }
      }
      // 取不到总量（合成/假 pump）时退化为"从最早可用处取"，绝不抛：
      // 读尾是只读能力，读不到就如实少给，不该把一次读取变成异常。
      const rawTotal = record.pump.totalBytes?.()
      const total = Number.isSafeInteger(rawTotal) && rawTotal >= 0 ? rawTotal : undefined
      const from = total === undefined ? 0 : Math.max(0, total - chars)
      const snap = record.pump.peek(from, chars)
      return {
        text: snap.text,
        // 游标**原样**返回：它就是"什么都没被消费"的证据。
        nextCursor: record.cursor?.offset ?? 0,
        lossy: snap.lossy,
        gapBefore: snap.lossy ? Math.max(0, snap.fromOffset - from) : null,
        truncated: snap.truncated,
        tail: {
          fromOffset: snap.fromOffset,
          toOffset: snap.toOffset,
          lossy: snap.lossy,
          truncated: snap.truncated,
          totalBytes: snap.totalBytes,
        },
        peek: true,
        status,
        ...statusExtras(record),
        unreadBytes: unreadBytesOf(record, record.cursor),
        outputFinal: outputFinalOf(record),
      }
    }

    if (peekTail !== undefined) return doPeekTail(peekTail)
    if (waitMs === 0) return doRead()
    // 先看**已有未读数据**再决定是否等待。
    //
    // 不检查的后果实测很糟：缓冲区里明明有未读输出，`waitMs=30000` 会白等满 30 秒
    // 才返回——而 `attachSink` 只对**注册之后**到达的数据触发回调，已有数据不会唤醒它
    // （探针实测：挂 sink 后回调计数为 0，追加新数据才变成 1）。
    // 同理，输出流已结束（`outputEnded`）也不会再有新数据，等待同样无意义。
    //
    // 说明：这一处与 `waitForData` 里的"注册后复查"**判定相同**，因此没有独立的
    // 判别力（去掉它、只留复查，read-wait 的 R1 仍然通过——已实测）。保留它是为了
    // 在常见路径上不白挂一次 sink，并让意图直接可读。
    if (hasImmediateRead(record)) {
      // 有未读数据/已 EOF/已落定 → 立即返回，但**同样要报唤醒原因**：
      // 只在这里裸调 doRead() 会让 wakeReason 缺失，调用方就无法区分
      // "读到的是已有数据"与"这次真的等到了新数据"（前者不代表任务有进展）。
      const reason = record.outputEnded === true
        ? 'output-ended'
        : FLUSH_PHASES.has(record.phase) ? 'state-change' : 'already-readable'
      return { ...doRead(), wakeReason: reason }
    }
    const wakeReason = await waitForData(record, waitMs)
    return { ...doRead(), wakeReason }
  }

  /**
   * 是否应当**立即读取**而不进入等待。
   *
   * 三种情况：
   *  1. 有未读数据（`cursor` 落后于 ring 的累计字节）——直接返回，不必等；
   *  2. 输出流已结束——不会再有新数据，等待只会白等到超时；
   *  3. 会话已落定——终态之后没有东西会再来唤醒。
   *
   * 注意"未读"用 `totalBytes`（累计写入）而非可解码字节数判断：多字节字符跨块时
   * `consume` 会留下不完整的尾部不消费，此时 `cursor` 仍落后，属于"有数据"。
   */
  function hasImmediateRead(record) {
    if (record.pump === undefined) return true // 无 PTY 的失败会话：直接读 terminal.detail
    if (record.outputEnded === true) return true
    if (FLUSH_PHASES.has(record.phase)) return true
    const total = record.pump.totalBytes?.()
    const offset = record.cursor?.offset
    if (typeof total === 'number' && typeof offset === 'number') return offset < total
    return false
  }

  /**
   * 阻塞直到有**新**输出、会话落定、或 waitMs 到期。等待期间不推进游标。
   *
   * @returns {Promise<'data'|'output-ended'|'state-change'|'timeout'|'already-readable'>}
   *   唤醒原因。调用方（或模型）据此区分"真的有新数据"与"只是等到超时"——
   *   后者不代表任务有进展。这一字段是协议扩展，见
   *   `docs/terminal-notifications/OUTPUT_EVENTS_AND_LLM_WAKEUP.md` §6。
   *
   * 订阅与检查之间存在竞态：数据可能在 `hasImmediateRead` 判定为"无未读"**之后**、
   * `attachSink` 注册**之前**到达，而 `attachSink` 不为已存在的数据触发回调。
   * 因此注册**之后立即复查**一次，封闭这个窗口（验收矩阵"检查与订阅之间产生输出"）。
   */
  function waitForData(record, waitMs) {
    return new Promise((resolve) => {
      let settled = false
      let reason = 'timeout'
      let attached
      let timer
      const finish = () => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        attached?.detach?.()
        resolve(reason)
      }
      const sink = {
        write: () => {
          reason = 'data'
          finish()
        },
        end: () => {
          reason = 'output-ended'
          finish()
        },
      }
      attached = record.pump?.attachSink(sink)
      if (attached === undefined || attached === null) {
        reason = 'already-readable'
        finish()
        return
      }
      // 注册后复查。
      //
      // **更正**：这里原先注释为"拦截检查之后、注册之前到达的数据"（即竞态防护）。
      // 独立审阅实测证伪了这个说法——从判定到 `attachSink` 全程同步，且 `attachSink`
      // 没有回放、没有副作用（探针：挂 sink 后回调计数为 0，追加新数据才为 1），
      // 那个窗口并不存在。它与 `toolRead` 里订阅前那处判定**谓词相同、行为等价**。
      //
      // 保留两处是冗余防御：前置让常见路径不白挂一次 sink，这处兜住前置被去掉的情形。
      // 单独移除任意一处都不会让任何用例变红（两处互为兜底），所以**不要**把这条
      // 复查当成有独立覆盖的竞态防护来依赖。
      if (hasImmediateRead(record)) {
        reason = record.outputEnded === true ? 'output-ended' : 'already-readable'
        finish()
        return
      }
      timer = setTimeout(finish, waitMs)
      timer.unref?.()
      // 会话在此期间落定也要醒（否则最坏要等满 waitMs）。
      //
      // 关于监听器累积（文档 §6 提示"对长期不落定的 Promise 每次挂 `.then`
      // 可能积累等待回调，宜使用可解绑的状态订阅"）：这里无法解绑（Promise 没有
      // 取消），但**实际不会累积**——只有走到这一行才会挂，而上面两处判定已经把
      // "已落定/已有数据/已 EOF"的情形全部提前返回了；会话落定后后续读取不会再等。
      // 残余窗口只有"两次同步判定与这次挂载之间"的微秒级竞态，代价是落定后多留
      // 一个已失效的回调，由 finish 的 settled 守卫保证它不产生任何行为。
      if (!FLUSH_PHASES.has(record.phase)) {
        record.outcomeGate.promise.then(
          () => {
            reason = 'state-change'
            finish()
          },
          () => {
            reason = 'state-change'
            finish()
          },
        )
      } else {
        reason = 'state-change'
        finish()
      }
    })
  }

  function viewStatus(record) {
    if (record.phase === 'cleanup-failed') return 'cleanup-failed'
    if (TERMINAL_PHASES.has(record.phase)) return record.phase
    if (record.phase === 'reserved' || record.phase === 'spawning') return 'starting'
    if (record.ready !== true) return 'starting'
    return record.phase === 'stopping' ? 'stopping' : 'running'
  }

  function statusExtras(record) {
    const extras = {}
    const terminal = record.terminal
    if (terminal?.exitCode !== undefined && terminal?.exitCode !== null) extras.exitCode = terminal.exitCode
    if (terminal?.signal !== undefined && terminal?.signal !== null) extras.signal = terminal.signal
    if (terminal?.detail !== undefined) extras.detail = terminal.detail
    return extras
  }

  // ── terminal_write ───────────────────────────────────────────────────────
  async function toolWrite(owner, args) {
    const record = requireSession(admission, owner, args?.sessionId)
    const data = typeof args?.data === 'string' ? args.data : ''
    const newline = args?.newline !== false

    const bytes = Buffer.byteLength(data, 'utf8')
    if (bytes > config.maxInputBytes) {
      throw inputError(
        INPUT_ERRORS.INPUT_TOO_LARGE,
        `input is ${bytes} bytes; the per-call limit is ${config.maxInputBytes} (nothing was accepted)`,
      )
    }
    if (record.phase === 'stopping' || TERMINAL_PHASES.has(record.phase) || record.phase === 'cleanup-failed') {
      throw inputError(
        INPUT_ERRORS.SESSION_NOT_WRITABLE,
        `terminal session ${record.id} is ${record.phase}; it no longer accepts input`,
      )
    }

    const text = newline ? `${data}\r` : data
    const textBytes = Buffer.byteLength(text, 'utf8')
    const pendingBytes = record.pendingWrites.reduce((n, e) => n + e.bytes, 0)
    if (record.pendingWrites.length >= config.maxPendingWriteCount || pendingBytes + textBytes > config.maxPendingWriteBytes) {
      throw inputError(
        INPUT_ERRORS.INPUT_QUEUE_FULL,
        `write queue for ${record.id} is full (${config.maxPendingWriteCount} entries / ${config.maxPendingWriteBytes} bytes); nothing was accepted`,
      )
    }

    const status = viewStatus(record)
    if (record.ready === true && record.handle !== undefined) {
      record.handle
        .write(text)
        .then(() => {}, (error) => warn(`background-terminal: ${record.id} write failed: ${String(error)}`))
      return { accepted: true, written: true, queued: false, status }
    }
    record.pendingWrites.push({ text, bytes: textBytes })
    return { accepted: true, written: false, queued: true, status }
  }

  // ── terminal_signal ──────────────────────────────────────────────────────
  async function toolSignal(owner, args) {
    const record = requireSession(admission, owner, args?.sessionId)
    const reason = typeof args?.reason === 'string' ? args.reason : undefined
    const close = args?.close === true
    const signal = args?.signal ?? 'SIGINT'

    if (!close && !ALLOWED_SIGNALS.has(signal)) {
      throw new Error(`unknown signal ${JSON.stringify(signal)}; allowed: SIGINT, SIGTERM, SIGKILL, or close: true`)
    }

    if (close || signal === 'SIGKILL') {
      await controller.cancel(record, reason ?? (close ? 'closed by request' : 'SIGKILL'))
      return {
        delivered: close ? 'session-close' : 'SIGKILL',
        target: 'session',
        status: viewStatus(record),
        ...statusExtras(record),
      }
    }

    if (record.ready !== true || record.handle === undefined) {
      if (record.pendingSignals.length >= config.maxPendingSignalCount) {
        throw inputError(
          INPUT_ERRORS.INPUT_QUEUE_FULL,
          `signal queue for ${record.id} is full (${config.maxPendingSignalCount} entries); nothing was accepted`,
        )
      }
      record.pendingSignals.push({ signal, reason })
      return { delivered: signal, target: 'foreground-process-group', status: viewStatus(record), queued: true }
    }

    // 前台信号：不关会话。底层错误原样透传（不吞、不转成会话关闭）。
    //
    // 中断事实**先落地再送货**：无论送货成败，调用方稍后都能从 terminal_state 读到
    // "这次中断发生过、它处于什么状态"，投影层据此把 commandStateTrustworthy 标成 false
    // —— 因为 commandRunning 在中断路径上会永久停在 true（帧闭不上）。
    beginInterrupt(record)
    try {
      await record.handle.signalForeground(signal)
    } catch (error) {
      failInterrupt(record, error)
      throw error
    }
    return {
      delivered: signal,
      target: 'foreground-process-group',
      status: viewStatus(record),
      ...statusExtras(record),
      interruptId: record.interrupt?.id ?? null,
      interruptState: record.interrupt?.state ?? null,
      // 失败必须当场给得出理由：state="failed" 却没有原因等于没说。
      interruptDetail: record.interrupt?.detail ?? null,
    }
  }

  // ── terminal_state ───────────────────────────────────────────────────────
  /**
   * 一次调用读到会话的完整状态（只读投影，见 lib/session-state.mjs）。
   *
   * - 传 `sessionId`：返回该会话的快照对象；
   * - 不传：返回该 agent **自己的**全部会话快照（活动 + 保留期），这是
   *   "我还有个构建在跑"的自查能力。
   *
   * 语义纪律：不修改记录、不触发状态转换、不创建也不等待任何东西；
   * 未知 `sessionId` 复用既有 "unknown terminal session" 错误语义（不静默返回空）。
   */
  async function toolState(owner, args) {
    const rawId = args?.sessionId
    if (rawId === undefined || rawId === null || rawId === '') {
      return { sessions: snapshotSessions(admission.listForOwner(owner)) }
    }
    const record = requireSession(admission, owner, rawId)
    const snapshot = snapshotSession(record)
    // 失败的会话把**完整启动证据链**挂在这里，按需取。
    //
    // 为什么通知里看不到它：宿主用 **jobs 注册表里的** `detail` 渲染完成通知
    // （`dsh-tool-jobs` 的 `statusLine` / `fitCompletionNotice`，且**不会截断**——
    // 截断预算是 `job.outputLimitBytes`，本插件填的是 16000）。而那份 detail 来自
    // `settleJobs(record, outcome)` 的 `outcome.detail`，**不是** `record.terminal.detail`。
    //
    // 所以两份字符串职责不同，务必分清：
    //   · `record.terminal.detail` —— 给 `terminal_read` / 本工具，**带**完整诊断；
    //   · jobs 的 detail           —— 给通知与 `job_list`，**只放一句话事实**。
    // 把带诊断的那份交给 `settleJobs` 就会把一行状态撑成十几行长文
    // （`cleanup-failed` 路径曾经如此，已由 task-13 修正）。
    if (snapshot.phase === 'failed' || snapshot.phase === 'cleanup-failed') {
      try {
        const text = diagnostics.render(record, {
          exitCode: snapshot.exitCode,
          outputTail: undefined,
        })
        if (typeof text === 'string' && text.length > 0) snapshot.diagnostics = text
      } catch {
        // 诊断渲染失败不影响快照本身
      }
    }
    return snapshot
  }

  return {
    config,
    admission,
    fence,
    controller,
    diagnostics,
    lifecycle,
    publishSession,
    maybeReady,
    markReady,
    shutdown,
    toolExec,
    toolRead,
    toolWrite,
    toolSignal,
    toolState,
  }
}

/** 工具定义的公共外形（与 custom-bash.mjs 同形态的普通对象）。 */
function defineTool(name, { description, parameters, execute }) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute,
    presentCall: (args) => ({ card: 'terminal', title: `${name} ${args.sessionId ?? args.command ?? ''}`.trim() }),
  }
}

/** Cordis 插件入口。 */
export function apply(ctx, rawConfig = {}) {
  const runtime = createRuntime(ctx, rawConfig)
  const disposers = []

  // 技能随包发布：挂载时注册成 runtime skill，**装插件即得技能**。
  // 不写任何本机绝对路径，也不要求用户把文件复制进 ~/.dsh/skills
  // （同一层里 runtime 优先于 user，旧的同名副本会被这份覆盖）。
  // `skills` 是可选服务：组合里没有它时静默跳过，四个终端工具照常可用。
  const skillService = optionalService(ctx, 'skills')
  if (skillService !== undefined && typeof skillService.register === 'function') {
    try {
      const bundled = loadBundledSkill()
      disposers.push(skillService.register({ ...bundled, source: 'plugin:dsh-background-terminal' }))
    } catch (error) {
      const message = `background-terminal: bundled skill not registered: ${error instanceof Error ? error.message : String(error)}`
      const logger = optionalService(ctx, 'logger')
      if (logger !== undefined && typeof logger.warn === 'function') logger.warn(message)
      else console.warn(message)
    }
  }

  disposers.push(
    ctx.tools.register(
      defineTool('terminal_exec', {
        description: [
          'Start a persistent interactive shell in the session workspace and submit the first command to it.',
          'Choose this when the command outlives this tool call: a dev server, watch mode, a debugger, an installer that prompts, or anything you may need to interrupt and then keep using.',
          'Do NOT use it for second-long commands that need an exit code (use bash/pwsh), and do NOT start a new session when an existing one is waiting for input on stdin (use terminal_write on that session).',
          'The shell is confined once at startup under the session sandbox mode; the sandbox-mode fence is held for the whole session.',
          'Bounded wait: this call waits up to waitMs (default 10000, max 30000) for the first command to finish.',
          '  - finished in time -> returns status completed|failed with commandExitCode and the captured output; that output was read out of the ring, so it is CONSUMED — keep it. If you drop it, terminal_read with peekTail still recovers it while it is inside the retention window;',
          '  - still running    -> returns status running with the sessionId, and the session (and the command) keep going. This return also carries commandRunning, commandStateTrustworthy, interruptId and interruptState: if commandStateTrustworthy is false, do NOT act on commandRunning (see terminal_signal for why an interrupt can freeze it).',
          'EVERY return also carries two booleans that say WHY this call came back: commandSettled (the command framing actually closed, so commandExitCode is real — true regardless of whether the exit code is 0) and waitExpired (the waitMs window ran out while the command kept going). They are mutually exclusive, and a session that is still starting reports false/false: the startup gate not being ready is NOT the wait window expiring. status describes the session/command lifecycle; these two describe why THIS call returned.',
          'Two shapes of call:',
          '  - without sessionId: opens a persistent shell and submits the first command to it (the shell survives the call);',
          '  - with sessionId: re-signs a NEW framed command into that existing shell, so cwd, exported variables and REPL state are kept. The previous command must have finished; if its frame never closed (typically after SIGINT) pass reset: true — that discards the previous exit code instead of recovering it.',
          'Command-level facts (commandRunning, commandStateTrustworthy, interruptId/interruptState, commandExitCode) always describe the LATEST framed command; every result carries commandGeneration so you can tell which command a fact belongs to.',
          'A timeout is NOT a failure. When it times out, decide for yourself: do other work and check later with terminal_state / terminal_read, or interrupt with terminal_signal (SIGINT).',
          'notifyOnExit (default false) additionally asks to be WOKEN when the command finishes, for when you hand off a long run and stop watching. Without it, nothing tells you the command ended — check the terminal yourself.',
          'When it finishes inside the wait window, the returned `output` holds only the first `readCount` increments (default 1), NOT necessarily the whole command output — and the read cursor has already advanced past what was returned. Continue with terminal_read (nothing is repeated) before concluding anything about the full output.',
        ].join('\n'),
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            command: { type: 'string', description: 'Command line written to the shell stdin (not passed as an argument).' },
            sessionId: {
              type: 'string',
              description: 'Re-sign a command into an EXISTING session instead of opening a new one. The previous command must have finished (its frame closed); otherwise pass reset: true.',
            },
            reset: {
              type: 'boolean',
              description: 'With sessionId: re-baseline a command frame that never closed (typically after SIGINT). The previous command\'s exit code is discarded, not recovered.',
            },
            label: { type: 'string', description: 'Short human label for the /jobs roster.' },
            cwd: { type: 'string', description: 'Working directory; must stay inside the sandbox workspace for confined modes.' },
            cols: { type: 'number' },
            rows: { type: 'number' },
            waitMs: {
              type: 'number',
              description: 'How long to wait for the command to finish before returning (default 10000, max 30000).',
            },
            readCount: {
              type: 'number',
              description: 'How many incremental reads of the output to include when the command finished (default 1, max 20). Each read is capped by maxOutputChars.',
            },
            notifyOnExit: {
              type: 'boolean',
              description: 'Wake me when this command finishes (default false). The wake carries the command exit code; read the output with terminal_read.',
            },
            shellPath: {
              type: 'string',
              description: 'Absolute path to the shell executable, for opening a NEW session only. Use it when a previous call failed with SHELL_NOT_FOUND: discover the path with the bash/pwsh tool (Get-Command pwsh / which bash) and retry. It must match the configured shellDialect (the dialect decides the command framing) and must exist; refused when allowShellOverride is false.',
            },
            allowDangerous: {
              type: 'boolean',
              description: 'Set true to run a command that the destructive-command guard refused. The guard is a speed bump against slips, NOT a security boundary; only override when you have read the command and really mean it.',
            },
          },
          required: ['command'],
        },
        async execute(args, exec) {
          return runtime.toolExec(exec.agent, args)
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool('terminal_read', {
        description: [
          'Read what this terminal session produced since your last read (incremental: nothing is repeated).',
          'waitMs > 0 blocks until new output arrives or the wait expires (max 30000). waitMs is NOT a command timeout and does not limit how long a command may run.',
          'Already-unread output returns immediately without waiting the full waitMs.',
          'wakeReason tells you WHY the read returned: data (new output), output-ended (the stream closed, no more output will come), already-readable (there was unread output before the wait), state-change (the session settled), timeout (nothing happened — this does NOT mean the command is stuck or finished).',
          'lossy means output was overwritten in the ring before you read it; gapBefore marks where the gap starts.',
          'truncated: true means THIS read stopped at maxOutputChars and more already-produced output is still unread — nothing was lost, call again to continue. truncated: false means you have consumed everything produced so far, which is NOT the same as the command having finished (more output can still arrive later).',
          'nextCursor is the ABSOLUTE byte offset of the read cursor after this read — not the length of this read. Read unreadBytes to learn what is left; do NOT subtract nextCursor from terminal_state.outputBytes — outputBytes is a session total and nextCursor is a position, so subtracting them is how callers get misled. Reading a large log means looping (read, check truncated, read again); raising maxOutputChars (default 16000) cuts the number of round trips, and peekTail gets you the end without looping.',
          'peekTail: N returns the LAST N characters of the buffered output as a READ-ONLY snapshot. It does NOT advance the incremental cursor — nextCursor comes back unchanged, which is the proof that nothing was consumed — so you can look at the end first and still read everything from the start afterwards. It ignores waitMs (it never waits or subscribes) and answers with a tail object plus peek: true. Never emulate a tail by moving the cursor: that really consumes the middle and destroys the audit trail. Precision note: N is applied internally as a BYTE budget while the returned budget counts CHARACTERS, so with multi-byte content (CJK and friends) you may get FEWER than N characters — it will never split a character, so the tail is always valid text. It also re-reads output you have already consumed, as long as that output is still inside the retention window: that is how you recover an inline output you dropped from an earlier terminal_exec, and since it never advances the cursor, looking costs you nothing.',
          'outputFinal: true means the output stream has ended AND the session lifecycle is terminal. Claim you have read everything only when outputFinal is true, lossy is false and unreadBytes is 0.',
        ].join('\n'),
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string' },
            maxOutputChars: { type: 'number', description: 'Maximum characters returned by THIS read (default 16000). It caps one read, not the whole log: a longer log comes back with truncated: true, and you call again to continue from nextCursor.' },
            peekTail: { type: 'number', description: 'Return the LAST N characters of the buffered output as a read-only snapshot WITHOUT advancing the incremental cursor (nextCursor comes back unchanged, which proves nothing was consumed). Ignores waitMs. Use it to see how a long task ended without draining the whole log first.' },
            waitMs: { type: 'number', description: 'Block up to this many ms for new output (0 = non-blocking, default).' },
          },
          required: ['sessionId'],
        },
        execute(args, exec) {
          return runtime.toolRead(exec.agent, args)
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool('terminal_write', {
        description: [
          'Write literal input to the terminal session stdin. Control bytes such as \\u0003 are allowed.',
          'Use this to answer a running prompt (y/n, password, REPL) instead of starting a new session.',
          'accepted means it entered the session write queue; it does NOT mean the foreground program consumed it.',
        ].join('\n'),
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string' },
            data: { type: 'string' },
            newline: { type: 'boolean', description: 'Append the protocol newline byte (default true). Appended exactly once.' },
          },
          required: ['sessionId', 'data'],
        },
        execute(args, exec) {
          return runtime.toolWrite(exec.agent, args)
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool('terminal_signal', {
        description: [
          'SIGINT (default) interrupts the foreground command and KEEPS the shell alive — the session stays usable, so you can write the next command into it.',
          'SIGTERM signals the foreground process group; the shell also stays alive.',
          'close: true (or SIGKILL) ends the whole session and releases its resources; this is also the retry path when a previous close reported cleanup-failed.',
          'The signal set is fixed; arbitrary OS signal strings are rejected.',
          'After SIGINT, the command-level state fields for that session become UNRELIABLE: commandRunning is derived from "the command framing never closed", and Ctrl+C aborts the whole input line — including the trailing statement that would have closed the frame — so it can stay true forever (even after the session is closed). terminal_state reports commandStateTrustworthy: false plus an interrupt object in exactly that situation; do not wait for those fields to flip. The same flag also covers the other way an open framing gets stranded — the session being killed while the framing is still open (close: true, or the shell dying). That is not an interrupt: read phase and interrupt to tell the two apart.',
          'The response carries interruptId, interruptState and interruptDetail (the detail carries the reason when the state is "failed"). "delivered" = the signal was written; it is NOT verified, and this implementation has no way to verify it. "interrupt-pending" = the session settled without any confirmation. "failed" = the signal could not be written. This implementation does NOT produce "interrupted": that state would require the session-side fact "the foreground process group is gone", which this plugin cannot obtain (it frames one command per session and has no probe channel) — so the unknown stays on the record instead of being faked. Verify the process tree and the port yourself when you need that fact. The same facts also appear in terminal_state as the interrupt object.',
          'This plugin can only ever produce the session-side fact; whether the target process tree died and whether the service port was released is OUTSIDE its view (interrupt.evidence.externalSide is always null). Verify those yourself before concluding that a service stopped.',
        ].join('\n'),
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string' },
            signal: { type: 'string', enum: ['SIGINT', 'SIGTERM', 'SIGKILL'] },
            close: { type: 'boolean' },
            reason: { type: 'string' },
          },
          required: ['sessionId'],
        },
        execute(args, exec) {
          return runtime.toolSignal(exec.agent, args)
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool('terminal_state', {
        description: [
          'Read the structured state of terminal sessions in ONE call — no need to infer progress from terminal_read text.',
          'With sessionId: returns that session\'s snapshot. Without it: returns every session owned by this agent (use this to check "do I still have a build running?").',
          'Fields, in the exact order the snapshot returns them: sessionId, jobId, phase, pid, elapsedMs (since the PTY was published), outputBytes, lastOutputAgoMs (null when nothing was output yet), ready, exitCode, commandRunning, lastCommandExitCode, lastCommandAgoMs, detail, pendingWrites, enforcement, lastCommandEndReason, interrupt, commandStateTrustworthy, unreadBytes, outputFinal.',
          'The interrupt object carries {id, state, requestedAt, deliveredAt, verifiedAt, evidence, detail} — read interrupt.detail for the reason when the state is "failed".\ncommandStateTrustworthy: false means the command-level fields (commandRunning, lastCommandExitCode) must NOT be used: commandRunning is derived from the framing still being open, and it can stay true forever. TWO situations produce it: (a) an interrupt whose outcome was never confirmed; (b) the session\'s own process is gone (phase exited/killed/failed) while the framing is still open. The flag means "do not use this value as evidence" — it never means "the command is confirmed stopped": a grandchild process detached by the command (a service started from the shell) could in principle still be alive. In both cases prefer the interrupt object, the phase, and your own external evidence (process list / service port). cleanup-failed does NOT count — there the process may still be alive, so a running command remains possible.',
          'lastCommandEndReason: "natural" when the last command closed its own framing. A command interrupted by SIGINT does not get a natural close — read the interrupt object instead. IMPORTANT boundary: "natural" only means the framing closed by ITSELF — this plugin CANNOT tell whether the command finished on its own or whether a human or the host made the process exit; both look identical from in here. Never read "natural" as "nobody intervened". The distinction the target design calls endedBy: human | host is NOT obtainable inside this plugin — it has to be reported by whoever performed the human action.',
          'A closed session stays listed for a while (settledRetainMs, default 5 minutes). A non-empty session list therefore does NOT mean a live leftover: judge cleanliness by phase ("killed" = closed and cleaned up).',
          'enforcement reports the ACTUAL isolation level and must not be read as "sandboxed by default": "confined" = the shell went through the sandbox runner; "windows-pty-unconfined" = the shell was spawned directly by the plugin and is NOT inside the ACL sandbox; "unconfined" = danger-full-access or no confinement evidence.',
          'Read-only: it never changes a session, never starts or stops anything, and never advances the terminal_read cursor.',
        ].join('\n'),
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string', description: 'Session to inspect; omit to list all sessions owned by this agent.' },
          },
        },
        execute(args, exec) {
          return runtime.toolState(exec.agent, args)
        },
      }),
    ),
  )

  ctx.effect?.(() => async () => {
    runtime.lifecycle.closed = true
    runtime.shutdown()
    runtime.fence.disposeAll()
    const closing = [...runtime.admission.allRecords()]
    for (const record of closing) {
      // 先挂起 Jobs 结算再关会话：宿主的 teardown 若先到，会给 job 打 cause: 'teardown'，
      // 通知因此被抑制；我们不抢先以 producer 身份结算，agent 就不会被"终端关了"惊醒一轮。
      record.deferSettlement = true
      await runtime.controller.cancel(record, 'plugin unloaded', { keepDeferred: true })
    }
    if (closing.length > 0) {
      const fallback = setTimeout(() => {
        for (const record of closing) runtime.controller.flushDeferred(record)
      }, TEARDOWN_SETTLE_FALLBACK_MS)
      fallback.unref?.()
    }
    for (const dispose of disposers.reverse()) {
      try {
        // ctx.tools.register 的返回不保证是函数；非函数时跳过，
        // 否则 `dispose?.()` 仍会抛 TypeError。
        if (typeof dispose === 'function') dispose()
      } catch {
        // 工具注销失败不应阻断 teardown
      }
    }
  }, 'background-terminal teardown')

  return runtime
}

export const name = 'background-terminal'
/**
 * 声明的服务依赖。Cordis 的 ctx 是代理：只有列在这里的服务能直接读，
 * 否则读取会抛 `cannot get property "…" without inject`。
 *
 * **`inject` 声明的是硬依赖，不是「可读白名单」**：列进来的服务若组合里没有，
 * 整个 entry 会停在 `pending (waiting for service: …)` 而永不激活。
 * 所以这里只列真正必需的服务；可选能力（`sandbox` / `logger`）一律经
 * `optionalService()` 或 `ctx.get()` 读，缺了不影响挂载：
 * 缺 `sandbox` 时受限模式在执行期 fail-closed，缺 `logger` 只是不打日志。
 */
export const inject = ['tools', 'subprocess', 'sandboxPolicy', 'sessionProjections', 'jobs']
