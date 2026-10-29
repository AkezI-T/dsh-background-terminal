/**
 * 冻结的内部契约。四个模块按此并行实现，互不读对方的源码。
 *
 * 硬约束（违反即返工）：
 *  1. 不 import 任何 `@deepseek-ai/*` 包。profile 的 node_modules 里没有它们；
 *     工具用普通对象注册，配置校验用普通函数抛错。
 *  2. 只 import `node:*` 与同目录相对路径。
 *  3. 每个模块不直接 import 另一个模块的**实现**，只用本文件描述的形状；
 *     唯一的例外是 index.js（集成层，由 Lead 拥有）。
 *  4. 每个操作有唯一入口：禁止多处直接调用 handle.write() / handle.terminate()
 *     或消费 handle.output。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. PTY 端口（由测试注入假实现；生产由 lib/index.js 从 ctx.subprocess.spawnTerminal 适配）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} PtyHandle
 * @property {number} pid
 * @property {import('node:stream').Readable} output    PTY 输出流（data/end/error）
 * @property {Promise<{exitCode:number|null, signal:string|null}>} done
 * @property {() => Promise<void>} terminate            失败会 reject（可能仍有幸存进程）
 * @property {(data:string) => Promise<void>} write     进程已退出时抛错
 * @property {() => Promise<{processGroupId:number|undefined, inputWaiting:boolean|undefined}>} inspectForeground
 * @property {() => Promise<{state:'idle'|'busy'|'unknown', revision:number}>} inspectActivity
 * @property {(signal:string) => Promise<number|undefined>} signalForeground
 */

export const CONTRACT_VERSION = 1

// ─────────────────────────────────────────────────────────────────────────────
// 2. 事实位与处置
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} FactBits
 * @property {boolean} spawnAttempted  已进入 begin()
 * @property {boolean} spawnFinished   spawnTerminal 已落定（成功或失败）
 * @property {boolean} ptyCreated      已取得 handle
 * @property {boolean} ptyExited       已确认进程消失
 */

/**
 * 处置只能由事实位计算。
 * @param {FactBits} facts
 * @returns {'pty-exited'|'pty-alive'|'no-pty'}
 */
export function dispositionOf(facts) {
  if (facts.ptyExited) return 'pty-exited'
  if (facts.ptyCreated) return 'pty-alive'
  return 'no-pty'
}

/** phase 全集。 */
export const PHASES = Object.freeze([
  'reserved', 'spawning', 'running', 'stopping',
  'exited', 'killed', 'failed', 'cleanup-failed',
])

/** 是否终态（终态记录不进容量计数，除非 cleanup-failed）。 */
export function isTerminalPhase(phase) {
  return phase === 'exited' || phase === 'killed' || phase === 'failed'
}

/** 是否计入 maxSessionsPerAgent（cleanup-failed 计入——进程可能还在）。 */
export function isActivePhase(phase) {
  return !isTerminalPhase(phase)
}

/** finish() 的原因，决定 phase / terminal / Jobs outcome。 */
export const ORIGINS = Object.freeze([
  'setup-failed',             // confine / jobs.start 失败：无 PTY
  'spawn-failed',             // spawnTerminal 拒绝：无 PTY
  'cancelled-before-spawn',   // 预留后、spawn 前取消：无 PTY
  'publish-failed',           // spawn 成功但会话发布抛错
  'shell-exited',             // shell 启动期异常退出
  'natural-exit',             // 自然退出
  'cancel',                   // 显式取消/关闭（有 handle）
  'cleanup-retry-succeeded',  // cleanup-failed 之后重试成功（不二次落定 Jobs）
])

// ─────────────────────────────────────────────────────────────────────────────
// 3. records.mjs
// ─────────────────────────────────────────────────────────────────────────────

/** 稳定错误码（输入路径）。 */
export const INPUT_ERRORS = Object.freeze({
  INPUT_TOO_LARGE: 'INPUT_TOO_LARGE',
  INPUT_QUEUE_FULL: 'INPUT_QUEUE_FULL',
  SESSION_NOT_WRITABLE: 'SESSION_NOT_WRITABLE',
})

/**
 * @typedef {object} AdmissionOptions
 * @property {number} maxSessionsPerAgent
 * @property {number} maxSettledRetainedPerAgent
 * @property {number} maxPendingWriteBytes
 * @property {number} maxPendingWriteCount
 * @property {number} maxPendingSignalCount
 */

/** 注册表（由 createAdmission 返回）。 */
export const ADMISSION_SHAPE = Object.freeze({
  reserve: '(owner, init) -> TerminalRecord',
  get: '(id, owner) -> TerminalRecord|undefined',
  find: '(owner, id) -> TerminalRecord|undefined',
  listForOwner: '(owner) -> TerminalRecord[]',
  activeCount: '(owner) -> number',
  hasOwnerActivity: '(owner) -> boolean',
  release: '(record) -> void              // 幂等；capacity -1，从注册表移除',
  enterRetention: '(record) -> void       // 进入终态保留期，按 maxSettledRetainedPerAgent LRU 淘汰',
  sweepNow: '() -> void                   // 测试用：立即执行保留期清扫',
  size: '() -> number',
  setFence: '(fence) -> void             // index.js 注入围栏；reserve 时安装 handler',
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. fence.mjs
// ─────────────────────────────────────────────────────────────────────────────

/** 围栏。handler 挂到 ownerCtx，本模块不碰 owner.ctx.effect（ownerCtx 由测试注入）。 */
export const FENCE_SHAPE = Object.freeze({
  ensure: '(owner, ownerCtx) -> void    // 每 owner 幂等安装一次；缺 ctx.sessionProjections 时抛错',
  shouldBlock: '(owner, nextMode) -> string|undefined  // 返回拒绝文案，或 undefined 表示放行',
  disposeAll: '() -> void               // 卸载全部 handler（插件 teardown）',
  installedCount: '() -> number          // 测试用',
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. controller.mjs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ControllerDeps
 * @property {(spec: {argv:string[], cwd?:string, env?:object, cols?:number, rows?:number,
 *                   terminalType?:string, graceMs:number, signal?:AbortSignal}) => Promise<PtyHandle>} spawnTerminal
 * @property {import('./records.mjs').AdmissionLike} admission
 * @property {{closed:boolean}} lifecycle            插件卸载时置 closed=true
 * @property {(record, reason) => Promise<void>} terminateRecord
 * @property {(record) => Promise<void>} flushPump
 * @property {(msg:string) => void} log
 * @property {object} config                         见 FINAL.md §14
 * @property {(record, handle) => void} onPublished  集成层钩子：spawn 成功且未取消时调用，
 *                                                   由它建会话、挂唯一 pump、resolve startGate。
 *                                                   controller 不自己建会话。
 */

export const CONTROLLER_SHAPE = Object.freeze({
  begin: '(record, argv) -> Promise<void>       // 记忆化；绝不二次 spawn',
  cancel: '(record, reason) -> Promise<void>    // 唯一取消入口；幂等',
  finish: '(record, opts) -> Promise<void>      // opts = { origin, error?, reason?, terminate? }；幂等',
  attempts: '(record) -> number                 // 测试用：清理尝试次数',
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. shell-bash.mjs
// ─────────────────────────────────────────────────────────────────────────────

export const SHELL_SHAPE = Object.freeze({
  resolveShellArgv: '(config) -> { path, dialect, args }   // 校验 shellArgs 不含 -c；非法即抛',
  wrapCommand: '(command) -> { text, start, end }          // end 前缀为 `__DSH_BGTERM_<nonce>_E__`',
  detectReadiness: '(text) -> boolean',
  extractFrame: '(text, marker) -> { text, exitCode } | undefined',
})

/** nonce 形如 `__DSH_BGTERM_<uuid>_S__` / `..._E__<code>`。 */
export const MARKER_PREFIX = '__DSH_BGTERM_'

// ─────────────────────────────────────────────────────────────────────────────
// 7. pump.mjs / reader.mjs
// ─────────────────────────────────────────────────────────────────────────────

export const PUMP_SHAPE = Object.freeze({
  appendRaw: '(chunk: Buffer|string) -> { lostBytes:number }   // 同步：decode → ANSI 剥离 → ring',
  attachSink: '(sink: {write:(text:string)=>void, end:()=>void}, opts?) -> { detach:()=>void }',
  consume: '(fromOffset:number, budgetChars:number, opts?:{final?:boolean}) -> ConsumeResult',
  flush: '() -> Promise<void>    // 等 output end → 剥离器收尾 → 通知 sink.end',
  totalBytes: '() -> number',
})

/**
 * @typedef {object} ConsumeResult
 * @property {string} text
 * @property {number} nextOffset
 * @property {number} consumedBytes
 * @property {boolean} lossy
 * @property {number|undefined} gapBefore
 * @property {boolean} truncated
 */

export const READER_SHAPE = Object.freeze({
  createCursor: '() -> { offset:number }',
  read: '(pump, cursor, opts:{budgetChars:number, final?:boolean}) -> ConsumeResult',
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. 测试设施（test/helpers/fake-ctx.mjs，由 Lead 提供，各测试文件共用）
// ─────────────────────────────────────────────────────────────────────────────

export const TEST_HELPERS = Object.freeze({
  makeFakePty: '(opts?) -> { handle, emit, end, fail, spawnCalls, terminateCalls, writeCalls, ignoreAbort }',
  makeFakeSpawn: '(opts?) -> { spawnTerminal, calls }',
  makeOwnerCtx: '() -> { on, off, emit, handlers }',
  makeFakeCtx: '(overrides?) -> ctx',
})
