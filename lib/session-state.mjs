/**
 * 会话状态快照：把"这个会话现在是什么状态"变成**一次调用就能读到的结构化字段**。
 *
 * 为什么需要：`terminal_read` 只给正文。长任务（构建、下载）要判断
 * "还在跑吗 / 跑完了吗 / 输出到哪了"只能靠读正文去猜——这里把既有的记录字段
 * 投影成快照，让调用方（模型）自己下判断。
 *
 * 语义纪律（本模块最重要的三条约束）：
 *   1. **只读投影**——不修改任何 record 字段、不触发状态转换、不创建也不等待任何东西。
 *      快照函数是纯函数：进出只有入参与返回值。
 *   2. **如实上报执行等级**——`enforcement` 直接读集成层写下的 `record.enforcement`，
 *      绝不因为"看起来应该有沙箱"就写 `confined`（那是"假称有沙箱"）。
 *   3. **没观测到就写 `null`**——不补 0 假装知道（与 progress.mjs 的 `unknown` 同一纪律）。
 *
 * 除投影外，本模块还是两个读侧判据的**单一来源**（P1-READ-1）：`outputFinalOf`（流是否终结）
 * 与 `unreadBytesOf`（还剩多少没读）。`lib/index.js` 必须 import 复用，不得各写一份——
 * 两处各写一份正是「两个字节数对不上」（ST-03）的成因。
 *
 * 硬约束：只用 `node:*` 与相对 import；不 import 任何 `@deepseek-ai/*`。
 */

/** `enforcement` 的全体取值。 */
export const ENFORCEMENT = Object.freeze({
  /** 经 confine（沙箱 runner 包装）派生。 */
  CONFINED: 'confined',
  /** 直连 node-pty：本机唯一可用的路径，但**不受 ACL 沙箱约束**。 */
  WINDOWS_PTY_UNCONFINED: 'windows-pty-unconfined',
  /** policy 解析为 danger-full-access，或根本没有 confine 证据。 */
  UNCONFINED: 'unconfined',
})

/** 快照字段全集（顺序即输出顺序，便于人读）。 */
export const SESSION_STATE_FIELDS = Object.freeze([
  'sessionId',
  'jobId',
  'phase',
  'pid',
  'elapsedMs',
  'outputBytes',
  'lastOutputAgoMs',
  'ready',
  'exitCode',
  'commandRunning',
  'lastCommandExitCode',
  'lastCommandAgoMs',
  'detail',
  'pendingWrites',
  'enforcement',
  // ── 本会话用的是哪个 shell（发现/覆盖的结果，唯一事实来源）──────────────
  'shellPath',
  'shellFlavor',
  // ── 中断事实（P0-INT-1）：让调用方能看出「此刻 commandRunning 不可信」──────
  'lastCommandEndReason',
  'interrupt',
  'commandStateTrustworthy',
  // ── 读侧判据（P1-READ-1）：终结了没有、还剩多少没读 ──────────────────────
  'unreadBytes',
  'outputFinal',
])

/**
 * 已落定的 phase。`cleanup-failed` 也算：读取路径本来就把它当"可以读了"
 * （见 index.js 的 FLUSH_PHASES / viewStatus），此时 `terminal.detail` 才是真结论。
 */
const SETTLED_PHASES = new Set(['exited', 'killed', 'failed', 'cleanup-failed'])

/**
 * 「会话已确认**进程不在**」的 phase 集合（P0-INT-2）。
 *
 * 与上面的 `SETTLED_PHASES` 只差一个取值，但问的是**两个不同的问题**，因此必须是两个集合：
 *   - `SETTLED_PHASES` 问「可以读结论了吗」——`cleanup-failed` 也算，因为此时 `terminal.detail`
 *     才是真结论，读取路径本来就把它当「可以读了」（见 index.js 的 FLUSH_PHASES / viewStatus）；
 *   - `DEAD_PHASES` 问「进程还可能在吗」——`cleanup-failed` **必须排除**：它的语义正是
 *     「清理没做成，**进程可能还在**」（README 已知限制第 7 条 / HANDOVER §7），此时命令真有
 *     可能仍在运行，把它的帧判成「不可信」是反向谎报（比漏报更糟）。
 *
 * 谁要是「顺手」把两个集合合并，就会把 cleanup-failed 静默改坏一次——测试里为此专列一条。
 */
const DEAD_PHASES = new Set(['exited', 'killed', 'failed'])

/**
 * 取值兜底：字段可能缺失，也可能是会抛的取值器。一个字段读不到不得毁掉整份快照。
 * @template T
 * @param {() => T} read
 * @param {T} fallback
 * @returns {T}
 */
function valueOf(read, fallback) {
  try {
    const value = read()
    return value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

/**
 * 非负有限数才算"观测到了"；其余（含 undefined/NaN/Infinity）返回 null。
 * 用于**时长/字节数/pid** 这类按定义非负的量。
 */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * 退出码专用：只要有限整数就采纳，**允许负值**。
 *
 * 不能用 `finiteOrNull`：Windows 上被 Ctrl+C 或其它控制台事件终止的进程，
 * 退出码是**负**值（`-1073741510` = `0xC000013A` = STATUS_CONTROL_C_EXIT）。
 * 按"非负"过滤会把真实退出码静默吞成 null——`commandRunning` 已经正确变 false，
 * 但调用方拿不到退出码，只看到一个空值，比报错更难查。
 */
function exitCodeOrNull(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

/** 字符串专用：非字符串（含 undefined/null/垃圾值）一律 null。 */
function stringOrNull(value) {
  return typeof value === 'string' ? value : null
}

/** 布尔专用：只接受真正的 true/false，「没观测到」与形态不明的值都写 null。 */
function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null
}

/**
 * `record.interrupt` 中仍会让「帧未闭合」这一推断失效的 state。
 *
 * `interrupt-pending`（会话已落定但始终没有新帧证明 SIGINT 生效）同样不可信：
 * 帧既没闭合、也没被证明打断，`commandRunning` 此时只是「没收到结束标记」。
 */
const UNTRUSTED_COMMAND_STATES = new Set(['delivered', 'verifying', 'interrupt-pending'])

/**
 * 中断记录投影：**逐字段拷贝**成新的普通对象，绝不与 record 共享引用。
 *
 * 为什么要拷贝而不是直接返回 `record.interrupt`：快照是只读值，共享引用会让调用方
 * （或它的序列化/改写）动到 record；逐字段取值还让单个字段的取值器抛错时只有该字段
 * 变 null，不毁掉整份快照。
 *
 * 缺观测一律 null：整个 `interrupt` 不存在时是 `null`，而不是「七个字段全 null 的空壳」，
 * 否则调用方分不清「没发生过中断」和「发生了但什么都没观测到」。
 *
 * `detail` 一并转述（P0-INT-1a）：`state="failed"` 若不带理由，调用方只知道「中断没成」
 * 却不知道为什么，正是本 P0 要消灭的「说了等于没说」。
 *
 * `evidence.externalSide` **如实拷贝**：进程树/端口不在插件视野内，写入方（lib/index.js）
 * 恒写 null；投影只转述，既不替它下结论、也不假装观测到。
 *
 * @param {unknown} interrupt
 * @returns {object|null}
 */
function interruptOrNull(interrupt) {
  if (interrupt === null || typeof interrupt !== 'object') return null
  const evidence = valueOf(() => interrupt.evidence, undefined)
  return {
    id: stringOrNull(valueOf(() => interrupt.id, undefined)),
    state: stringOrNull(valueOf(() => interrupt.state, undefined)),
    requestedAt: finiteOrNull(valueOf(() => interrupt.requestedAt, undefined)),
    deliveredAt: finiteOrNull(valueOf(() => interrupt.deliveredAt, undefined)),
    verifiedAt: finiteOrNull(valueOf(() => interrupt.verifiedAt, undefined)),
    evidence: {
      // 三态：true/false 是观测值，undefined/null 是「还没验过」
      sessionSide: booleanOrNull(valueOf(() => evidence?.sessionSide, undefined)),
      externalSide: booleanOrNull(valueOf(() => evidence?.externalSide, undefined)),
    },
    // 中断失败的原因（如写信号进 PTY 时报的错）：字符串直通，缺/坏 → null
    detail: stringOrNull(valueOf(() => interrupt.detail, undefined)),
  }
}

/**
 * 实际执行等级。**只读 record 上的既有事实，不重新推导策略**：
 * 等级由集成层在选好派生方式时写进 `record.enforcement`（唯一判定点）。
 *
 * 缺省回退（老记录/合成记录）也保持同一方向：
 *  - 带 `ptyArgv` = 直连后端选的裸 argv → `windows-pty-unconfined`；
 *  - 其余 → `unconfined`。**没有 confine 证据时绝不声称有沙箱。**
 *
 * @param {object} record
 * @returns {string}
 */
export function enforcementOf(record) {
  const declared = valueOf(() => record?.enforcement, undefined)
  if (typeof declared === 'string' && declared.length > 0) return declared
  if (valueOf(() => record?.ptyArgv, undefined) !== undefined) return ENFORCEMENT.WINDOWS_PTY_UNCONFINED
  return ENFORCEMENT.UNCONFINED
}

/**
 * 取会话的输出缓冲（pump）。取不到可用对象（undefined/null/垃圾值）一律当「无 pump」。
 *
 * 「无 pump」是有意义的真实状态：会话在 spawn 早期就失败时根本没建过 pump，
 * 这种会话不会再产出任何输出（lib/index.js 也以 `record.pump === undefined` 判同一件事）。
 *
 * @param {object} record
 * @returns {object|null}
 */
function pumpOrNull(record) {
  const pump = valueOf(() => record?.pump, undefined)
  return pump !== null && typeof pump === 'object' ? pump : null
}

/**
 * 输出流是否已经**终结**——也就是「读全了没有」这一问的唯一判据（P1-READ-1）。
 *
 * 为什么不能只看 `phase`：持久 shell 的 `phase` 长期停在 `running`，命令却早就结束了；
 * 也不能只看 `outputEnded`：会话可能先落定（killed/failed）而 PTY 的 end 事件还没到。
 * 两个条件都满足才是「不会再有新字节」。
 *
 * 缺省方向是 `false`（不敢声称读全了），唯一例外是无 pump 且 phase 已落定：
 * 那时连缓冲都不存在，确实不会再有输出。
 *
 * @param {object} record
 * @returns {boolean}
 */
export function outputFinalOf(record) {
  const phase = valueOf(() => record?.phase, undefined)
  if (!SETTLED_PHASES.has(phase)) return false
  if (pumpOrNull(record) === null) return true
  return valueOf(() => record?.outputEnded, undefined) === true
}

/**
 * 还有多少**字节**没被读走（P1-READ-1）。
 *
 * 这是「还剩多少」的唯一正确来源：`outputBytes` 是会话累计写入量、`nextCursor` 是游标位置，
 * 两者相减既不等价于剩余量、口径也不一致（ST-03 就是这么来的）。
 *
 * 用 `totalBytes()`（累计写入字节）而不是可解码字节数：多字节字符跨块时 `consume` 会留下
 * 不完整的尾部不消费，此时游标仍落后，那就是「还有没读的」。
 *
 * 游标超过总量（ring 已丢弃旧数据、或偏移口径不一致）clamp 到 0，不报负数。
 * 无 pump → `null`（没这个观测值，不写 0 假装读完了）。
 *
 * @param {object} record
 * @param {{offset:number}} cursor 模型侧读取游标（通常是 `record.cursor`）
 * @returns {number|null}
 */
export function unreadBytesOf(record, cursor) {
  const pump = pumpOrNull(record)
  if (pump === null) return null
  const total = finiteOrNull(valueOf(() => pump.totalBytes(), undefined))
  const offset = finiteOrNull(valueOf(() => cursor?.offset, undefined))
  // 任一观测值拿不到就写 null：宁可说「不知道」，不报一个算出来的假数
  if (total === null || offset === null) return null
  return Math.max(0, total - offset)
}

/**
 * 「`commandRunning` 由帧未闭合推出」这个推断此刻**可不可信**（P0-INT-1 / P0-INT-2）。
 *
 * 帧还开着本身不是问题；问题是有些死法让帧**永不闭合**，于是 `commandRunning` 永久停在 true。
 * 目前有两条这样的路，任一条成立就降级为 false：
 *   (a) 中断未验证——SIGINT 打断的是整行，行尾的结束标记一并没执行；
 *   (b) 会话已确认进程不在（`DEAD_PHASES`）——会话被收掉（close: true）或 shell 崩了，
 *       帧同样永远不会闭合，而这条路跟中断毫无关系。
 *
 * 没有未闭合的帧时一律 true：那时根本没有「由帧推出的值」这个对象，无从失真。
 * (a) 的取值集合是精确枚举，不得夹带其它 state：`interrupted`（已被证实让出前台）与 `failed`（信号压根
 * 没送达）都算帧仍然有效。注意 `interrupted` 在本实现里**不可达** —— 会话侧确认通道
 * （confirmInterruptByNewCommand）实测是死代码、已删除（一个会话只会签发一条带帧命令）；
 * 词表里保留它只是为了完整与前向兼容。读不懂的词表外取值同样走「其余 → true」，不做有罪推定。
 *
 * @param {object} record
 * @param {unknown} pendingFrame record.pendingFrame（undefined = 没有未闭合的帧）
 * @param {object|null} interrupt 已投影的 record.interrupt
 * @returns {boolean}
 */
export function commandStateTrustworthyOf(record, pendingFrame, interrupt) {
  if (pendingFrame === undefined) return true
  if (interrupt !== null && UNTRUSTED_COMMAND_STATES.has(interrupt?.state)) return false
  const phase = valueOf(() => record?.phase, undefined)
  return !DEAD_PHASES.has(phase)
}

/**
 * 单条快照。
 *
 * @param {object} record
 * @param {{now?:() => number}} [options] `now` 可注入：时间字段因此能被确定性测试
 * @returns {object} 见 SESSION_STATE_FIELDS
 */
export function snapshotSession(record, options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const at = finiteOrNull(valueOf(() => now(), NaN)) ?? Date.now()

  const id = valueOf(() => record?.id, undefined)
  const phase = valueOf(() => record?.phase, undefined)
  const publishedAt = finiteOrNull(valueOf(() => record?.publishedAt, undefined))
  const lastOutputAt = finiteOrNull(valueOf(() => record?.lastOutputAt, undefined))
  const outputBytes = finiteOrNull(valueOf(() => record?.outputBytes, undefined))
  const terminal = valueOf(() => record?.terminal, undefined)
  const detail = valueOf(() => terminal?.detail, undefined)
  const lastCommand = valueOf(() => record?.lastCommand, undefined)
  const pendingFrame = valueOf(() => record?.pendingFrame, undefined)
  const interrupt = interruptOrNull(valueOf(() => record?.interrupt, undefined))
  const cursor = valueOf(() => record?.cursor, undefined)
  const unreadBytes = unreadBytesOf(record, cursor)
  const outputFinal = outputFinalOf(record)

  return {
    sessionId: typeof id === 'string' ? id : null,
    jobId: valueOf(() => record?.jobId, undefined) ?? null,
    phase: typeof phase === 'string' ? phase : null,
    pid: finiteOrNull(valueOf(() => record?.handle?.pid, undefined)),
    // 会话**发布**至今：未发布（reserve 后失败）就没有这个观测值
    elapsedMs: publishedAt === null ? null : Math.max(0, Math.round(at - publishedAt)),
    // task-9 在 output data 回调里累加的计数（复用同一份，不另起一套口径）
    outputBytes: outputBytes ?? 0,
    lastOutputAgoMs: lastOutputAt === null ? null : Math.max(0, Math.round(at - lastOutputAt)),
    ready: valueOf(() => record?.ready, false) === true,
    exitCode: exitCodeOrNull(valueOf(() => terminal?.exitCode, undefined)),
    // ── 命令级（与会话级 `exitCode` 是两件事）────────────────────────────────
    //
    // 会话是**持久 shell**，`phase` 长期停在 `running`，所以 `exitCode` 基本用不上；
    // 真正要回答的是"我那条命令跑完了没有、退出码多少"。
    // `commandRunning` 由帧是否闭合决定（`record.pendingFrame` 存在 = 已发出、未闭合）。
    commandRunning: pendingFrame !== undefined,
    lastCommandExitCode: exitCodeOrNull(valueOf(() => lastCommand?.exitCode, undefined)),
    lastCommandAgoMs: (() => {
      const at2 = finiteOrNull(valueOf(() => lastCommand?.at, undefined))
      return at2 === null ? null : Math.max(0, Math.round(at - at2))
    })(),
    detail: SETTLED_PHASES.has(phase) && typeof detail === 'string' ? detail : null,
    pendingWrites: valueOf(() => (Array.isArray(record?.pendingWrites) ? record.pendingWrites.length : 0), 0),
    enforcement: enforcementOf(record),
    shellPath: stringOrNull(valueOf(() => record?.shellPath, undefined)),
    shellFlavor: stringOrNull(valueOf(() => record?.shellFlavor, undefined)),
    // ── 中断事实（P0-INT-1）──────────────────────────────────────────────────
    //
    // SIGINT 打断的是**整行**，行尾的结束标记因此永不执行 —— 中断之后 `commandRunning`
    // 会永久停在 true。这里如实投影中断事实，让调用方自己看出「此时那个值不可信」。
    lastCommandEndReason: stringOrNull(valueOf(() => lastCommand?.endReason, undefined)),
    interrupt,
    // 「这个命令还在跑」是否可信：规则见 commandStateTrustworthyOf（**单一来源**，
    // 不在这里内联第二份——中断未验证 或 会话已确认进程不在，两者都会让帧推断永久失真）。
    commandStateTrustworthy: commandStateTrustworthyOf(record, pendingFrame, interrupt),
    // ── 读侧判据（P1-READ-1）──────────────────────────────────────────────────
    //
    // 两个值都走上面导出的那对纯函数（**单一来源**）：lib/index.js 的 terminal_read
    // 复用同一对，判据因此不可能在两处漂移——「两个字节数对不上」（ST-03）的成因就是各算一份。
    unreadBytes,
    outputFinal,
  }
}

/**
 * 批量快照，保持入参顺序（"我还有个构建在跑"的自查形态）。
 *
 * @param {object[]} records
 * @param {{now?:() => number}} [options]
 * @returns {object[]}
 */
export function snapshotSessions(records, options = {}) {
  if (!Array.isArray(records)) return []
  return records.map((record) => snapshotSession(record, options))
}
