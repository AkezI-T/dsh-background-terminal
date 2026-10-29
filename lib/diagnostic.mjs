/**
 * 失败诊断：一条会话的启动证据链 + 启动结果判定。
 *
 * 为什么需要它：真机上 PTY 起不来时插件只报 `exit code 127`，**零输出、零线索**——
 * 而 127 是沙箱 runner 自己的失败码（`RUNNER_FAILURE_EXIT`），runner 的 stderr
 * 又没能进 PTY。排查成本极高（docs/bug-reports/BUG-REPORT-001.md 的 B-1）。
 * 这里把「下次失败时定位所需的最小证据集」提前攒好，渲染成一段可直接读的文本，
 * 由控制层挂在 `record.terminal.detail` 尾部——`terminal_read` 因此直接可见。
 *
 * 审阅意见（docs/bug-reports/BUG-REPORT-001-REVIEW.md）直接落在这里的两条：
 *  - R001-06：不把「捕获到的 PTY 尾部」当作唯一证据。诊断必须带**独立字段**
 *    （sessionId / jobId / policyMode / shellDialect / provider / exitCode /
 *    hostErrorId），因为 runner 的错误可能只存在于宿主 stderr。
 *  - R001-02：给出稳定的启动失败表达——`SANDBOX_PTY_START_FAILED` 与
 *    `classifyStartupOutcome()`，供集成层区分
 *    `starting` / `startup-failed` / `running`，不再各自写一套判断。
 *
 * 只观测、只描述：本模块**绝不**触发重试、降级或任何执行动作
 * （审阅明确禁止「捕获 127 后换原始 argv 重启」与「插件级无 confine 逃生开关」）。
 *
 * 三条硬约束（违反即返工）：
 *  1. 只用 `node:*` 与相对 import，不 import 任何 `@deepseek-ai/*`。
 *  2. **永不抛**：诊断跑在失败路径上，自身崩掉会掩盖真故障。每个入口都吞掉异常。
 *  3. **有界**：`render()` 结果默认 ≤ 2000 字符，超出保留头尾 + 中间省略标记；
 *     否则一段畸形 argv 就能把工具返回值撑爆。
 *
 * 证据链按「头段是结构化事实、中段是体积大头、尾段是退出事实与定向提示」排序：
 * 一旦触发有界截断，最需要读的两端正好都留在文本里。
 */

/** 默认边界：整段诊断 ≤ 2000 字符；PTY 输出尾巴最多 300 字符。 */
export const DIAGNOSTIC_LIMITS = Object.freeze({
  maxChars: 2000,
  maxOutputChars: 300,
})

/**
 * 启动失败的稳定错误码。语义：PTY 已被尝试创建，但宿主/runner 明确失败
 * （spawn 拒绝，或 shell 就绪前退出）——**不是** shell 内部的「命令找不到」。
 * R001-02 要求 `terminal_exec` 用 `startup-failed` 表达这一状态；集成层据此判定。
 */
export const SANDBOX_PTY_START_FAILED = 'SANDBOX_PTY_START_FAILED'

/** `classifyStartupOutcome()` 的全部取值（R001-02 的三态）。 */
export const STARTUP_OUTCOMES = Object.freeze(['starting', 'startup-failed', 'running'])

/** 值渲染的递归边界：证据链要可读，不做完整序列化。 */
const MAX_DEPTH = 3
const MAX_ITEMS = 20

/**
 * 从**尾部**保留 len 个字符；切点落在代理对中间时后退一位
 * （否则会产出孤立代理，JSON 里就会出现 `\ud83d` 这种噪音）。
 */
function cutTail(text, len) {
  if (len <= 0) return ''
  const start = text.length - len
  const code = text.charCodeAt(start)
  const from = code >= 0xdc00 && code <= 0xdfff ? start + 1 : start
  return text.slice(from)
}

/** 从**头部**保留 len 个字符；同样避开代理对切点。 */
function cutHead(text, len) {
  if (len <= 0) return ''
  const code = text.charCodeAt(len - 1)
  const cut = code >= 0xd800 && code <= 0xdbff ? len - 1 : len
  return text.slice(0, cut)
}

/** 单值上限（PTY 输出尾巴）：超长就带自己的省略标记截断。 */
function capText(text, limit) {
  if (text.length <= limit) return text
  const marker = `…[+${text.length - limit} chars]`
  return `${cutHead(text, Math.max(0, limit - marker.length))}${marker}`
}

/** 整段上限：保留头尾，中间用一个带计数（近似）的省略标记接起来。 */
export function boundText(text, maxChars) {
  if (typeof text !== 'string' || text.length <= maxChars) return text
  const marker = `\n…[${text.length - maxChars} chars elided]…\n`
  const budget = maxChars - marker.length
  if (budget < 2) return cutHead(text, maxChars)
  const headLen = Math.ceil(budget * 0.6)
  return `${cutHead(text, headLen)}${marker}${cutTail(text, budget - headLen)}`
}

/** 取一句可安全嵌入的安全文本（message / toString 都可能抛）。 */
function safeText(value) {
  try {
    if (value === undefined || value === null) return ''
    if (typeof value === 'string') return value
    return String(value)
  } catch {
    return '<unprintable>'
  }
}

/** 结构化字段的标量渲染：`(none)` 表示未知，其它值不加引号（便于 grep）。 */
function scalarText(value) {
  try {
    if (value === undefined || value === null || value === '') return '(none)'
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
    if (typeof value === 'symbol') return safeText(value)
    if (typeof value === 'function') return `[Function ${safeText(value.name) || 'anonymous'}]`
    return renderValue(value)
  } catch {
    return '(unreadable)'
  }
}

/**
 * 把一个值渲染成可读字符串。
 *
 * 刻意不用 JSON.stringify：它会在循环引用上抛错、把 Error 序列化成 `{}`，
 * 而诊断恰恰在最需要它的异常路径上。
 */
export function renderValue(value, seen = new WeakSet(), depth = 0) {
  try {
    if (value === undefined) return 'undefined'
    if (value === null) return 'null'
    const type = typeof value
    if (type === 'string') return JSON.stringify(value)
    if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value)
    if (type === 'symbol') return safeText(value)
    if (type === 'function') return `[Function ${safeText(value.name) || 'anonymous'}]`
    if (value instanceof Error) {
      const code = value.code === undefined ? '' : ` code=${renderValue(value.code)}`
      return `${safeText(value.name) || 'Error'}${code}: ${safeText(value.message)}`
    }
    if (seen.has(value)) return '[Circular]'
    if (depth >= MAX_DEPTH) return '[…]'
    seen.add(value)
    try {
      if (Array.isArray(value)) {
        const head = value.slice(0, MAX_ITEMS).map((item) => renderValue(item, seen, depth + 1))
        const more = value.length > head.length ? `, …+${value.length - head.length}` : ''
        return `[${head.join(', ')}${more}]`
      }
      const keys = Object.keys(value).slice(0, MAX_ITEMS)
      const body = keys.map((key) => {
        let rendered
        try {
          rendered = renderValue(value[key], seen, depth + 1)
        } catch (error) {
          // 取值器抛错不得让整段诊断消失
          rendered = `<threw: ${safeText(error?.message)}>`
        }
        return `${key}: ${rendered}`
      })
      const more = Object.keys(value).length > keys.length ? ', …' : ''
      return `{${body.join(', ')}${more}}`
    } finally {
      seen.delete(value) // 有向无环图：同一对象在不同分支里各渲染一次
    }
  } catch (error) {
    return `<unprintable: ${safeText(error?.message)}>`
  }
}

/**
 * 127 的定向提示。
 *
 * 127 是沙箱 runner 自己的失败码：runner 的 `main()` 以
 * `.then(…, error => process.exitCode = 127)` 收尾，任何非 RunnerFailure 的异常
 * （受限令牌下无法决定包含模式、`AclSandbox.init()` 失败……）都走这里，
 * 并往 stderr 打 `windows-acl-run: <detail>`。而终端场景下那段 stderr
 * 未必进得了 PTY，于是"127 + 零输出"成了死胡同——这句话就是出口。
 */
export function exitCodeHint(exitCode) {
  if (exitCode !== 127) return undefined
  return (
    'hint: exit code 127 is the sandbox runner\'s own failure code (RUNNER_FAILURE_EXIT), '
    + 'not a command-not-found from your shell — the confined child could not be created and the '
    + 'runner\'s stderr did not reach the PTY. Check the host log for a "windows-acl-run:" line.'
  )
}

/**
 * 启动结果三态判定（R001-02）。
 *
 * 只读 `record` 上的既有事实，不做任何副作用、不抛错：
 *  - `running`         shell 真的开始服役（集成层观察到就绪信标后置 `served`/`ready`）
 *  - `startup-failed`  PTY 已被尝试创建但宿主/runner 明确失败：spawn 拒绝、
 *                      spawn 落定却没有 handle、或 shell 在服役前退出（127 的典型形态）
 *  - `starting`        spawn 还在路上，或已发布但就绪信标未到；调用方继续等
 *
 * 取消（`cancelRequested`）刻意不算启动失败：那是调用方意图，不是宿主拒绝。
 *
 * @param {object} record
 * @returns {'starting'|'startup-failed'|'running'}
 */
export function classifyStartupOutcome(record) {
  try {
    if (record === null || record === undefined) return 'starting'
    if (record.served === true || record.ready === true) return 'running'
    if (record.cancelRequested !== undefined && record.cancelRequested !== null) return 'starting'
    if (record.spawnError !== undefined && record.spawnError !== null) return 'startup-failed'
    const facts = record.facts ?? record
    if (facts.spawnAttempted === true && facts.spawnFinished === true && facts.ptyCreated !== true) {
      return 'startup-failed'
    }
    if (facts.ptyExited === true) return 'startup-failed'
    return 'starting'
  } catch {
    return 'starting'
  }
}

/** 是否经过 confine + policy mode：真机上 argv 是否正确往往是成败分界。 */
function confineLine(entry) {
  const confined = entry.spec?.confined
  const applied = confined === true ? 'applied' : confined === false ? 'skipped' : 'unknown'
  const mode = entry.spec?.policyMode === undefined ? '-' : safeText(entry.spec.policyMode)
  return `confine: ${applied} (policy mode=${mode})`
}

function specLine(entry) {
  const spec = entry.spec
  const parts = []
  if (spec?.cwd !== undefined) parts.push(`cwd=${renderValue(spec.cwd)}`)
  if (spec?.cols !== undefined) parts.push(`cols=${safeText(spec.cols)}`)
  if (spec?.rows !== undefined) parts.push(`rows=${safeText(spec.rows)}`)
  if (spec?.graceMs !== undefined) parts.push(`graceMs=${safeText(spec.graceMs)}`)
  return parts.length === 0 ? undefined : `spec: ${parts.join(' ')}`
}

/** argv 整体渲染（不逐项截断：有界由 boundText 统一负责）。 */
function argvLine(entry) {
  const argv = entry.spec?.argv
  if (argv === undefined) return undefined
  const text = Array.isArray(argv) ? argv.map((item) => renderValue(item)).join(' ') : renderValue(argv)
  return `argv: ${text}`
}

function spawnLine(entry, between) {
  if (entry.spawnError !== undefined) {
    const error = entry.spawnError
    const code = error?.code === undefined || error?.code === null ? '-' : scalarText(error.code)
    const message = error instanceof Error ? safeText(error.message) : scalarText(error)
    const elapsed = between(entry.specAt, entry.spawnFailedAt)
    return `spawn: failed code=${code} message=${JSON.stringify(message)}${elapsed === undefined ? '' : ` elapsed=${elapsed} (spec → failure)`}`
  }
  if (entry.spawnPid !== undefined) {
    // pid 0 / 缺失 = 拿到了 handle 但没有可用的进程号。
    // 真机上正是这个形态（`spawn: ok pid=0` + 127）：说 "ok" 会让人以为子进程起来了，
    // 而实际上它从未运行——诊断的作用就是不制造这种误读。
    const pid = Number(entry.spawnPid)
    if (!Number.isFinite(pid) || pid <= 0) {
      return 'spawn: handle obtained but no pid (the child never reported a process id)'
    }
    return `spawn: ok pid=${safeText(entry.spawnPid)}`
  }
  return 'spawn: not attempted'
}

/**
 * 启动失败的明确表达：R001-02/R001-06 要求「宿主拒绝创建 PTY」这件事
 * 必须写在终态详情里，而不是让读者从 exit code 127 自己推断。
 * 同时申明插件没有做任何补救动作（审阅禁止重试与无 confine 降级）。
 */
function startupLine(entry, classification, exitCode) {
  const failed = classification === 'startup-failed' || entry.spawnError !== undefined || exitCode === 127
  if (!failed) return undefined
  const cause = exitCode === 127
    ? 'the host runner failed and exited with its own failure code 127'
    : entry.spawnError !== undefined
      ? 'the host refused to create the PTY'
      : 'the shell exited before it ever served'
  return `startup: ${SANDBOX_PTY_START_FAILED} — ${cause}. No retry and no unconfined fallback were attempted.`
}

function outputLine(outputTail, limit) {
  if (typeof outputTail !== 'string' || outputTail.length === 0) {
    return 'captured output tail: (none — zero bytes reached the PTY)'
  }
  return `captured output tail (${outputTail.length} chars): ${renderValue(capText(outputTail, limit))}`
}

function exitLine(entry, facts, elapsedOf) {
  const exitCode = typeof facts?.exitCode === 'number' ? facts.exitCode : null
  const signal = typeof facts?.signal === 'string' ? facts.signal : null
  const elapsed = elapsedOf(entry.spawnAt ?? entry.specAt)
  const elapsedText = elapsed === undefined ? '' : ` elapsed=${elapsed} (spawn → exit)`
  if (exitCode === null && signal === null) return 'exit: unknown (no exit facts reported)'
  return `exit: exitCode=${exitCode === null ? 'null' : exitCode} signal=${signal === null ? 'null' : signal}${elapsedText}`
}

/**
 * 建一个诊断器：按 record 累积启动证据链，并可按需渲染成有界文本。
 *
 * 三个写入点（都由控制层/集成层调用，本模块只观察、不参与任何判定）：
 *   - `recordSpec(record, spec)`      confine 之后的 spawn spec
 *   - `recordSpawn(record, outcome)`  spawn 成功（pid）或失败（Error）
 *   - `render(record, facts)`         退出事实（exitCode/signal）与已捕获输出尾部
 *
 * @param {{maxChars?:number, maxOutputChars?:number, now?:() => number}} [options]
 */
export function createDiagnostics(options = {}) {
  const maxChars = Number.isSafeInteger(options.maxChars) && options.maxChars > 0
    ? options.maxChars
    : DIAGNOSTIC_LIMITS.maxChars
  const maxOutputChars = Number.isSafeInteger(options.maxOutputChars) && options.maxOutputChars > 0
    ? options.maxOutputChars
    : DIAGNOSTIC_LIMITS.maxOutputChars
  const now = typeof options.now === 'function' ? options.now : () => Date.now()

  const entries = new WeakMap()

  function keyOf(record) {
    if (record === null || record === undefined) return undefined
    const type = typeof record
    if (type !== 'object' && type !== 'function') return undefined
    return record
  }

  function entryFor(record) {
    const key = keyOf(record)
    if (key === undefined) return undefined
    let entry = entries.get(key)
    if (entry === undefined) {
      entry = { id: key.id }
      entries.set(key, entry)
    }
    return entry
  }

  /** 两个时间点之间的毫秒数；任一未知时返回 undefined（绝不返回负数）。 */
  function between(from, to) {
    if (typeof from !== 'number' || !Number.isFinite(from)) return undefined
    if (typeof to !== 'number' || !Number.isFinite(to)) return undefined
    return `${Math.max(0, Math.round(to - from))}ms`
  }

  /** 从某个时间点到现在的毫秒数；无法计算时返回 undefined。 */
  function elapsedOf(from) {
    return between(from, now())
  }

  /** 记下 confine 之后的 spawn spec（完整 argv、cwd、cols/rows、graceMs、confine 事实）。 */
  function recordSpec(record, spec) {
    try {
      const entry = entryFor(record)
      if (entry === undefined) return
      entry.spec = {
        argv: spec?.argv,
        cwd: spec?.cwd,
        cols: spec?.cols,
        rows: spec?.rows,
        graceMs: spec?.graceMs,
        confined: spec?.confined,
        policyMode: spec?.policyMode,
        shellDialect: spec?.shellDialect,
        provider: spec?.provider,
      }
      entry.specAt = now()
    } catch {
      // 诊断永不抛
    }
  }

  /** 记下 spawn 结果：成功收 pid，失败收 Error 原文（code 由渲染时读出）。 */
  function recordSpawn(record, outcome = {}) {
    try {
      const entry = entryFor(record)
      if (entry === undefined) return
      if (outcome?.error !== undefined && outcome?.error !== null) {
        entry.spawnError = outcome.error
        entry.spawnFailedAt = now()
      } else {
        entry.spawnPid = outcome?.pid
        entry.spawnError = undefined
        entry.spawnAt = now()
      }
    } catch {
      // 诊断永不抛
    }
  }

  /**
   * 结构化字段（R001-06）：这些字段必须独立可取，不能只埋在自由文本里——
   * runner 的原始错误可能只在宿主 stderr，插件侧至少要能给出定位所需的键。
   */
  function describe(record, facts = {}) {
    try {
      const entry = entries.get(keyOf(record)) ?? {}
      return {
        sessionId: entry.id ?? record?.id,
        jobId: record?.jobId,
        policyMode: entry.spec?.policyMode,
        shellDialect: entry.spec?.shellDialect,
        provider: entry.spec?.provider,
        exitCode: typeof facts?.exitCode === 'number' ? facts.exitCode : null,
        signal: typeof facts?.signal === 'string' ? facts.signal : null,
        hostErrorId: hostErrorIdOf(record, entry, facts),
        pid: entry.spawnPid,
        startup: classifyStartupOutcome(record),
        spawnErrorCode: entry.spawnError?.code,
        spawnErrorMessage: entry.spawnError === undefined ? undefined : safeText(entry.spawnError?.message),
      }
    } catch {
      return { sessionId: undefined }
    }
  }

  /** hostErrorId：宿主若返回一次性错误 id，就原样带上；没有就显式写 none。 */
  function hostErrorIdOf(record, entry, facts) {
    try {
      for (const source of [facts?.hostErrorId, record?.hostErrorId, entry?.spawnError?.hostErrorId]) {
        if (source !== undefined && source !== null && source !== '') return source
      }
    } catch {
      // 读不到就是没有
    }
    return undefined
  }

  /**
   * 渲染证据链；没有任何证据时返回 undefined（调用方据此不追加，避免污染正常输出）。
   *
   * @param {object} record
   * @param {{exitCode?:number|null, signal?:string|null, outputTail?:string, hostErrorId?:string}} [facts]
   * @returns {string|undefined}
   */
  function render(record, facts = {}) {
    try {
      const entry = entries.get(keyOf(record))
      if (entry === undefined) return undefined
      const fields = describe(record, facts)
      const classification = fields.startup
      const lines = ['[bgterm diagnostics]']
      // 结构化字段放头部：有界截断永远砍不到它们
      for (const key of ['sessionId', 'jobId', 'policyMode', 'shellDialect', 'provider', 'exitCode', 'hostErrorId']) {
        lines.push(`${key}: ${scalarText(fields[key])}`)
      }
      const startup = startupLine(entry, classification, fields.exitCode)
      if (startup !== undefined) lines.push(startup)
      lines.push(spawnLine(entry, between))
      lines.push(confineLine(entry))
      const spec = specLine(entry)
      if (spec !== undefined) lines.push(spec)
      const argv = argvLine(entry)
      if (argv !== undefined) lines.push(argv)
      lines.push(outputLine(facts?.outputTail, maxOutputChars))
      lines.push(exitLine(entry, facts, elapsedOf))
      const hint = exitCodeHint(fields.exitCode)
      if (hint !== undefined) lines.push(hint)
      return boundText(lines.join('\n'), maxChars)
    } catch (error) {
      // 渲染失败也必须给出可读结果：诊断自己不能成为新的黑盒
      try {
        return boundText(`[bgterm diagnostics] unavailable: ${safeText(error?.message)}`, maxChars)
      } catch {
        return undefined
      }
    }
  }

  return { recordSpec, recordSpawn, describe, render }
}
