/**
 * `terminal_state` 冷测试（lib/session-state.mjs + lib/index.js 的工具接线）。
 *
 * 全冷：假 PTY、假 jobs、假 ctx —— 不创建真实进程、不联网、不碰文件系统。
 * 集成用例一律显式 `ptyBackend: 'host'`：产品默认后端是 `node-pty`（直连真 PTY），
 * 在受限沙箱下必然 EPERM，那不是这些用例要测的东西。
 *
 * 语义纪律的两条硬断言（本文件的重点）：
 *   - `enforcement` **如实**上报：经 confine 才是 confined，直连/danger-full-access 必须
 *     报 unconfined —— 防的就是"假称有沙箱"；
 *   - 快照是**只读投影**：调用前后记录（含键集合）逐字段不变，读取游标也不被推进。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ENFORCEMENT, SESSION_STATE_FIELDS, commandStateTrustworthyOf, enforcementOf, outputFinalOf, snapshotSession, snapshotSessions, unreadBytesOf } from '../lib/session-state.mjs'
import { apply } from '../lib/index.js'
import { makeFakePty, makeFakeSpawn, makeOwnerCtx } from './helpers/fake-ctx.mjs'
import { READY_BEACON } from '../lib/shell-bash.mjs'

const SHELL = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 引用型轮询：不让事件循环提前空掉（unref 定时器的坑）。 */
async function until(predicate, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return true
    await sleep(5)
  }
  return predicate()
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数：字段表 / 时间字段 / enforcement / 只读
// ─────────────────────────────────────────────────────────────────────────────

test('S1 快照字段表完整且类型正确（只读投影，不多不少）', () => {
  const record = {
    id: 'term-1',
    jobId: 'terminal-7',
    phase: 'exited',
    handle: { pid: 4242 },
    publishedAt: 1_000,
    outputBytes: 45_200,
    lastOutputAt: 1_600,
    ready: true,
    pendingWrites: [{ text: 'a' }, { text: 'b' }],
    terminal: { exitCode: 3, signal: null, detail: 'exit code 3' },
    // 命令级：本记录没有未闭合的帧，且上一条命令结束于 t=1_800（自然跑完）
    lastCommand: { seq: 0, exitCode: 0, at: 1_800, endReason: 'natural' },
    enforcement: 'confined',
    shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    shellFlavor: 'pwsh-7',
  }
  const snapshot = snapshotSession(record, { now: () => 2_000 })

  assert.deepEqual(Object.keys(snapshot), [...SESSION_STATE_FIELDS], '字段表即契约')
  assert.deepEqual(SESSION_STATE_FIELDS.slice(-2), ['unreadBytes', 'outputFinal'], '两个读侧字段的追加顺序即契约')
  assert.deepEqual(snapshot, {
    sessionId: 'term-1',
    jobId: 'terminal-7',
    phase: 'exited',
    pid: 4242,
    elapsedMs: 1_000,
    outputBytes: 45_200,
    lastOutputAgoMs: 400,
    ready: true,
    exitCode: 3,
    commandRunning: false,
    lastCommandExitCode: 0,
    lastCommandAgoMs: 200,
    detail: 'exit code 3',
    pendingWrites: 2,
    enforcement: 'confined',
    shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    shellFlavor: 'pwsh-7',
    lastCommandEndReason: 'natural',
    interrupt: null,
    commandStateTrustworthy: true,
    unreadBytes: null, // 本记录没有 pump：剩余量没有观测值，不写 0
    outputFinal: true, // 已落定且无 pump：确实不会再有输出
  })
})

test('S1b 命令级字段：未发出过命令 → null；有未闭合的帧 → commandRunning=true', () => {
  // 会话级 `exitCode` 与命令级 `lastCommandExitCode` 是两件事：持久 shell 的
  // `phase` 长期停在 `running`，所以"我那条命令跑完了吗"只能靠命令级字段回答。
  const fresh = snapshotSession({ id: 't', phase: 'running', publishedAt: 1_000 }, { now: () => 1_500 })
  assert.equal(fresh.commandRunning, false, '没发出过命令 → 没有未闭合的帧')
  assert.equal(fresh.lastCommandExitCode, null, '没跑完过命令 → null（不写 0 假装成功）')
  assert.equal(fresh.lastCommandAgoMs, null)

  const inFlight = snapshotSession(
    { id: 't', phase: 'running', publishedAt: 1_000, pendingFrame: { start: 'S', end: 'E' } },
    { now: () => 1_500 },
  )
  assert.equal(inFlight.commandRunning, true, '帧已发出未闭合 → 命令仍在跑')
  assert.equal(inFlight.lastCommandExitCode, null, '还在跑时不得报上一条的退出码')
})

test('S1c 负退出码必须原样上报（Windows Ctrl+C = -1073741510）', () => {
  // 真机实测：Ctrl+C 中断 `node` 后 `$LASTEXITCODE` 是负数
  // （`-1073741510` = `0xC000013A` = STATUS_CONTROL_C_EXIT）。
  // 会话级与命令级**两个**退出码字段都必须能表示它——只要有任何一处按"非负"过滤，
  // 调用方就会看到一个 null 而不是真实退出码（比报错更难查）。
  const record = {
    id: 't',
    phase: 'killed',
    publishedAt: 1_000,
    terminal: { exitCode: -1073741510, signal: null, detail: 'signal INT' },
    lastCommand: { seq: 0, exitCode: -1073741510, at: 1_800 },
  }
  const snapshot = snapshotSession(record, { now: () => 2_000 })
  assert.equal(snapshot.exitCode, -1073741510, '会话级退出码不得被"非负"过滤吞掉')
  assert.equal(snapshot.lastCommandExitCode, -1073741510, '命令级退出码不得被"非负"过滤吞掉')
  assert.equal(snapshot.commandRunning, false)
  // 正数路径不受影响
  const positive = snapshotSession({ id: 't', phase: 'exited', terminal: { exitCode: 3 } }, { now: () => 1 })
  assert.equal(positive.exitCode, 3)
})

// ─────────────────────────────────────────────────────────────────────────────
// 中断事实投影（P0-INT-1）
//
// SIGINT 打断的是整行，行尾的结束标记一并没执行 → 帧永不闭合 → `commandRunning` 永久停在
// true。快照**不改**这个观测事实（改了就是另起一套推断），而是把「中断了」一并交出去，
// 让调用方自己看出此刻那个字段不可信。
// ─────────────────────────────────────────────────────────────────────────────

/** 一份「SIGINT 已送达、尚未验证」的命令记录：帧还挂着，中断停在 delivered。 */
function interruptedRecord(overrides = {}) {
  return {
    id: 'term-int',
    phase: 'running',
    publishedAt: 1_000,
    pendingFrame: { start: 'S', end: 'E' },
    lastCommand: { seq: 0, exitCode: 0, at: 1_800, endReason: 'interrupt' },
    interrupt: {
      id: 'intr-1',
      state: 'delivered',
      requestedAt: 2_000,
      deliveredAt: 2_010,
      verifiedAt: null,
      evidence: { sessionSide: null, externalSide: null },
      detail: null,
    },
    ...overrides,
  }
}

test('S1d 中断事实三字段如实投影：帧未闭合 + 中断未验证 → commandStateTrustworthy=false', () => {
  const snapshot = snapshotSession(interruptedRecord(), { now: () => 3_000 })

  assert.deepEqual(Object.keys(snapshot.interrupt), ['id', 'state', 'requestedAt', 'deliveredAt', 'verifiedAt', 'evidence', 'detail'], '中断投影的键集即契约')
  assert.deepEqual(snapshot.interrupt, {
    id: 'intr-1',
    state: 'delivered',
    requestedAt: 2_000,
    deliveredAt: 2_010,
    verifiedAt: null,
    evidence: { sessionSide: null, externalSide: null },
    detail: null,
  })
  assert.equal(snapshot.lastCommandEndReason, 'interrupt')
  assert.equal(snapshot.commandRunning, true, '不得篡改观测事实：帧确实没闭合')
  assert.equal(snapshot.commandStateTrustworthy, false, '这才是 P0 要交付的信号：那个值此刻不可信')

  // 缺观测写 null，不编造
  const bare = snapshotSession({ id: 't', phase: 'running', publishedAt: 1_000 }, { now: () => 1_500 })
  assert.equal(bare.interrupt, null, '从未中断 → null，而不是六个字段全 null 的空壳')
  assert.equal(bare.lastCommandEndReason, null)
  assert.equal(bare.commandStateTrustworthy, true, '没有中断事实 → 帧推断照旧可信')

  // 自然结束：有 endReason、无 interrupt
  const natural = snapshotSession(
    { id: 't', phase: 'running', publishedAt: 1_000, lastCommand: { seq: 0, exitCode: 0, at: 1_800, endReason: 'natural' } },
    { now: () => 2_000 },
  )
  assert.equal(natural.lastCommandEndReason, 'natural')
  assert.equal(natural.interrupt, null)
  assert.equal(natural.commandStateTrustworthy, true)
})

test('S1e commandStateTrustworthy 规则矩阵：中断轴（帧 + 未验证的 delivered/verifying/interrupt-pending）', () => {
  const base = interruptedRecord().interrupt
  const withState = (state, overrides) => snapshotSession(
    interruptedRecord({ interrupt: { ...base, state }, ...overrides }),
    { now: () => 3_000 },
  )

  // 三个未验证取值：帧已失效，由它推出的 commandRunning 不可信
  for (const state of ['delivered', 'verifying', 'interrupt-pending']) {
    assert.equal(withState(state).commandStateTrustworthy, false, state + '：未验证 → 不可信')
  }

  // interrupted 已被新帧证明打断（帧换过一条）、failed 连 SIGINT 都没送达（帧可能真的在跑）
  for (const state of ['interrupted', 'failed']) {
    assert.equal(withState(state).commandStateTrustworthy, true, state + '：不降级')
  }

  // 读不懂的 state 按可信处理：前向兼容，不把没见过的取值当成坏消息
  assert.equal(withState('something-new').commandStateTrustworthy, true)

  // 没有未闭合的帧 → 根本没有由帧推出的值 → 无从失真
  const noFrame = withState('delivered', { pendingFrame: undefined })
  assert.equal(noFrame.commandRunning, false)
  assert.equal(noFrame.commandStateTrustworthy, true, '降级的对象是「帧推断」，没有帧就没有这个推断')

  // 中断记录缺失或形态不符 → 不降级（也不谎报有中断）
  assert.equal(snapshotSession(interruptedRecord({ interrupt: undefined }), { now: () => 3_000 }).commandStateTrustworthy, true)
  assert.equal(snapshotSession(interruptedRecord({ interrupt: null }), { now: () => 3_000 }).commandStateTrustworthy, true)
})

test('S1l commandStateTrustworthyOf 真值表：帧 × 中断态 × phase 三个轴', () => {
  const frame = { start: 'S', end: 'E' }

  // 轴 1：没有未闭合的帧 → 一律可信（根本没有「由帧推出的值」这个对象）
  for (const phase of ['running', 'exited', 'killed', 'failed', 'cleanup-failed']) {
    assert.equal(commandStateTrustworthyOf({ phase }, undefined, null), true, phase + '：无帧 → 可信')
    assert.equal(commandStateTrustworthyOf({ phase }, undefined, { state: 'delivered' }), true, phase + '：无帧时中断也不改变这一点')
  }

  // 轴 2：中断未验证（触发条件 a，P0 已有）——只由 state 决定，与 phase 无关
  for (const state of ['delivered', 'verifying', 'interrupt-pending']) {
    assert.equal(commandStateTrustworthyOf({ phase: 'running' }, frame, { state }), false, state + ' → 不可信')
  }
  // 注意 'interrupted' 在本实现里**不可达**（会话侧确认通道实测是死代码、已删除）：
  // 这条断言只证「其余 → true」这个默认分支与词表兼容性，不证该状态会被产出。
  for (const state of ['interrupted', 'failed', 'requested', 'weird-state']) {
    assert.equal(commandStateTrustworthyOf({ phase: 'running' }, frame, { state }), true, state + ' → 仍可信')
  }
  assert.equal(commandStateTrustworthyOf({ phase: 'running' }, frame, null), true, '没有中断 → 可信')

  // 轴 3：会话已确认进程不在（触发条件 b，本次新增）——与中断毫无关系
  for (const phase of ['exited', 'killed', 'failed']) {
    assert.equal(commandStateTrustworthyOf({ phase }, frame, null), false, phase + '：进程已确认不在而帧还开着 → 帧永不闭合 → 不可信')
  }
  // 两个条件是「或」：b 成立即降级，不需要 a
  assert.equal(commandStateTrustworthyOf({ phase: 'killed' }, frame, { state: 'failed' }), false, 'b 单独成立也降级')
  assert.equal(commandStateTrustworthyOf({ phase: 'running' }, frame, { state: 'delivered' }), false, 'a 单独成立也降级')

  // 形态垃圾不毁函数：phase 取不到 → 不在 DEAD_PHASES → 可信（缺省方向是不做有罪推定）
  assert.equal(commandStateTrustworthyOf(undefined, frame, null), true)
  assert.equal(commandStateTrustworthyOf({ get phase() { throw new Error('hostile') } }, frame, null), true)
})

test('S1m cleanup-failed 必须留在可信侧：两个 phase 集合不得合并', () => {
  // cleanup-failed 的语义是「清理没做成，**进程可能还在**」——此时命令真有可能仍在运行，
  // 把它的帧判成不可信是**反向谎报**，比漏报更糟。它与 SETTLED_PHASES 只差这一项，
  // 但两个集合回答的是不同问题：一个问「可以读结论了吗」，一个问「进程还可能在吗」。
  // 谁把 DEAD_PHASES 写成 SETTLED_PHASES（或顺手合并），这条就会红。
  const frame = { start: 'S', end: 'E' }
  assert.equal(commandStateTrustworthyOf({ phase: 'cleanup-failed' }, frame, null), true, 'cleanup-failed + 帧仍开着 → 可信')
  assert.equal(commandStateTrustworthyOf({ phase: 'cleanup-failed' }, frame, { state: 'failed' }), true, '中断没送达也不降级')

  // 快照走同一判断：只换 phase 就换结论，证明判据真的读了 phase（不是恒真/恒假）
  const at = { now: () => 1 }
  const cleanupFailed = snapshotSession({ id: 't', phase: 'cleanup-failed', pendingFrame: frame }, at)
  const exited = snapshotSession({ id: 't', phase: 'exited', pendingFrame: frame }, at)
  assert.equal(cleanupFailed.commandRunning, true)
  assert.equal(exited.commandRunning, true, '两种 phase 下帧都没闭合，commandRunning 都是 true')
  assert.equal(cleanupFailed.commandStateTrustworthy, true, '只有 cleanup-failed 这个「进程可能还在」的情况仍算可信')
  assert.equal(exited.commandStateTrustworthy, false)
})

test('S1o lastCommand 只在帧闭合后才写入：第一条命令在途期间它是空的', () => {
  // lastCommand 描述的是**上一条已闭合**的命令。第一条命令还在跑时它什么都还没有——
  // 这正是调用方不能拿它当「当前命令状态」的原因（也没有别的字段能替代；曾经引入的
  // commandGeneration 因在一会话一帧命令的模型下恒为 1，已撤销）。
  const inFlight = snapshotSession(
    { id: 't', phase: 'running', pendingFrame: { start: 'S', end: 'E' } },
    { now: () => 1_000 },
  )
  assert.equal(inFlight.lastCommandExitCode, null, '没有已闭合的命令 → 命令级退出码仍是 null')
  assert.equal(inFlight.lastCommandAgoMs, null)
  assert.equal(inFlight.lastCommandEndReason, null)
  assert.equal(inFlight.commandRunning, true)

  // 上一条（seq=2）已闭合、当前那条仍在跑：命令级字段描述前者，与后者无关
  const mixed = snapshotSession(
    {
      id: 't',
      phase: 'running',
      pendingFrame: { start: 'S', end: 'E' },
      lastCommand: { seq: 2, exitCode: 0, at: 1_800, endReason: 'natural' },
    },
    { now: () => 2_000 },
  )
  assert.equal(mixed.lastCommandExitCode, 0, 'lastCommand 描述上一条已闭合的命令')
  assert.equal(mixed.lastCommandAgoMs, 200)
  assert.equal(mixed.commandRunning, true, '而当前那条仍在跑')
})


test('S1f 中断投影是值不是引用：改快照绝不回到 record', () => {
  const record = interruptedRecord()
  const keysBefore = Object.keys(record.interrupt).sort()
  const jsonBefore = JSON.stringify(record)
  const snapshot = snapshotSession(record, { now: () => 3_000 })

  assert.notEqual(snapshot.interrupt, record.interrupt, '必须逐字段拷贝出新对象')
  assert.notEqual(snapshot.interrupt.evidence, record.interrupt.evidence, '嵌套的 evidence 同样不得共享引用')

  snapshot.interrupt.state = 'interrupted'
  snapshot.interrupt.evidence.sessionSide = true
  assert.equal(record.interrupt.state, 'delivered', '改快照不得动到 record')
  assert.equal(record.interrupt.evidence.sessionSide, null)
  assert.deepEqual(Object.keys(record.interrupt).sort(), keysBefore, '不得往 record.interrupt 上加字段')
  assert.equal(JSON.stringify(record), jsonBefore, '投影前后 record 逐字节不变')
})

test('S1g 中断字段垃圾形态/取值器抛错 → 该字段 null，不毁掉整份快照也不编造', () => {
  const hostile = {
    id: 't',
    phase: 'running',
    publishedAt: 1_000,
    pendingFrame: { start: 'S', end: 'E' },
    interrupt: {
      id: 42, // 不是字符串
      state: 'delivered',
      requestedAt: Number.NaN,
      deliveredAt: -5, // 负的 epoch 不是观测到的时刻
      get verifiedAt() { throw new Error('hostile') },
      evidence: { sessionSide: 'yes' }, // 不是布尔
    },
  }
  const snapshot = snapshotSession(hostile, { now: () => 2_000 })
  assert.equal(snapshot.interrupt.id, null)
  assert.equal(snapshot.interrupt.requestedAt, null)
  assert.equal(snapshot.interrupt.deliveredAt, null)
  assert.equal(snapshot.interrupt.verifiedAt, null, '取值器抛错只让该字段变 null')
  assert.deepEqual(snapshot.interrupt.evidence, { sessionSide: null, externalSide: null })
  assert.equal(snapshot.interrupt.detail, null, '没有理由 → null，不编造')
  assert.equal(snapshot.commandStateTrustworthy, false, 'state 仍读到了 delivered → 规则照旧生效')
  assert.equal(snapshot.phase, 'running', '一个字段坏掉不得毁掉整份快照')

  // 整块形态不符 → null（不返回一个看着像中断的空壳）
  for (const bogus of ['delivered', 0, true, null, undefined]) {
    assert.equal(snapshotSession({ id: 't', interrupt: bogus }, { now: () => 1 }).interrupt, null)
  }

  // evidence 如实拷贝：写入方恒写 null，投影只转述，既不伪造也不抹掉记录里的值
  const declared = snapshotSession(
    interruptedRecord({ interrupt: { ...interruptedRecord().interrupt, evidence: { sessionSide: true, externalSide: true } } }),
    { now: () => 3_000 },
  )
  assert.equal(declared.interrupt.evidence.externalSide, true, '投影不替写入方下结论')
})

test('S1h 中断失败必须带得出理由（P0-INT-1a）：detail 原样投影', () => {
  // state='failed' 却不给理由 = 「说了等于没说」；这正是本 P0 要消灭的那种上报。
  const failed = snapshotSession(
    interruptedRecord({
      interrupt: {
        ...interruptedRecord().interrupt,
        state: 'failed',
        detail: 'signal delivery failed: write EIO',
      },
    }),
    { now: () => 3_000 },
  )
  assert.equal(failed.interrupt.state, 'failed')
  assert.equal(failed.interrupt.detail, 'signal delivery failed: write EIO', '理由必须原样带到调用方')
  assert.equal(failed.commandStateTrustworthy, true, 'failed 不降级：信号没送达，帧仍可能真的在跑')

  // 形如对象的理由串（如 Error.message）不走 toString 猜测：非字符串一律 null
  const weird = snapshotSession(
    interruptedRecord({ interrupt: { ...interruptedRecord().interrupt, detail: { message: 'x' } } }),
    { now: () => 3_000 },
  )
  assert.equal(weird.interrupt.detail, null)
})

// ─────────────────────────────────────────────────────────────────────────────
// 读侧判据（P1-READ-1）：流终结了没有、还剩多少没读
//
// 必须由投影层导出单一来源：调用方过去拿 outputBytes 减 nextCursor 估剩余量，
// 而这两个数口径不同（会话累计写入量 vs 游标位置），算出来的「还剩多少」是错的（ST-03）。
// ─────────────────────────────────────────────────────────────────────────────

test('S1i outputFinalOf 真值表：phase 已落定 + 输出真结束，才敢说「读全了」', () => {
  for (const phase of ['exited', 'killed', 'failed', 'cleanup-failed']) {
    assert.equal(outputFinalOf({ phase }), true, phase + '：无 pump 且已落定 → 不会再产出输出')
    assert.equal(outputFinalOf({ phase, outputEnded: true, pump: { totalBytes: () => 0 } }), true)
    assert.equal(outputFinalOf({ phase, outputEnded: false, pump: { totalBytes: () => 0 } }), false, phase + '：pump 还在且没结束 → 没读全')
    assert.equal(outputFinalOf({ phase, pump: { totalBytes: () => 0 } }), false, phase + '：outputEnded 未置 → 不敢声称读全')
  }

  // 未落定：哪怕 PTY 的 end 事件已到也不算终局，phase 才是会话生死的判据
  assert.equal(outputFinalOf({ phase: 'running', outputEnded: true }), false)
  assert.equal(outputFinalOf({ phase: 'reserved' }), false)
  assert.equal(outputFinalOf({}), false, '什么都没有 → false（缺省方向是「不敢说读全了」）')
  assert.equal(outputFinalOf(undefined), false)

  // 「无 pump」的判定：undefined/null/垃圾值一律当无 pump
  assert.equal(outputFinalOf({ phase: 'exited', pump: null }), true)
  assert.equal(outputFinalOf({ phase: 'exited', pump: 'nope' }), true)
})

test('S1j unreadBytesOf：剩余量的唯一正确来源（clamp / 缺观测 / 坏取值器）', () => {
  const pump = { totalBytes: () => 100 }
  assert.equal(unreadBytesOf({ pump }, { offset: 40 }), 60)
  assert.equal(unreadBytesOf({ pump }, { offset: 100 }), 0, '读平了是 0，不是 null')
  assert.equal(unreadBytesOf({ pump }, { offset: 140 }), 0, '游标超过总量必须 clamp 到 0，不得出负数')
  assert.equal(unreadBytesOf({ pump }, {}), null, 'offset 拿不到 → null（不写 0 假装读完）')
  assert.equal(unreadBytesOf({ pump }, undefined), null)
  assert.equal(unreadBytesOf({}, { offset: 0 }), null, '无 pump → null')
  assert.equal(unreadBytesOf({ pump: null }, { offset: 0 }), null)
  assert.equal(unreadBytesOf({ pump: { totalBytes: () => Number.NaN } }, { offset: 0 }), null)
  assert.equal(unreadBytesOf({ pump: { totalBytes() { throw new Error('hostile') } } }, { offset: 0 }), null, '取值器抛错 → null，不毁调用方')
  assert.equal(unreadBytesOf({ pump }, { get offset() { throw new Error('hostile') } }), null)
})

test('S1k 快照如实投影两个读侧字段，且绝不推进游标、绝不 peek', () => {
  const cursor = { offset: 250 }
  const record = {
    id: 'term-read',
    phase: 'exited',
    publishedAt: 1_000,
    outputEnded: true,
    cursor,
    // peek 会抛：投影层只许统计剩余量，读正文是 terminal_read 的事
    pump: { totalBytes: () => 1_000, peek() { throw new Error('投影层不得 peek') } },
  }
  const keysBefore = Object.keys(record).sort()
  const snapshot = snapshotSession(record, { now: () => 2_000 })
  assert.equal(snapshot.unreadBytes, 750, '1000 - 250')
  assert.equal(snapshot.outputFinal, true)
  assert.equal(cursor.offset, 250, '取快照不得推进读取游标')
  assert.deepEqual(Object.keys(record).sort(), keysBefore, '不得往 record 上写字段')
  assert.deepEqual(cursor, { offset: 250 })

  // 运行中的会话：还有未读、也还没终结
  const running = snapshotSession(
    { id: 't', phase: 'running', cursor: { offset: 0 }, pump: { totalBytes: () => 9 } },
    { now: () => 1 },
  )
  assert.equal(running.unreadBytes, 9)
  assert.equal(running.outputFinal, false)

  // 缺观测：无 pump → null（不是 0），未落定 → outputFinal=false
  const bare = snapshotSession({ id: 't', phase: 'running' }, { now: () => 1 })
  assert.equal(bare.unreadBytes, null)
  assert.equal(bare.outputFinal, false)

  // 单一来源：快照里的值与直接调那对函数逐字相等（index.js 复用同一对，不会漂移）
  assert.equal(snapshot.unreadBytes, unreadBytesOf(record, record.cursor))
  assert.equal(snapshot.outputFinal, outputFinalOf(record))
})

test('S2 elapsedMs / lastOutputAgoMs 随注入时钟精确变化（不是占位值）', () => {
  let clock = 1_000
  const record = { id: 'term-2', phase: 'running', publishedAt: 1_000, outputBytes: 0 }
  const first = snapshotSession(record, { now: () => clock })
  assert.equal(first.elapsedMs, 0, '同一时刻发布：0ms')
  assert.equal(first.lastOutputAgoMs, null, '从未输出 → null（不写 0 假装刚输出过）')

  clock = 1_750
  assert.equal(snapshotSession(record, { now: () => clock }).elapsedMs, 750)

  record.lastOutputAt = 1_500
  const third = snapshotSession(record, { now: () => clock })
  assert.equal(third.elapsedMs, 750)
  assert.equal(third.lastOutputAgoMs, 250)
  assert.equal(third.outputBytes, 0, '0 字节是有效观测（确实什么都没产出），不写成 null')
})

test('S3 未发布的会话：elapsedMs 为 null，而不是伪造一个 0', () => {
  const snapshot = snapshotSession({ id: 'term-3', phase: 'reserved' }, { now: () => 5_000 })
  assert.equal(snapshot.elapsedMs, null)
  assert.equal(snapshot.lastOutputAgoMs, null)
  assert.equal(snapshot.pid, null)
  assert.equal(snapshot.exitCode, null)
  assert.equal(snapshot.ready, false)
})

test('S4 enforcement 如实上报：confined / windows-pty-unconfined / unconfined 与缺省回退', () => {
  assert.equal(enforcementOf({ enforcement: 'confined' }), ENFORCEMENT.CONFINED)
  assert.equal(enforcementOf({ enforcement: 'windows-pty-unconfined' }), ENFORCEMENT.WINDOWS_PTY_UNCONFINED)
  assert.equal(enforcementOf({ enforcement: 'unconfined' }), ENFORCEMENT.UNCONFINED)

  // 缺省回退：只有直接派生（带裸 ptyArgv）才按 windows-pty-unconfined 报，
  // 其余一律 unconfined —— 没有 confine 证据时绝不声称有沙箱。
  assert.equal(enforcementOf({ ptyArgv: ['bash', '-i'] }), ENFORCEMENT.WINDOWS_PTY_UNCONFINED)
  assert.equal(enforcementOf({}), ENFORCEMENT.UNCONFINED)
  assert.equal(enforcementOf(undefined), ENFORCEMENT.UNCONFINED)
  assert.equal(enforcementOf({ enforcement: '' }), ENFORCEMENT.UNCONFINED, '空字符串不是证据')
  assert.equal(enforcementOf({ get enforcement() { throw new Error('hostile') } }), ENFORCEMENT.UNCONFINED)

  // 没有声明时也**绝不能**是 confined
  for (const record of [{}, undefined, { ptyArgv: [] }, { ptyArgv: ['bash'] }]) {
    assert.notEqual(enforcementOf(record), ENFORCEMENT.CONFINED)
  }
})

test('S5 只读：快照不修改记录（含键集合与嵌套结构）', () => {
  const record = {
    id: 'term-5',
    phase: 'running',
    publishedAt: 1_000,
    outputBytes: 12,
    lastOutputAt: 1_200,
    ready: true,
    pendingWrites: [{ text: 'x', bytes: 1 }],
    terminal: { exitCode: null, signal: null, detail: 'starting' },
    enforcement: 'confined',
    handle: { pid: 9 },
    pendingFrame: { start: 'S', end: 'E' },
    lastCommand: { seq: 0, exitCode: 0, at: 1_800, endReason: 'interrupt' },
    interrupt: {
      id: 'intr-2',
      state: 'delivered',
      requestedAt: 2_000,
      deliveredAt: 2_010,
      verifiedAt: null,
      evidence: { sessionSide: null, externalSide: null },
      detail: null,
    },
  }
  const keysBefore = Object.keys(record).sort()
  const jsonBefore = JSON.stringify(record)

  snapshotSession(record, { now: () => 2_000 })
  snapshotSessions([record, record], { now: () => 3_000 })

  assert.deepEqual(Object.keys(record).sort(), keysBefore, '不得往 record 上写任何新字段')
  assert.equal(JSON.stringify(record), jsonBefore, '不得改动任何既有值')
})

// ─────────────────────────────────────────────────────────────────────────────
// 集成：工具签名 / 列表 / 未知会话 / 终态 / enforcement / 只读
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 假 ctx（`ptyBackend: 'host'`）：sandboxPolicy 的模式可切换，用于验证
 * confined 与 unconfined 两种策略下的 enforcement。
 *
 * `startupGraceMs` 压到 40ms：那只影响"发布后还要等多久才判 startup-failed"，
 * 与本文件断言的状态字段无关；用默认的 2000ms 会让每条用例白等两秒。
 */
function mountPlugin(options = {}) {
  const { policyMode = 'workspace-write', ...rawConfig } = options
  const tools = new Map()
  const spawn = makeFakeSpawn()
  const ownerCtxs = new Map()
  let jobSeq = 0
  const policy = { mode: policyMode, workspaceRoot: 'F:/ws' }

  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    subprocess: { spawnTerminal: (spec) => spawn.spawnTerminal(spec) },
    sandboxPolicy: {
      defaultMode: 'workspace-write',
      resolve: () => ({ mode: policy.mode, workspaceRoot: policy.workspaceRoot }),
    },
    sessionProjections: { stateOf: () => policy.mode },
    jobs: {
      start(spec) {
        jobSeq += 1
        const id = `terminal-${jobSeq}`
        const handle = { append() {}, updateProgress() {} }
        const hooks = spec.run(handle)
        hooks.done.then(() => {}, () => {})
        return id
      },
    },
    get: (name) => {
      if (name === 'sandbox') return { provider: 'windows-acl', confine: async (argv) => ({ argv: ['runner', '--', ...argv] }) }
      if (name === 'logger') return { info() {}, warn() {}, error() {}, debug() {} }
      return undefined
    },
  }

  const runtime = apply(ctx, { shellPath: SHELL, shellDialect: 'pwsh', ptyBackend: 'host', startupGraceMs: 40, ...rawConfig })

  function agentFor(id = 'sess-1') {
    let ownerCtx = ownerCtxs.get(id)
    if (ownerCtx === undefined) {
      ownerCtx = makeOwnerCtx({ id, session: { header: { cwd: 'F:/ws' } } })
      ownerCtxs.set(id, ownerCtx)
    }
    return { id, session: { header: { cwd: 'F:/ws' } }, ctx: ownerCtx }
  }

  return {
    tools,
    runtime,
    spawn,
    policy,
    agentFor,
    pty: () => spawn.lastPty,
    record: (owner) => runtime.admission.listForOwner(owner)[0],
    call(name, args, owner) {
      const definition = tools.get(name)
      assert.ok(definition, `工具 ${name} 未注册`)
      // 测试统一注入极短 `waitMs`（产品默认是有界等待 10s；假 PTY 的帧永不闭合）
      const effective = name === 'terminal_exec' ? { waitMs: 1, ...args } : args
      return definition.execute(effective, { agent: owner, signal: undefined })
    },
  }
}

test('S6 工具签名：terminal_state 已注册，sessionId 可选，无提权字段', () => {
  const h = mountPlugin()
  const definition = h.tools.get('terminal_state')
  assert.ok(definition, 'terminal_state 必须注册')
  assert.deepEqual(definition.parameters.required, undefined, 'sessionId 必须可选')
  assert.deepEqual(Object.keys(definition.parameters.properties), ['sessionId'])
  assert.equal(definition.parameters.properties.sandbox_permissions, undefined)
  assert.equal(definition.parameters.properties.justification, undefined)
})

test('S7 单会话快照：running 会话的 pid/ready/elapsedMs/outputBytes/enforcement', async () => {
  const h = mountPlugin()
  const owner = h.agentFor()
  const exec = await h.call('terminal_exec', { command: 'npm run build' }, owner)

  // 未就绪时：ready=false，detail 不暴露（terminal.detail 还是 'starting' 占位）
  const early = await h.call('terminal_state', { sessionId: exec.sessionId }, owner)
  assert.equal(early.sessionId, exec.sessionId)
  assert.equal(early.jobId, exec.jobId)
  assert.equal(early.ready, false)
  assert.equal(early.phase, 'running', 'phase 取自 record.phase')
  assert.equal(early.pid, 4242)
  assert.equal(early.outputBytes, 0)
  assert.equal(early.lastOutputAgoMs, null, '还没有任何输出 → null')
  assert.equal(early.detail, null, '非落定 phase 不暴露 detail（那是占位文本）')
  assert.equal(early.enforcement, ENFORCEMENT.CONFINED, 'host 后端 + workspace-write = 经 confine')

  // 输出 11 字节 → outputBytes 精确增加；lastOutputAgoMs 变成数字
  h.pty().emit('hello world')
  const counted = await until(() => h.record(owner)?.outputBytes === 11)
  assert.ok(counted, '假 PTY 的 11 字节必须进到记录里，否则下面断言的是别的东西')
  const withOutput = await h.call('terminal_state', { sessionId: exec.sessionId }, owner)
  assert.equal(withOutput.outputBytes, 11, 'outputBytes 必须随真实输出变化')
  assert.equal(typeof withOutput.lastOutputAgoMs, 'number')
  assert.ok(withOutput.lastOutputAgoMs >= 0)

  // 就绪后 ready=true
  h.pty().emit(`${READY_BEACON}\r\n`)
  const ready = await until(() => h.record(owner)?.ready === true)
  assert.ok(ready, 'shell 必须就绪，否则本用例断言的是另一个状态')
  const afterReady = await h.call('terminal_state', { sessionId: exec.sessionId }, owner)
  assert.equal(afterReady.ready, true)
  assert.equal(afterReady.detail, null, '仍在运行 → 不暴露 detail')
})

test('S8 不传 sessionId：返回本 agent 的全部会话；别人的会话不得出现', async () => {
  const h = mountPlugin()
  const mine = h.agentFor('sess-mine')
  const other = h.agentFor('sess-other')

  const first = await h.call('terminal_exec', { command: 'npm run build' }, mine)
  const second = await h.call('terminal_exec', { command: 'sleep 1' }, other)

  const list = await h.call('terminal_state', {}, mine)
  assert.ok(Array.isArray(list.sessions), '不传 sessionId 返回快照数组（放在 sessions 字段里）')
  assert.deepEqual(list.sessions.map((s) => s.sessionId), [first.sessionId], '只列本 owner 的会话')
  assert.ok(!list.sessions.some((s) => s.sessionId === second.sessionId), '别人的会话绝不出现在列表里')

  const otherList = await h.call('terminal_state', undefined, other)
  assert.deepEqual(otherList.sessions.map((s) => s.sessionId), [second.sessionId])

  // 空列表不是错误：一个新 agent 自查应当得到空数组
  const fresh = h.agentFor('sess-fresh')
  assert.deepEqual(await h.call('terminal_state', {}, fresh), { sessions: [] })
})

test('S9 未知 sessionId 抛错，不静默返回空', async () => {
  const h = mountPlugin()
  const owner = h.agentFor()
  await assert.rejects(() => h.call('terminal_state', { sessionId: 'term-nope' }, owner), /unknown terminal session/)
  // 别人的 sessionId 同样按"未知"处理（ownership 与 fence 语义一致）
  const other = h.agentFor('sess-other')
  const exec = await h.call('terminal_exec', { command: 'ls' }, other)
  await assert.rejects(() => h.call('terminal_state', { sessionId: exec.sessionId }, owner), /unknown terminal session/)
})

test('S10 终态会话仍可查：phase/exitCode/detail 如实（保留期内）', async () => {
  const h = mountPlugin()
  const owner = h.agentFor()
  const exec = await h.call('terminal_exec', { command: 'false' }, owner)
  h.pty().emit(`${READY_BEACON}\r\n`)
  await until(() => h.record(owner)?.ready === true)

  h.pty().exit(3, null)
  const exited = await until(() => h.record(owner)?.phase === 'exited')
  assert.ok(exited, '自然退出必须走完 finish')

  const snapshot = await h.call('terminal_state', { sessionId: exec.sessionId }, owner)
  assert.equal(snapshot.phase, 'exited')
  assert.equal(snapshot.exitCode, 3)
  assert.ok(String(snapshot.detail).startsWith('exit code 3'), `落定后 detail 才是真结论，实得：${snapshot.detail}`)
  assert.ok(!String(snapshot.detail).includes('starting'), '不得还是占位文本')
  assert.equal(snapshot.ready, true)
  assert.equal(snapshot.enforcement, ENFORCEMENT.CONFINED)

  // 对照：同一份快照函数在运行期不暴露 detail（S7），所以这条断言不是恒真
  const running = snapshotSession({ id: 'x', phase: 'running', terminal: { detail: 'starting' } })
  assert.equal(running.detail, null)
})

test('S11 enforcement 端到端：danger-full-access 必须报 unconfined（防"假称有沙箱"）', async () => {
  const confined = mountPlugin()
  const confinedOwner = confined.agentFor()
  const confinedExec = await confined.call('terminal_exec', { command: 'ls' }, confinedOwner)
  const confinedState = await confined.call('terminal_state', { sessionId: confinedExec.sessionId }, confinedOwner)
  assert.equal(confinedState.enforcement, ENFORCEMENT.CONFINED)
  assert.equal(confined.spawn.spawnCalls[0].argv[0], 'runner', 'confined 会话的 argv 必须经 confine 包装')

  const open = mountPlugin({ policyMode: 'danger-full-access' })
  const openOwner = open.agentFor()
  const openExec = await open.call('terminal_exec', { command: 'ls' }, openOwner)
  const openState = await open.call('terminal_state', { sessionId: openExec.sessionId }, openOwner)
  assert.equal(openState.enforcement, ENFORCEMENT.UNCONFINED, 'danger-full-access 绝不是 confined')
  assert.equal(open.spawn.spawnCalls[0].argv[0], SHELL, 'danger-full-access 不经 confine，argv 是裸 shell')

  // 同一后端、同一代码路径，只有策略不同 → 两个取值必须不同（否则判定是写死的）
  assert.notEqual(confinedState.enforcement, openState.enforcement)
})

test('S12 只读：调用前后记录不变，读取游标也不被推进', async () => {
  const h = mountPlugin()
  const owner = h.agentFor()
  const exec = await h.call('terminal_exec', { command: 'echo hi' }, owner)
  h.pty().emit(`${READY_BEACON}\r\nhello\r\n`)
  await until(() => h.record(owner)?.ready === true)

  const record = h.record(owner)
  const projection = () => ({
    keys: Object.keys(record).sort(),
    phase: record.phase,
    jobId: record.jobId,
    ready: record.ready,
    served: record.served,
    publishedAt: record.publishedAt,
    outputBytes: record.outputBytes,
    lastOutputAt: record.lastOutputAt,
    terminal: { ...record.terminal },
    enforcement: record.enforcement,
    pendingWrites: record.pendingWrites.length,
    pid: record.handle?.pid,
  })
  const before = projection()

  const snapshot = await h.call('terminal_state', { sessionId: exec.sessionId }, owner)
  assert.equal(snapshot.phase, record.phase)

  assert.deepEqual(projection(), before, 'terminal_state 不得修改记录的任何字段（含键集合）')

  // 游标不被推进：先读一次，再取状态，再读一次必须是空的
  const firstRead = await h.call('terminal_read', { sessionId: exec.sessionId }, owner)
  assert.ok(firstRead.text.length > 0, '第一次读必须拿到内容，否则下面的空读是空断言')
  await h.call('terminal_state', { sessionId: exec.sessionId }, owner)
  const secondRead = await h.call('terminal_read', { sessionId: exec.sessionId }, owner)
  assert.equal(secondRead.text, '', 'terminal_state 不得消耗/推进 terminal_read 的游标')

  assert.deepEqual(projection(), before, '整个序列结束后记录仍然不变')
})

test('S13 elapsedMs 随真实时间增长（发布锚点真实可用）', async () => {
  const h = mountPlugin()
  const owner = h.agentFor()
  const exec = await h.call('terminal_exec', { command: 'sleep 100' }, owner)

  const early = await h.call('terminal_state', { sessionId: exec.sessionId }, owner)
  assert.equal(typeof early.elapsedMs, 'number')
  assert.ok(early.elapsedMs >= 0 && early.elapsedMs < 1_000, `刚发布应接近 0，实得 ${early.elapsedMs}`)

  await sleep(40)
  const later = await h.call('terminal_state', { sessionId: exec.sessionId }, owner)
  assert.ok(later.elapsedMs >= 25, `elapsedMs 必须随真实时间增长（≥25ms），实得 ${later.elapsedMs}`)
  assert.ok(later.elapsedMs >= early.elapsedMs)
})

// ─────────────────────────────────────────────────────────────────────────────
// 硬约束：模块不引入外部依赖
// ─────────────────────────────────────────────────────────────────────────────

test('硬约束：session-state.mjs 只 import node:* 与相对路径，不碰 @deepseek-ai/*', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/session-state.mjs', import.meta.url), 'utf8')
  for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
    const specifier = match[1]
    assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `非法依赖 ${specifier}`)
    assert.ok(!specifier.startsWith('@deepseek-ai/'), `不得依赖 ${specifier}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 接线护栏（P1-GEN-1 撤销留下的教训：单元层全绿 ≠ 接线正确）
//
// 曾经有一整轮功能在单元层全绿的情况下是**死的**：没人驱动 terminal_signal 走一遍真实路径，
// 于是没人发现「一个会话只会签发一条带帧命令」——那个等待第二条命令的确认函数永远走不到。
// 下面三条就是为这类错误立的：钉接线、钉模型事实、挡住已撤销的字段回流。
// ─────────────────────────────────────────────────────────────────────────────

test('S14 接线：terminal_signal 的 SIGINT 落到 record.interrupt，快照随之降级', async () => {
  const h = mountPlugin()
  const owner = h.agentFor()
  const exec = await h.call('terminal_exec', { command: 'npm run dev' }, owner)
  h.pty().emit(`${READY_BEACON}\r\n`)
  const ready = await until(() => h.record(owner)?.ready === true)
  assert.ok(ready, 'shell 必须先就绪：未就绪时信号只会被排队（走另一条分支），那样测不到送货')

  // 中断之前：帧开着、没有中断事实，帧推断可信
  const before = await h.call('terminal_state', { sessionId: exec.sessionId }, owner)
  assert.equal(before.commandRunning, true, '命令在跑 → 帧未闭合')
  assert.equal(before.interrupt, null, '还没中断 → 没有中断记录')
  assert.equal(before.commandStateTrustworthy, true)

  const signal = await h.call('terminal_signal', { sessionId: exec.sessionId, signal: 'SIGINT' }, owner)
  assert.equal(signal.delivered, 'SIGINT')
  assert.equal(signal.queued, undefined, '已就绪会话必须当场送货，不得排队')
  assert.equal(signal.interruptId, 'intr-1')
  assert.equal(signal.interruptState, 'delivered')
  assert.equal(signal.interruptDetail, null, '送达成功时没有理由可写')
  assert.deepEqual(h.pty().state.signalCalls, ['SIGINT'], '信号必须真的写进传输层——这才叫接线')

  // record 侧事实：中断**先落地再送货**
  const record = h.record(owner)
  assert.equal(record.interrupt.state, 'delivered')
  assert.equal(record.interrupt.verifiedAt, null, '没人验证过它：不假装验过')
  assert.deepEqual(
    record.interrupt.evidence,
    { sessionSide: null, externalSide: null },
    '进程树/端口不在插件视野内，绝不假装观测到',
  )
  assert.notEqual(record.pendingFrame, undefined, 'SIGINT 打断整行，帧就此永不闭合')

  // 投影侧：本轮真实教训——中断 delivered + 帧未闭合 → 不可信
  const after = await h.call('terminal_state', { sessionId: exec.sessionId }, owner)
  assert.equal(after.commandRunning, true, 'commandRunning 会永久停在 true，这正是它不可信的原因')
  assert.equal(after.commandStateTrustworthy, false, '中断 delivered + 帧未闭合 → 不可信')
  assert.equal(after.lastCommandEndReason, null, '中断路径不是帧自然闭合，因此没有 natural')

  // 会话落定：controller 侧把仍未确认的中断降级为 interrupt-pending
  h.pty().exit(0, null)
  const settled = await until(() => h.record(owner)?.phase === 'exited')
  assert.ok(settled, '会话必须落定，否则测不到降级')
  const settledInterrupt = h.record(owner).interrupt
  assert.equal(settledInterrupt.state, 'interrupt-pending', '落定时仍未确认 → 如实记 pending，不假装停干净了')
  assert.match(String(settledInterrupt.detail), /settled before the interrupt could be verified/)

  const finalState = await h.call('terminal_state', { sessionId: exec.sessionId }, owner)
  assert.equal(finalState.phase, 'exited')
  assert.equal(finalState.interrupt.state, 'interrupt-pending')
  assert.equal(finalState.commandRunning, true, '落定也没让帧闭合')
  assert.equal(finalState.commandStateTrustworthy, false, '落定 + 帧开着：两个触发条件都成立')
})

test('S15 commandGeneration：只在一处递增，且签发路径回显代次', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  const code = source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')

  // 这个字段被撤销过一次：一会话一帧命令时它恒为 1，描述了一条不存在的流程。
  // 现在续签是真实路径（terminal_exec 的 sessionId），它必须**恰好**在一处递增——
  // 两处各算一套的话，调用方就不知道手上的事实属于哪一代。
  const assigns = code.match(/record\.commandGeneration\s*=[^=]/g) ?? []
  assert.equal(assigns.length, 1, '代次只能在签发点（enqueueCommand）递增')
  assert.match(
    code,
    /\(Number\.isSafeInteger\(record\.commandGeneration\) \? record\.commandGeneration : 0\) \+ 1/,
    '必须从 0 起算 +1：首条命令是第 1 代，而不是 0 或 undefined',
  )
  const echoes = code.match(/commandGeneration:/g) ?? []
  assert.ok(echoes.length >= 3, `每条返回路径都要回显代次，实得 ${'${echoes.length}'} 处`)
})

test('S16 续签准入：sessionId 可用，但帧未闭合时必须显式 reset', async () => {
  const { readFile } = await import('node:fs/promises')
  const execTool = mountPlugin().tools.get('terminal_exec')
  assert.equal(execTool.parameters.properties.sessionId?.type, 'string', '续签必须是真实可走的路径')
  assert.equal(execTool.parameters.properties.reset?.type, 'boolean', 'reset 必须可被模型声明')
  assert.deepEqual(execTool.parameters.required, ['command'], '仍只需 command；sessionId 是可选形态')

  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  const code = source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')

  const enqueue = code.match(/\benqueueCommand\s*\(/g) ?? []
  assert.equal(enqueue.length, 3, '一处定义 + 两条签发路径（新建会话的首条命令 / 续签）')

  // 放弃一条没闭合的帧只能发生在**显式 reset** 分支里：否则调用方会以为
  // 自己拿到了上一条命令的退出码，而实际上那条帧永远不会闭合。
  assert.match(code, /stranded && args\?\.reset !== true/, '帧还开着且没有 reset 时必须拒绝')
  assert.match(code, /still has an open command frame/, '拒绝信息必须说清发生了什么')
})

