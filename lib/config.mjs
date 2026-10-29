/**
 * 配置解析与校验。挂载期就要失败得早：非法配置让插件挂载失败，
 * 而不是等到第一次工具调用。
 *
 * 不 import 任何 `@deepseek-ai/*`——profile 的 node_modules 里没有它们。
 */

import { resolveShellArgv } from './shell-bash.mjs'

// 日志级别由 log.mjs 定义，保持单一事实来源
import { LEVELS as LOG_LEVELS } from './log.mjs'

/** 真实用户终端 provider 的上限，用于对齐（见 FINAL.md §8.1）。 */
export const MAX_COLS = 500
export const MAX_ROWS = 200
export const MAX_WAIT_MS = 30_000

const DEFAULTS = Object.freeze({
  shellDialect: 'bash',
  // allowShellOverride：是否允许 terminal_exec 的 shellPath 参数覆盖配置里的 shell。
  // 默认允许（AI 自己发现的路径是最贴近这台机器的事实）；设为 false 即把 shell 钉死。
  allowShellOverride: true,
  // 默认 info：真机调试需要理由，"起来就挂"这类失败必须留下痕迹
  logLevel: 'info',
  cols: 120,
  rows: 30,
  maxSessionsPerAgent: 4,
  maxSettledRetainedPerAgent: 4,
  settledRetainMs: 300_000,
  maxBufferBytes: 262_144,
  maxOutputChars: 16_000,
  maxInputBytes: 65_536,
  maxPendingWriteBytes: 262_144,
  maxPendingWriteCount: 32,
  maxPendingSignalCount: 8,
  // readyQuietMs：就绪信标未到时，静默兜底窗口（index.js 消费）
  readyQuietMs: 300,
  // startupGraceMs：发布后判定"宿主拒绝创建 PTY"的观察窗（index.js 消费）。
  //
  // 取值依据是真机实测：shell 在 **spawn 之后 1347ms** 才以 127 退出——沙箱 runner
  // 先跑 `AclSandbox.init()` 再建子进程，这一跳就要一秒多。窗口小于该值就会先返回
  // `starting`，调用方必须再读一次才发现失败（审阅 R001-02 要消灭的形态）。
  // 正常运行不受影响：就绪信标一到立即返回，不会白等满窗。
  startupGraceMs: 2000,
  startTimeoutMs: 5000,
  disposeGraceMs: 3000,
  // ptyBackend：持久 shell 的派生方式。
  //
  //  - `'node-pty'`：插件直连 node-pty（Windows 上唯一可用的路径）。
  //    上游 `ctx.subprocess.spawnTerminal` 经 ACL 沙箱 runner 派生 PTY 时，
  //    runner 会在启动约 1.3 秒后以自己的失败码 127 退出，且 stderr 不进入 PTY，
  //    表现为「127 + 零输出」——本机从未成功起过一次终端。生态参考实现
  //    （dsh-bash-terminal）同样绕过这条接缝。**注意：该路径不受 ACL 沙箱约束**，
  //    实际隔离等级由 `enforcement` 字段如实上报。
  //  - `'host'`：走上游 `ctx.subprocess.spawnTerminal`（经 confine）。在本机不可用，
  //    保留给上游修复后使用，或用于在其它平台上对照验证。
  ptyBackend: 'node-pty',
  // 进度行刷新间隔（task-9 的实时进度，1s 级足够且不刷爆 job 事件）
  progressIntervalMs: 1000,
  // respondToTerminalQueries：是否应答 PTY 里的终端协议查询（DA1/DA2/DSR）。
  //
  // 默认开：readline、psql、部分安装器会发 `ESC[6n` 然后**同步等回答**，没有应答时
  // 不报错、只是卡到自己的超时——那看起来和「进程卡死」一模一样。近似范围见
  // lib/protocol.mjs 的文件头（只跟踪列，行固定回 1）。
  respondToTerminalQueries: true,
  // passElectronRunAsNode：是否把宿主的 `ELECTRON_RUN_AS_NODE` 继承给持久 shell。
  //
  // 默认 **false（剥掉）**：DSH 宿主自己可能跑在 Electron-as-Node 模式，那个变量会被
  // 所有子进程继承，于是 shell 里启动的任何 Electron 程序都静默退化成纯 Node——
  // 不报错、不开窗，看起来像卡住。需要该模式时在 shell 里显式设置即可。
  passElectronRunAsNode: false,
})

/** 允许的 PTY 后端取值。 */
export const PTY_BACKENDS = Object.freeze(['node-pty', 'host'])

function positiveInt(value, fallback, name) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`background-terminal: ${name} must be a positive safe integer, got ${JSON.stringify(value)}`)
  }
  return value
}

function boundedInt(value, fallback, max, name) {
  const n = positiveInt(value, fallback, name)
  if (n > max) throw new Error(`background-terminal: ${name} must be <= ${max}, got ${n}`)
  return n
}

/**
 * 解析并校验插件配置。任何非法项都在这里抛错（挂载失败）。
 * @param {object} raw 由 loader 传入的原始配置
 * @returns {object} 解析后的配置
 */
export function resolveConfig(raw = {}) {
  const config = { ...DEFAULTS, ...raw }

  // shell 契约：方言与 argv 校验都在 resolveShellArgv 里（bash/pwsh，拒绝 -c 类一次性参数）
  const shell = resolveShellArgv(config)

  if (config.sandboxProviderRequired === false) {
    throw new Error('background-terminal: sandboxProviderRequired cannot be disabled')
  }

  // 日志级别：拼错就挂载失败，不静默退回默认（否则"我开了 debug 怎么没日志"极难查）
  const logLevel = config.logLevel
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(
      `background-terminal: logLevel must be one of ${LOG_LEVELS.join(', ')}, got ${JSON.stringify(logLevel)}`,
    )
  }

  return {
    ...config,
    logLevel,
    allowShellOverride: booleanOf(config.allowShellOverride, DEFAULTS.allowShellOverride, 'allowShellOverride'),
    shellPath: shell.path,
    shellDialect: shell.dialect,
    shellArgs: shell.args,
    cols: boundedInt(config.cols, DEFAULTS.cols, MAX_COLS, 'cols'),
    rows: boundedInt(config.rows, DEFAULTS.rows, MAX_ROWS, 'rows'),
    maxSessionsPerAgent: positiveInt(config.maxSessionsPerAgent, DEFAULTS.maxSessionsPerAgent, 'maxSessionsPerAgent'),
    maxSettledRetainedPerAgent: positiveInt(config.maxSettledRetainedPerAgent, DEFAULTS.maxSettledRetainedPerAgent, 'maxSettledRetainedPerAgent'),
    settledRetainMs: positiveInt(config.settledRetainMs, DEFAULTS.settledRetainMs, 'settledRetainMs'),
    maxBufferBytes: positiveInt(config.maxBufferBytes, DEFAULTS.maxBufferBytes, 'maxBufferBytes'),
    maxOutputChars: positiveInt(config.maxOutputChars, DEFAULTS.maxOutputChars, 'maxOutputChars'),
    maxInputBytes: positiveInt(config.maxInputBytes, DEFAULTS.maxInputBytes, 'maxInputBytes'),
    maxPendingWriteBytes: positiveInt(config.maxPendingWriteBytes, DEFAULTS.maxPendingWriteBytes, 'maxPendingWriteBytes'),
    maxPendingWriteCount: positiveInt(config.maxPendingWriteCount, DEFAULTS.maxPendingWriteCount, 'maxPendingWriteCount'),
    maxPendingSignalCount: positiveInt(config.maxPendingSignalCount, DEFAULTS.maxPendingSignalCount, 'maxPendingSignalCount'),
    readyQuietMs: positiveInt(config.readyQuietMs, DEFAULTS.readyQuietMs, 'readyQuietMs'),
    startupGraceMs: positiveInt(config.startupGraceMs, DEFAULTS.startupGraceMs, 'startupGraceMs'),
    startTimeoutMs: positiveInt(config.startTimeoutMs, DEFAULTS.startTimeoutMs, 'startTimeoutMs'),
    disposeGraceMs: positiveInt(config.disposeGraceMs, DEFAULTS.disposeGraceMs, 'disposeGraceMs'),
    ptyBackend: oneOf(config.ptyBackend, DEFAULTS.ptyBackend, PTY_BACKENDS, 'ptyBackend'),
    progressIntervalMs: positiveInt(config.progressIntervalMs, DEFAULTS.progressIntervalMs, 'progressIntervalMs'),
    respondToTerminalQueries: booleanOf(config.respondToTerminalQueries, DEFAULTS.respondToTerminalQueries, 'respondToTerminalQueries'),
    passElectronRunAsNode: booleanOf(config.passElectronRunAsNode, DEFAULTS.passElectronRunAsNode, 'passElectronRunAsNode'),
  }
}

/** 布尔校验：非布尔即挂载失败（拼错 `'false'` 不能被读成真，也不能被静默忽略）。 */
function booleanOf(value, fallback, name) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw new Error(`background-terminal: ${name} must be a boolean, got ${JSON.stringify(value)}`)
  }
  return value
}

/** 枚举校验：拼错即挂载失败，不静默退回默认（与 logLevel 同一理由）。 */
function oneOf(value, fallback, allowed, name) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`background-terminal: ${name} must be one of ${allowed.join(' | ')}, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Shell 能力矩阵（依审阅 R001-04）。
 *
 * 事实依据（实测，见 `docs/bug-reports/BUG-REPORT-001.md` B-2）：
 * Git Bash 是 Cygwin/MSYS2 程序，启动时必须创建信号管道；DSH 的 Windows ACL 沙箱
 * 用受限令牌创建进程、按设计排除命名管道对象，于是 bash 在初始化阶段即崩：
 *
 *     bash: *** fatal error - couldn't create signal pipe, Win32 error 5
 *
 * 表现为 shell 以 `exit code 127` 退出、从未就绪——**看起来像插件故障，实际是能力不匹配**。
 * 因此受限 Windows 下直接拒绝 bash，并给出可操作原因，而不是让调用方去猜 127。
 *
 * 这说明「不支持的组合应当在**启动前**被拒绝」，与 R001-02 的 `startup-failed` 同源。
 */

/** 受限（经 ACL runner）的 Windows 模式集合。`danger-full-access` 不经 runner，故不在内。 */
const CONFINED_MODES = new Set(['read-only', 'workspace-write'])

/**
 * 判断某个 (platform, policyMode, dialect) 组合是否可用。
 *
 * @param {{platform?:string, policyMode?:string, dialect:string}} input
 * @returns {{supported:true} | {supported:false, code:string, detail:string, alternatives:string[]}}
 */
export function shellCapability({ platform = process.platform, policyMode, dialect }) {
  const confined = CONFINED_MODES.has(policyMode)

  if (dialect === 'bash' && platform === 'win32' && confined) {
    return {
      supported: false,
      code: 'SHELL_UNSUPPORTED_IN_CONFINED_WINDOWS',
      detail:
        `the "bash" dialect cannot run under the Windows ACL sandbox in "${policyMode}" mode: ` +
        'Git Bash is a Cygwin/MSYS2 program and needs a signal pipe at startup, which a restricted ' +
        'token cannot create ("couldn\'t create signal pipe, Win32 error 5"). The shell would exit ' +
        'with 127 before running anything.',
      alternatives: [
        'use shellDialect: pwsh (PowerShell 7 runs correctly under the ACL runner)',
        'or run this session with the danger-full-access policy, which does not go through the ACL runner',
      ],
    }
  }

  if (dialect === 'pwsh' && platform !== 'win32') {
    return {
      supported: false,
      code: 'SHELL_UNSUPPORTED_ON_PLATFORM',
      detail: `the "pwsh" dialect requires PowerShell 7, which this provider only expects on win32 (current platform: ${platform})`,
      alternatives: ['use shellDialect: bash on this platform'],
    }
  }

  return { supported: true }
}

/**
 * 断言该组合可用，否则抛**可操作**的错误（含替代方案）。
 *
 * 刻意不提供任何自动降级：审阅明确裁定，插件不得因沙箱/能力失败改用别的执行路径
 * （那会把沙箱故障变成提权路径）。要不受限执行，只能由上游把 policy 解析为
 * `danger-full-access`。
 *
 * @param {{platform?:string, policyMode?:string, dialect:string}} input
 */
export function assertShellSupported(input) {
  const verdict = shellCapability(input)
  if (verdict.supported === true) return
  const alternatives = verdict.alternatives.map((line) => `  - ${line}`).join('\n')
  throw new Error(`background-terminal: ${verdict.code}: ${verdict.detail}\n${alternatives}`)
}

/**
 * 校验调用方给出的 cwd 与 sandbox policy 一致（FINAL.md §6.4）。
 * 超出 policy workspace 范围即拒绝，而不是静默夹进去。
 * @param {string|undefined} cwd
 * @param {{workspaceRoot?:string}} policy
 * @param {string|undefined} sessionCwd
 * @returns {string}
 */
export function resolveCwd(cwd, policy, sessionCwd) {
  if (cwd === undefined || cwd.length === 0) {
    const base = sessionCwd ?? policy.workspaceRoot
    if (base === undefined) throw new Error('background-terminal: no cwd available (session has none and policy has no workspaceRoot)')
    return base
  }
  if (policy.mode === 'danger-full-access') return cwd
  const root = policy.workspaceRoot
  if (root === undefined) {
    throw new Error(`background-terminal: cwd "${cwd}" cannot be validated against sandbox mode "${policy.mode}" (policy has no workspaceRoot)`)
  }
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const target = norm(cwd)
  const base = norm(root)
  if (target !== base && !target.startsWith(`${base}/`)) {
    throw new Error(`background-terminal: cwd "${cwd}" is outside the sandbox workspace "${root}" for mode "${policy.mode}"; refusing rather than silently narrowing it`)
  }
  return cwd
}
