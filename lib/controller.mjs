/**
 * controller.mjs —— 会话生命周期状态机：唯一 begin、spawnSettled 屏障、单一 finish、可重试清理。
 *
 * 契约（FINAL.md §6.6-§6.10、lib/contract.mjs）：
 *   record 由 records.mjs 的 createRecord 建立，本模块只消费/写入下列字段：
 *     - 事实位：spawnAttempted / spawnFinished / ptyCreated / ptyExited
 *       （平铺在 record 上，或收在 record.facts 下——dispositionOf 只约束 FactBits 形状）
 *     - 四个 Gate：startGate / outcomeGate / spawnSettled / cleanupSettled
 *       （deferred 对象，含 promise/resolve/reject；spawnSettled 也接受裸 Promise）
 *     - phase / handle / session / jobId / abort / cancelRequested / terminal
 *     - 本模块的簿记字段：beginPromise、finishing、closeAttemptPromise、cleanupAttempts、
 *       cleanupRetryPromise、startGateSettled、jobDoneResolved、cleanupReleased、
 *       spawnError、rawExit、terminateError、doneObserved
 *
 *   deps（contract.mjs ControllerDeps）：
 *     spawnTerminal(spec)            唯一 spawn 入口
 *     terminateRecord(record, reason) 唯一 terminate 入口（本模块绝不直接调 handle.terminate）
 *     flushPump(record)              唯一 output 收尾入口（等 output end → flush ring；
 *                                    步骤 5「等 drain/EOF」与步骤 6「flush ring」都归它）
 *     admission.release / enterRetention、log、config、lifecycle
 *     onPublished(record, handle)    集成层建会话/挂泵/刷新首命令队列；本模块只调用它
 *
 *   begin(record, request)：request 是裸 argv 数组，或 {argv, cwd?, env?, cols?, rows?}
 *   （index.js 传后者；spec 里的值优先于 record.cwd/cols/rows，最后回落 deps.config）。
 *
 * 唯一入口纪律：本模块不调用 handle.write()、不消费 handle.output、不 import @deepseek-ai/*。
 *
 * 三个不变量（最容易翻车的三点）：
 *   1. begin() 记忆化，spawnTerminal 恰好一次。
 *   2. finish() 第一步必须 await spawnSettled；否则「取消先到、handle 后到」会提前释放容量。
 *   3. handle.done 的 resolve 与 reject 都进 markExited→finish，且收下 resolve 的退出码；
 *      每次清理重试都新建 attempt promise（finally 清掉自己的记忆化）。
 */

import { dispositionOf, isTerminalPhase } from './contract.mjs'

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30
const DEFAULT_GRACE_MS = 3000
const TERMINAL_TYPE = 'xterm-256color'

/** 稳定取错误原文（detail 要能带上 surviving pid 之类的原文）。 */
function message(error) {
  if (error === undefined || error === null) return 'unknown error'
  if (typeof error === 'string') return error
  return error.message !== undefined && error.message !== '' ? String(error.message) : String(error)
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => {}) // Gate 可能无人 await；这里先吞掉未处理拒绝
  return { promise, resolve, reject }
}

function cancelledError(reason) {
  const error = new Error(`session cancelled: ${reason ?? 'cancelled'}`)
  error.name = 'CancelledError'
  return error
}

/**
 * @param {import('./contract.mjs').ControllerDeps} deps
 * @returns {{begin:(record:object, request:string[]|object)=>Promise<void>,
 *            cancel:(record:object, reason?:string)=>Promise<void>,
 *            finish:(record:object, opts?:object)=>Promise<void>,
 *            attempts:(record:object)=>number}}
 */
export function createController(deps) {
  if (deps === null || typeof deps !== 'object') throw new Error('createController: deps is required')
  if (typeof deps.spawnTerminal !== 'function') throw new Error('createController: deps.spawnTerminal is required')
  if (typeof deps.terminateRecord !== 'function') throw new Error('createController: deps.terminateRecord is required')
  if (typeof deps.flushPump !== 'function') throw new Error('createController: deps.flushPump is required')

  const admission = deps.admission ?? {}
  const config = deps.config ?? {}

  function log(text) {
    try {
      deps.log?.(`[bgterm] ${text}`)
    } catch {
      // 日志失败不得影响收口
    }
  }

  /**
   * 结构化日志。集成层传进来的 `logEvent(level, ...args)`；
   * 未提供时退回 `log(text)`，controller 单独跑测试时也能工作。
   */
  function logEvent(level, event, detail) {
    try {
      if (typeof deps.logEvent === 'function') deps.logEvent(level, event, detail)
      else log(`${event} ${detail === undefined ? '' : JSON.stringify(detail)}`)
    } catch {
      // 日志失败不得影响收口
    }
  }

  /**
   * 已捕获输出的尾部，用于失败诊断。
   *
   * "shell 起来就挂、零输出"这类真机问题上，这段文本往往是**唯一**线索
   * （沙箱 runner 的 `windows-acl-run: …` 就写在 PTY 输出里）。
   * 只读、不改游标：模型侧的读取不受影响。
   */
  function capturedTail(record, limit = 400) {
    try {
      const pump = record?.pump
      if (pump === undefined || typeof pump.consume !== 'function') return undefined
      const result = pump.consume(0, limit, {})
      const text = result?.text ?? ''
      return text.length > 0 ? text : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 已捕获输出的**真尾部**（最多 limit 字符）。
   *
   * `capturedTail()` 从 ring 起点消费，拿到的是**开头**；而崩溃现场最需要读的是
   * 最后几行（runner 的报错就写在末尾）。这里按字节定位尾部窗口——留 8 倍余量
   * 覆盖多字节字符，保证窗口里至少有 limit 个字符——再从结果里取最后 limit 个。
   * 窗口起点可能落在多字节字符中间，解码器会产出恰好一个替换字符，就地去掉。
   */
  function capturedEnd(record, limit = 300) {
    try {
      const pump = record?.pump
      if (pump === undefined || typeof pump.consume !== 'function') return undefined
      const total = typeof pump.totalBytes === 'function' ? pump.totalBytes() : 0
      if (!Number.isFinite(total) || total <= 0) return undefined
      const window = Math.min(total, Math.max(limit * 8, 64))
      // 预算是**字符**数、窗口是**字节**数：字符数 ≤ 字节数，所以用窗口字节数当预算
      // 一定能把窗口里的全部字符取回来（否则预算会先把尾部截掉）。
      const result = pump.consume(Math.max(0, total - window), window, {})
      let text = result?.text ?? ''
      if (text.startsWith('\uFFFD')) text = text.slice(1)
      if (text.length === 0) return undefined
      return text.length > limit ? text.slice(text.length - limit) : text
    } catch {
      return undefined
    }
  }

  /**
   * 失败诊断（lib/diagnostic.mjs，deps.diagnostics 可选）：只观测、只描述。
   *
   * 这里吞异常不是图省事：诊断跑在**启动/失败路径**上，它自己崩掉会改判 spawn 成败、
   * 或者让失败详情丢失——那是"诊断掩盖真故障"的经典形态。
   */
  function recordSpawnOutcome(record, outcome) {
    try {
      deps.diagnostics?.recordSpawn?.(record, outcome)
    } catch {
      // 诊断失败不得影响生命周期
    }
  }

  /**
   * 失败视图尾部追加启动证据链（argv / pid 或错误 / 退出事实 / 耗时 / 127 定向提示），
   * 让 `terminal_read` 的 detail 直接可读。
   *
   * 只在失败视图上附加：成功路径保持原样，正常输出不被污染。
   */
  function withDiagnostics(record, view, failed) {
    if (failed !== true) return view
    try {
      const text = deps.diagnostics?.render?.(record, {
        exitCode: view.exitCode,
        signal: view.signal,
        outputTail: capturedEnd(record, 300),
      })
      if (typeof text !== 'string' || text.length === 0) return view
      return { exitCode: view.exitCode, signal: view.signal, detail: `${view.detail}\n${text}` }
    } catch {
      return view
    }
  }

  /**
   * logEvent 的关联字段（审阅 R001-03 / C-2）：`sessionId` / `jobId` / `phase` 三件套，
   * 让日志能按会话或 job 直接查，而不是从自由文本里抠 id。
   */
  function logDetail(record, extra = {}) {
    return { sessionId: record.id, jobId: record.jobId, phase: record.phase, ...extra }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Gate / 事实位访问器
  // ───────────────────────────────────────────────────────────────────────────

  function factsOf(record) {
    return record.facts ?? record
  }

  function gatePromise(gate) {
    if (gate === undefined || gate === null) return Promise.resolve()
    if (typeof gate.then === 'function') return gate
    return gate.promise ?? Promise.resolve()
  }

  function resolveGate(gate, value) {
    if (gate !== undefined && gate !== null && typeof gate.resolve === 'function') gate.resolve(value)
  }

  function rejectGate(gate, error) {
    if (gate !== undefined && gate !== null && typeof gate.reject === 'function') gate.reject(error)
  }

  /** startGate 在所有路径都落定，且只落定一次。 */
  function resolveStartGate(record, value) {
    if (record.startGateSettled === true) return
    record.startGateSettled = true
    resolveGate(record.startGate, value)
  }

  function rejectStartGate(record, error) {
    if (record.startGateSettled === true) return
    record.startGateSettled = true
    rejectGate(record.startGate, error)
  }

  /** spawnSettled 屏障：优先复用 records.mjs 建的 deferred，否则自建并挂回 record。 */
  function takeSpawnBarrier(record) {
    const gate = record.spawnSettled
    if (gate !== undefined && gate !== null && typeof gate.resolve === 'function' && gate.promise !== undefined) {
      return gate
    }
    const created = deferred()
    record.spawnSettled = created
    return created
  }

  async function awaitSpawnSettled(record) {
    const facts = factsOf(record)
    if (!facts.spawnAttempted || facts.spawnFinished) return
    await gatePromise(record.spawnSettled)
  }

  function isCancelled(record) {
    return record.cancelRequested !== null && record.cancelRequested !== undefined
  }

  function hasDone(record) {
    const done = record.handle?.done
    return done !== undefined && done !== null && typeof done.then === 'function'
  }

  // ───────────────────────────────────────────────────────────────────────────
  // spawn
  // ───────────────────────────────────────────────────────────────────────────

  function spawnSpec(record, request) {
    // begin() 接受两种调用形态：裸 argv 数组，或 index.js 传的 {argv,cwd,cols,rows}
    const fromCaller = Array.isArray(request) ? {} : (request ?? {})
    const argv = Array.isArray(request) ? request : fromCaller.argv
    if (!Array.isArray(argv)) {
      throw new Error('background-terminal: begin() requires an argv array or a spec with .argv')
    }
    const cwd = fromCaller.cwd ?? record.cwd
    const env = fromCaller.env ?? record.env
    const spec = {
      argv,
      cols: fromCaller.cols ?? record.cols ?? config.cols ?? DEFAULT_COLS,
      rows: fromCaller.rows ?? record.rows ?? config.rows ?? DEFAULT_ROWS,
      terminalType: fromCaller.terminalType ?? record.terminalType ?? TERMINAL_TYPE,
      graceMs: config.disposeGraceMs ?? DEFAULT_GRACE_MS,
    }
    if (cwd !== undefined) spec.cwd = cwd
    if (env !== undefined) spec.env = env
    if (record.abort?.signal !== undefined) spec.signal = record.abort.signal
    return spec
  }

  /** handle.done 的 resolve 与 reject 都进 markExited；resolve 值必须收下。 */
  function attachDone(record) {
    if (!hasDone(record)) return
    record.doneObserved = Promise.resolve(record.handle.done).then(
      (outcome) => {
        markExited(record, outcome)
      },
      (error) => {
        record.transportError = message(error)
        markExited(record, undefined)
      },
    )
    record.doneObserved.catch(() => {})
  }

  function markExited(record, outcome) {
    const facts = factsOf(record)
    if (facts.ptyExited) return
    facts.ptyExited = true
    record.ptyHandleLive = false
    if (outcome !== undefined && outcome !== null) record.rawExit = outcome

    // 分类依据是"这个 shell 是否真的开始服役"，由**集成层**在观察到就绪信标时
    // 置 `record.served = true`（`record.ready` 是集成层的概念，controller 不依赖它）。
    //
    // 为什么不能用 phase：phase 在 spawn 之后就被置成 running（发布即 running），
    // 所以"发布完成、就绪信标未到"这段窗口里崩溃的 shell 会被判成 natural-exit——
    // 于是"起来就挂"报成了"干净退出"（phase exited），而不是失败。真机上正是
    // `exit 127 且零输出` 那种形态。
    const origin = record.served === true ? 'natural-exit' : 'shell-exited'
    finish(record, { origin }).catch(() => {})
  }

  /**
   * 一次清理尝试：并发共享同一个 promise，失败（或成功）后清掉记忆化，允许下一次重试。
   * 先登记再执行，保证 finally 的清除不会被同步落定抢先。
   */
  function attemptClose(record, reason) {
    if (record.closeAttemptPromise !== undefined) return record.closeAttemptPromise

    record.cleanupAttempts = (record.cleanupAttempts ?? 0) + 1
    const attempt = deferred()
    record.closeAttemptPromise = attempt.promise
    void (async () => {
      let ok = false
      try {
        record.terminateError = undefined
        await deps.terminateRecord(record, reason)
        // 适配器有两种失败风格：reject，或把错误写进 record.terminateError 后正常返回。
        // 后者必须按失败处理——否则会在进程仍存活时释放容量（R7-03）。
        if (record.terminateError !== undefined && record.terminateError !== null && record.terminateError !== '') {
          throw new Error(String(record.terminateError))
        }
        factsOf(record).ptyExited = true // 成功返回 = 幸存者检查已通过
        record.ptyHandleLive = false
        ok = true
      } catch (error) {
        record.terminateError = message(error)
      } finally {
        record.closeAttemptPromise = undefined // 每次重试都是新的 attempt promise
        attempt.resolve(ok)
      }
    })()
    return attempt.promise
  }

  /** 测试用：清理尝试次数。 */
  function attempts(record) {
    return record.cleanupAttempts ?? 0
  }

  // ───────────────────────────────────────────────────────────────────────────
  // begin
  // ───────────────────────────────────────────────────────────────────────────

  function begin(record, request) {
    if (record.beginPromise === undefined) record.beginPromise = run(record, request)
    return record.beginPromise
  }

  async function run(record, request) {
    const facts = factsOf(record)

    // 启动前取消 / 插件已卸载：不 spawn，但两个 Gate 都要落定
    if (isCancelled(record) || deps.lifecycle?.closed === true) {
      if (!isCancelled(record)) record.cancelRequested = 'plugin teardown'
      facts.spawnFinished = true
      rejectStartGate(record, cancelledError(record.cancelRequested))
      return finish(record, { origin: 'cancelled-before-spawn', reason: record.cancelRequested })
    }

    record.phase = 'spawning'
    facts.spawnAttempted = true
    const barrier = takeSpawnBarrier(record)

    // spawnSettled 屏障：闭包内 await spawn，finish 第一步 await 屏障。
    // abort 只是尽力而为——spawnTerminal 拿到 handle 后不处理后续 abort，取消不能只依赖 signal。
    try {
      // `spawnArgvOf` 让**集成层**决定交给 spawnTerminal 的 argv：直连 node-pty 的
      // 后端要的是裸 shell argv，而经 confine 的后端要的是 runner 包装后的 argv。
      // controller 不关心这个区别（它不认识沙箱），所以默认恒等。
      const spec = spawnSpec(record, request)
      const override = deps.spawnArgvOf?.(record, spec)
      if (Array.isArray(override) && override.length > 0) spec.argv = override
      record.handle = await deps.spawnTerminal(spec)
      facts.ptyCreated = true
      record.ptyHandleLive = true
      attachDone(record)
      logEvent('info', 'spawn ok', logDetail(record, { pid: record.handle?.pid }))
      recordSpawnOutcome(record, { pid: record.handle?.pid })
    } catch (error) {
      record.spawnError = error
      // 这是终端起不来时的**第一条**证据：spawnTerminal 自己的失败原因
      logEvent('error', 'spawn failed', logDetail(record, { error, errorCode: error?.code }))
      recordSpawnOutcome(record, { error })
    } finally {
      facts.spawnFinished = true
      barrier.resolve()
    }

    // 等屏障（已落定）让出一次微任务：让 spawn 期间就落定的 handle.done 先被观察，
    // 否则「启动期退出」会被误判成发布后的自然退出——分类不能由微任务时序决定。
    await barrier.promise

    // 固定顺序分支（无时序巧合）
    if (record.spawnError !== undefined) {
      rejectStartGate(record, record.spawnError)
      return finish(record, { origin: 'spawn-failed', error: record.spawnError })
    }
    if (isCancelled(record)) {
      rejectStartGate(record, cancelledError(record.cancelRequested))
      if (facts.ptyCreated) await attemptClose(record, record.cancelRequested) // 有 handle 先终止
      return finish(record, { origin: 'cancel', reason: record.cancelRequested })
    }
    if (facts.ptyExited) {
      // shell 在发布前就退出：真机上的典型形态是"起来就 127、零输出"
      logEvent('error', 'shell exited during startup', logDetail(record, {
        exit: record.rawExit ?? record.rawExitError,
        captured: capturedTail(record),
      }))
      rejectStartGate(record, new Error('shell exited during startup'))
      return finish(record, { origin: 'shell-exited' })
    }

    try {
      const published = deps.onPublished?.(record, record.handle)
      if (published !== undefined) record.session = published
      if (record.session === undefined) record.session = record
      record.phase = 'running'
      resolveStartGate(record, record.session)
    } catch (error) {
      rejectStartGate(record, error)
      return finish(record, { origin: 'publish-failed', error })
    }

    // begin 的生命周期与记录同长（PLAN §5.5）：调用方不必再等 outcomeGate
    await gatePromise(record.outcomeGate).catch(() => {})
  }

  // ───────────────────────────────────────────────────────────────────────────
  // finish：十步单一收口
  // ───────────────────────────────────────────────────────────────────────────

  function outcomeFor(record, opts, disposition) {
    const last = record.rawExit ?? {}
    const exitCode = typeof last.exitCode === 'number' ? last.exitCode : null
    const signal = typeof last.signal === 'string' ? last.signal : null
    const requested = opts.reason ?? record.cancelRequested ?? 'cancelled'

    switch (opts.origin) {
      case 'setup-failed':
        return { phase: 'failed', status: 'failed', exitCode: null, signal: null, detail: `setup failed: ${message(opts.error)}` }
      case 'spawn-failed':
        return {
          phase: 'failed', status: 'failed', exitCode: null, signal: null,
          detail: `PTY spawn failed: ${message(opts.error ?? record.spawnError)}`,
        }
      case 'publish-failed':
        return { phase: 'failed', status: 'failed', exitCode: null, signal: null, detail: `session publish failed: ${message(opts.error)}` }
      case 'cancelled-before-spawn':
      case 'cancel':
      case 'cleanup-retry-succeeded': {
        // `requested` 的来路有两类，形态完全不同：
        //   · **短令牌**：`SIGKILL`（本插件默认）、`closed by request` —— 需要前缀才读得懂；
        //   · **完整句子**：宿主传入的 `cancelled by the user`，或 `plugin unloaded`
        //     —— 已经是一句话，再加前缀就成了
        //     "closed by request: cancelled by the user; cancelled by the user"。
        //
        // 这里用**短令牌白名单**而不是"完整句子黑名单"：句子是无穷的
        // （曾经只排除了 `closed by request`/`unload`，下一个 `cancelled by the user` 立刻漏网）。
        // 凡是含空格的短语都当作调用方自己写好了描述，原样上报。
        const looksLikeToken = /^[A-Za-z0-9_]+$/.test(requested)
        const described = looksLikeToken ? `closed by request: ${requested}` : requested
        return { phase: 'killed', status: 'killed', exitCode, signal, detail: described }
      }
      case 'shell-exited': {
        const suffix = signal !== null ? ` (signal ${signal})` : exitCode !== null ? ` (exit code ${exitCode})` : ''
        // 这一份同时用于两处，所以两处都要照顾：
        //  · Jobs 的 `outcome.detail` → 宿主的 job 完成通知（`fitCompletionNotice`）；
        //  · `record.terminal.detail` → `terminal_read` / `terminal_state` 的 detail。
        // 注意：`record.terminal.detail` 会**再**追加完整诊断块（`withDiagnostics`），
        // 但 jobs 那份不会——两者是不同的字符串，见 `settleJobs`。
        // 因此这里保留一行尾部输出与 127 提示：它们便宜、且是模型在通知里唯一看得到的线索。
        return { phase: 'failed', status: 'failed', exitCode, signal, detail: `shell exited during startup${suffix}${capturedSuffix(record)}${exitCodeHint(exitCode)}` }
      }
      case 'natural-exit':
      default:
        if (signal !== null) return { phase: 'killed', status: 'killed', exitCode, signal, detail: `signal ${signal}` }
        if (exitCode === 0) return { phase: 'exited', status: 'completed', exitCode: 0, signal: null, detail: 'exit code 0' }
        if (exitCode !== null) return { phase: 'exited', status: 'failed', exitCode, signal: null, detail: `exit code ${exitCode}${capturedSuffix(record)}${exitCodeHint(exitCode)}` }
        return { phase: 'exited', status: 'failed', exitCode: null, signal: null, detail: `exit code unknown${disposition === 'no-pty' ? ' (no PTY)' : ''}` }
    }
  }

  /** 已捕获输出的尾部后缀（一行），没捕获到任何输出时返回空串。 */
  function capturedSuffix(record, limit = 300) {
    const captured = capturedTail(record, limit)
    return captured === undefined ? '' : `; captured output: ${captured}`
  }

  /**
   * 退出码 127 的定向提示。
   *
   * 127 是**沙箱 runner 自己的失败码**（`RUNNER_FAILURE_EXIT`）：runner 的 `main()`
   * 以 `.then(…, error => process.exitCode = 127)` 收尾，任何非 RunnerFailure 的异常
   * 都会走这里，并往 stderr 打 `windows-acl-run: <detail>`。
   *
   * 终端场景下那段 stderr 未必能被 PTY 捕获，于是"127 + 零输出"很容易被读成
   * "我的命令写错了"。这一句是模型在**通知**里唯一能看到的解释，所以留在 detail 里；
   * 完整证据链（argv、耗时、provider）另在诊断块中，经 `terminal_state` 按需取。
   */
  function exitCodeHint(exitCode) {
    if (exitCode !== 127) return ''
    return (
      '; note: 127 is the host runner\'s own failure code (RUNNER_FAILURE_EXIT), '
      + 'not a command-not-found — the confined child could not be created'
    )
  }

  function startGateError(record, opts) {
    if (opts.error instanceof Error) return opts.error
    if (opts.error !== undefined) return new Error(message(opts.error))
    if (opts.origin === 'cancelled-before-spawn' || opts.origin === 'cancel') {
      return cancelledError(opts.reason ?? record.cancelRequested)
    }
    return new Error(outcomeFor(record, opts, 'no-pty').detail)
  }

  function cleanupFailedView(record, error) {
    const facts = factsOf(record)
    const last = record.rawExit ?? {}
    const pid = record.handle?.pid
    const errorText = message(error ?? record.terminateError ?? 'terminate failed')
    return {
      exitCode: typeof last.exitCode === 'number' ? last.exitCode : null,
      signal: typeof last.signal === 'string' ? last.signal : null,
      detail: `terminal cleanup failed; surviving pid: ${pid ?? 'unknown'}; ${errorText}`,
    }
  }

  /**
   * cleanup-failed 的失败视图只在**这里**构造，一次产出两个视图：
   *
   *  · 返回值是**通知侧**的一句话。`settleJobs` 把它交给 Jobs，宿主用
   *    `fitCompletionNotice` 把它拼进单行 `[status: …, …]`（`dsh-tool-jobs/lib/index.js:45-46,163-165`），
   *    所以它必须是单行短文案——诊断块有十几行，会把通知撑成一篇长文。
   *  · `record.terminal` 追加完整诊断，是 `terminal_read` / `terminal_state` 的按需取通道。
   *
   * 两个视图必须分开：把带诊断的那份交给 `settleJobs`，就是"同一类失败因路径不同而通知长度不同"的根因。
   */
  function applyCleanupFailureView(record, error) {
    const view = cleanupFailedView(record, error)
    record.terminal = withDiagnostics(record, view, true)
    return view.detail
  }

  /** 步骤 8：Jobs 只结算一次，outcomeGate 恒 resolve 且 status 合法。 */
  function settleJobs(record, outcome) {
    if (record.jobDoneResolved === true) return
    // 插件卸载/关机时**先不结算**：宿主只在 `cause === 'teardown'` 时抑制 job 完成通知
    // （dsh-tool-jobs 的 settled 过滤），而那个 cause 只有宿主自己的 teardown 路径会打。
    // 我们先结算的话，宿主看到的是一次普通 producer 结算 ⇒ 通知照发、agent 被唤醒一轮
    // ——那正是「关 DSH 反而惊动模型」的成因。所以这里只记账：等宿主要么来 cancel
    // （此时 cause 已被标成 teardown），要么由兜底定时器按普通结算放行（插件热重载）。
    if (record.deferSettlement === true) {
      record.deferredOutcome = outcome
      return
    }
    record.jobDoneResolved = true
    resolveGate(record.outcomeGate, { status: outcome.status, detail: outcome.detail })
  }

  /**
   * 放行被推迟的 Jobs 结算。
   *
   * 两个调用点：宿主 teardown 的 cancel（cause 已写成 teardown ⇒ 通知被抑制）、
   * 以及卸载兜底定时器（插件热重载、宿主并不在退出 ⇒ 按普通结算上报）。
   *
   * @returns {boolean} 这次调用是否真的结算了一次
   */
  function flushDeferred(record) {
    if (record.jobDoneResolved === true) return false
    // **先撤掉挂起**，再看有没有可结算的结果：
    // 宿主的 cancel 可能比我们的 finish 先到（这时还没有 outcome）。若只在
    // 「有结果」时才撤挂起，finish 随后又会把结算推迟一次，而宿主可能正卡在
    // `await job.settled` 上——那就成了关机时多等一个永远不来的结算。
    record.deferSettlement = false
    const outcome = record.deferredOutcome
    if (outcome === undefined) return false
    record.deferredOutcome = undefined
    settleJobs(record, outcome)
    return record.jobDoneResolved === true
  }

  /** 步骤 9+10：只有确认进程消失才释放容量/围栏并落定 cleanupSettled。 */
  async function settleCleanup(record) {
    if (dispositionOf(factsOf(record)) === 'pty-alive') {
      record.phase = 'cleanup-failed'
      settleJobs(record, { status: 'failed', detail: applyCleanupFailureView(record) })
      return false
    }
    if (record.cleanupReleased !== true) {
      // release 与 enterRetention 分开 try：release 是**不可逆**的（容量已归还），
      // 若把它与 enterRetention 包在同一个 try 里，后者抛错会重置 cleanupReleased
      // 并把 phase 标成 cleanup-failed——于是容量已释放、却对外宣称"进程可能还在"，
      // 且重试会再释放一次。两者各自结算，各自记录失败。
      record.cleanupReleased = true
      try {
        admission.release?.(record)
      } catch (error) {
        record.cleanupReleased = false
        record.phase = 'cleanup-failed'
        applyCleanupFailureView(record, error)
        log(`session ${record.id} release failed: ${message(error)}`)
        return false
      }
      try {
        admission.enterRetention?.(record)
      } catch (error) {
        // 容量已经还了，绝不能因此把会话标回 cleanup-failed（那会泄漏一个"可能还活着"的假象）。
        // 保留期只是"还能读多久"的记账，失败降级为不进入保留期即可。
        log(`session ${record.id} enterRetention failed (capacity already released): ${message(error)}`)
      }
    }
    resolveGate(record.cleanupSettled)
    return true
  }

  function finish(record, opts = {}) {
    if (record.finishing !== undefined) return record.finishing

    record.finishing = (async () => {
      const facts = factsOf(record)
      const reason = opts.reason ?? record.cancelRequested ?? opts.origin

      // 0.5 中断没能确认：会话落定了，而某次中断仍停在 delivered ——
      //     （中断事实的写入点分两处：送货/确认在 lib/index.js，未确认降级在这里。）
      //     我们始终没等到"shell 又接受了下一条命令"这个会话侧事实。
      //     如实记 interrupt-pending，而不是假装它已经停干净了（P0-INT-1 冻结契约）。
      const pendingInterrupt = record.interrupt
      if (pendingInterrupt !== undefined && pendingInterrupt.state === 'delivered') {
        pendingInterrupt.state = 'interrupt-pending'
        pendingInterrupt.detail = 'session settled before the interrupt could be verified; '
          + 'external evidence (process tree / service port) is outside this plugin\'s view'
      }

      // 1. 等 spawnSettled —— 否则会抢先把迟到的 handle 判成 no-pty 并释放容量
      await awaitSpawnSettled(record)

      // 2. 处置只由事实位判定
      let disposition = dispositionOf(facts)

      if (disposition === 'pty-alive') {
        // 3. 发起一次新的 terminate 尝试
        if (!isTerminalPhase(record.phase)) record.phase = 'stopping'
        const attempt = attemptClose(record, reason)
        // 4. 等 handle.done 或确认 terminate 成功（terminate 挂住时由 done 唤醒）
        const waits = [attempt]
        if (hasDone(record)) waits.push(doneSettled(record))
        await Promise.race(waits)
        disposition = dispositionOf(facts)
      }

      // 5+6. 等 output drain/EOF 并 flush ring：deps.flushPump 的契约就是「等 output end → 收尾」
      if (facts.ptyCreated) {
        try {
          await deps.flushPump(record)
        } catch (error) {
          log(`session ${record.id} flushPump failed: ${message(error)}`)
        }
      }

      // startGate 在所有路径都落定（含不经 begin 的 setup-failed）
      if (record.startGateSettled !== true) rejectStartGate(record, startGateError(record, opts))

      if (disposition === 'pty-alive') {
        // 7. 进程可能还在：Jobs 按契约先 failed，容量与围栏保留；
        //    通知只拿短文案，完整证据链留在 record.terminal（terminal_read / terminal_state 按需取）
        record.phase = 'cleanup-failed'
        // 8. Jobs 只结算一次
        settleJobs(record, { status: 'failed', detail: applyCleanupFailureView(record) })
        log(`session ${record.id} cleanup-failed: ${record.terminal.detail}`)
        return // 9/10 不执行：不释放，cleanupSettled 保持未落定，等 cancel() 重试
      }

      // 7. 构造 terminal view（唯一数据源）；失败视图尾部追加启动证据链。
      //
      // 注意这里产生的 `record.terminal.detail` 与 job 收到的那份**不是同一个字符串**：
      // `settleJobs(record, outcome)` 传的是 `outcome.detail`（未追加诊断）。
      // 所以宿主 job 完成通知只有一句话，`terminal_read` / `terminal_state` 的 detail
      // 才带完整证据链——核对通知形态时必须区分这两份。
      // cleanup-failed 路径同此形态：它经 `applyCleanupFailureView` 也只把短文案交给
      // `settleJobs`，两条路径给宿主的 detail 因此一致。
      const outcome = outcomeFor(record, opts, disposition)
      record.phase = outcome.phase
      record.terminal = withDiagnostics(
        record,
        { exitCode: outcome.exitCode, signal: outcome.signal, detail: outcome.detail },
        outcome.status === 'failed',
      )
      // 8. Jobs 只结算一次
      settleJobs(record, outcome)

      // 9+10. 确认进程消失后才释放 reservation / fence，再 resolve cleanupSettled
      await settleCleanup(record)
    })().catch((error) => {
      // 收口自身抛错不得静默：记日志、置 cleanup-failed、outcomeGate 以合法 failed 落定
      log(`session ${record?.id} finish failed: ${message(error)}`)
      try {
        record.phase = 'cleanup-failed'
        settleJobs(record, { status: 'failed', detail: applyCleanupFailureView(record, error) })
      } catch {
        // 兜底路径不再抛
      }
    })

    return record.finishing
  }

  function doneSettled(record) {
    if (record.doneObserved !== undefined) return record.doneObserved
    return Promise.resolve(record.handle.done).then(
      () => {},
      () => {},
    )
  }

  // ───────────────────────────────────────────────────────────────────────────
  // cancel：唯一取消入口
  // ───────────────────────────────────────────────────────────────────────────

  async function cancel(record, reason, options = {}) {
    // 宿主接管（含它自己的 teardown）：先放行被推迟的结算。
    // 此刻宿主的 settleCause 已经写成 'teardown'，所以这次结算不会唤醒 agent。
    //
    // 插件**自己的**卸载要传 `keepDeferred: true`：它正是设下挂起的那一方，
    // 在这里放行等于没挂起。
    if (options.keepDeferred !== true) flushDeferred(record)
    if (!isCancelled(record)) record.cancelRequested = reason ?? 'cancelled'
    try {
      record.abort?.abort?.(new Error(record.cancelRequested))
    } catch {
      // abort 只是尽力而为
    }

    if (record.phase === 'cleanup-failed') {
      // 重试分支：新建一次清理尝试；成功后只更新视图 + 释放，不再落定 Jobs
      await retryCleanup(record, record.cancelRequested)
      return record.finishing
    }

    if (!isTerminalPhase(record.phase)) record.phase = 'stopping'
    return finish(record, { origin: 'cancel', reason: record.cancelRequested })
  }

  async function retryCleanup(record, reason) {
    if (record.cleanupRetryPromise !== undefined) return record.cleanupRetryPromise
    record.cleanupRetryPromise = (async () => {
      try {
        await attemptClose(record, reason)
        if (dispositionOf(factsOf(record)) === 'pty-alive') return // 仍失败：保持 cleanup-failed

        const outcome = outcomeFor(record, { origin: 'cancel', reason }, 'pty-exited')
        record.phase = outcome.phase
        record.terminal = { exitCode: outcome.exitCode, signal: outcome.signal, detail: outcome.detail }
        await settleCleanup(record)
      } finally {
        record.cleanupRetryPromise = undefined
      }
    })()
    return record.cleanupRetryPromise
  }

  return { begin, cancel, finish, attempts, flushDeferred }
}
