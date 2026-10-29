/**
 * 中断状态投影冷测试（lib/session-state.mjs）。
 *
 * 契约来源：P0-INT-1 冻结契约 + 修订 P0-INT-1a（投影给 interrupt 补 detail，理由：
 * state="failed" 不带理由等于"说了等于没说"）。修订在 17:16 落地，本文件的 I2 按修订后的
 * **七字段**形状钉死；键集合仍然精确——多一个字段这条断言就会红。
 *
 * 本文件测两层：
 *   1) **投影**：给定合成 record，断言快照里三个字段（lastCommandEndReason / interrupt /
 *      commandStateTrustworthy）与契约逐字对齐；
 *   2) **接线**：用假 ctx + 假 PTY 从工具面驱动 terminal_signal 的 SIGINT，断言中断事实**真的
 *      落到 record 上**（I15）。这一层此前没人覆盖（旧测试只直接驱动投影函数与传输层）。
 *      **边界（别高估它）**：它**不是**当初能抓住那条死代码的工具——死代码要的是"第二条带帧命令"，
 *      而那条路径在本模型下不存在，所以有无死代码这条测试都绿。防复发靠的是**结构性护栏**
 *      （一会话只有一个签发点 + tool schema 里没有 sessionId）与**负向墓碑**，见 session-state.test.js 的 S15 / S16。
 *
 * 全冷：纯函数 + 假 PTY（不创建真实进程）、不联网；文本读取只读本仓库自己的源码。
 *
 * P1-GEN-1 已撤销：commandGeneration 与那条死掉的确认路径都删了。**墓碑与模型护栏都不在本文件**——
 * 它们在 session-state.test.js（S15 负向、S16 结构性）；本文件只保留工具面的接线测试 I15，不重复别人的护栏。
 * 同理，"externalSide 恒为 null" 是记录层写入者的纪律（lib/index.js），投影只负责照抄。
 */

import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

import { SESSION_STATE_FIELDS, commandStateTrustworthyOf, snapshotSession } from '../lib/session-state.mjs'
import { apply } from '../lib/index.js'
import { makeFakePty, makeFakeSpawn } from './helpers/fake-ctx.mjs'

/** 注入固定时间，时间字段因此可确定断言。 */
const AT = { now: () => 2_000 }

/**
 * 合成一条 record.interrupt（契约的**记录**形状：比投影多一个 detail）。
 * @param {object} [overrides]
 */
function interruptRecord(overrides = {}) {
  return {
    id: 'intr-1',
    state: 'delivered',
    requestedAt: 1_700,
    deliveredAt: 1_800,
    verifiedAt: null,
    evidence: { sessionSide: null, externalSide: null },
    detail: null,
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 字段表与投影形状
// ─────────────────────────────────────────────────────────────────────────────

test('I1 三个 P0 字段按契约顺序连续出现（绝对末位由 P1 契约钉住）', () => {
  // 字段表的**绝对末位**归 P1 契约管（read-complete.test.js 的 R1 钉住 unreadBytes / outputFinal 在末尾）；
  // 这里只断言 P0 三字段彼此连续且顺序正确——钉绝对位置会被后续追加自伤（本测试已经踩过一次）。
  const at = SESSION_STATE_FIELDS.indexOf('lastCommandEndReason')
  assert.notEqual(at, -1, 'lastCommandEndReason 必须在字段表里')
  assert.deepEqual(
    SESSION_STATE_FIELDS.slice(at, at + 3),
    ['lastCommandEndReason', 'interrupt', 'commandStateTrustworthy'],
    '三个 P0 字段必须连续且按此顺序（不得插在别处、不得被拆开）',
  )
  assert.equal(new Set(SESSION_STATE_FIELDS).size, SESSION_STATE_FIELDS.length, '字段表不得有重复项')
})

test('I2 interrupt 投影：逐字段拷贝契约列出的七个字段（含 P0-INT-1a 的 detail），键集合精确', () => {
  const snapshot = snapshotSession(
    {
      id: 'term-1',
      phase: 'running',
      pendingFrame: { start: 'S', end: 'E' },
      interrupt: interruptRecord({ detail: 'SIGINT 已送达前台进程组 4242' }),
    },
    AT,
  )

  // deepEqual 同时锁住"值正确"与"键集合精确"（不多不少）——多一个或少一个字段都会红。
  assert.deepEqual(
    snapshot.interrupt,
    {
      id: 'intr-1',
      state: 'delivered',
      requestedAt: 1_700,
      deliveredAt: 1_800,
      verifiedAt: null,
      evidence: { sessionSide: null, externalSide: null },
      detail: 'SIGINT 已送达前台进程组 4242',
    },
    '投影形状 = 契约七个字段（六个 + P0-INT-1a 的 detail）',
  )
  // deepEqual 不看键序，而修订明确要求 detail 落在**最后**（人读顺序），单独钉一下。
  assert.deepEqual(
    Object.keys(snapshot.interrupt),
    ['id', 'state', 'requestedAt', 'deliveredAt', 'verifiedAt', 'evidence', 'detail'],
    '键序：detail 必须在最后',
  )

  // detail 的来源是 **record.interrupt.detail**，不是 record 顶层的 detail：
  // 两个位置取不同字符串，投影必须拿到前者——修订前那句
  // 「不得夹带 record.detail」的否命题随修订失效，这里换成正命题守住同一个风险。
  const sourced = snapshotSession(
    {
      id: 'term-1',
      detail: '会话级 detail（不得被 interrupt 投影取走）',
      interrupt: interruptRecord({ detail: '中断级 detail（failInterrupt 写下的理由）' }),
    },
    AT,
  )
  assert.equal(sourced.interrupt.detail, '中断级 detail（failInterrupt 写下的理由）', 'detail 必须来自 record.interrupt.detail')
})

// ─────────────────────────────────────────────────────────────────────────────
// null 纪律与取值透传
// ─────────────────────────────────────────────────────────────────────────────

test('I3 null 纪律：没观测到就写 null——不是 {}、也不是 undefined', () => {
  const bare = snapshotSession({ id: 'term-1', phase: 'running' }, AT)
  assert.equal(bare.interrupt, null, '从未中断过 → null')
  assert.equal(bare.lastCommandEndReason, null, '从未闭合过帧 → null')
  assert.ok(Object.hasOwn(bare, 'interrupt'), '字段必须在（值为 null），不得整体缺省')
  assert.ok(Object.hasOwn(bare, 'lastCommandEndReason'), '字段必须在（值为 null）')

  const explicitUndefined = snapshotSession({ id: 'term-1', interrupt: undefined, lastCommand: { at: 1_900 } }, AT)
  assert.equal(explicitUndefined.interrupt, null, 'undefined 与缺失同义')
  assert.equal(explicitUndefined.lastCommandEndReason, null, 'lastCommand 在但 endReason 缺失 → null')

  const wrongType = snapshotSession({ id: 'term-1', lastCommand: { endReason: 42 } }, AT)
  assert.equal(wrongType.lastCommandEndReason, null, '类型是 string|null，非字符串不得原样透传')

  // detail（P0-INT-1a）：string|null，缺观测一律 null，不编造理由
  const missingDetail = snapshotSession({ id: 'term-1', interrupt: { id: 'intr-1', state: 'failed' } }, AT)
  assert.equal(missingDetail.interrupt.detail, null, 'detail 缺失 → null')

  const badDetail = snapshotSession({ id: 'term-1', interrupt: interruptRecord({ detail: 42 }) }, AT)
  assert.equal(badDetail.interrupt.detail, null, 'interrupt.detail 同样是 string|null，非字符串不得透传')
})

test('I4 lastCommandEndReason 透传两个取值：natural / interrupt', () => {
  for (const endReason of ['natural', 'interrupt']) {
    const snapshot = snapshotSession({ id: 'term-1', lastCommand: { endReason, exitCode: 0, at: 1_900 } }, AT)
    assert.equal(snapshot.lastCommandEndReason, endReason, `endReason=${endReason} 必须原样投影`)
  }

  // 注意区分：endReason 的 "interrupt" = 这条命令因中断而收口；
  // record.interrupt 是那次中断的**事实记录**。两者可以同时存在。
  const both = snapshotSession(
    { id: 'term-1', lastCommand: { endReason: 'interrupt' }, interrupt: interruptRecord({ state: 'interrupted' }) },
    AT,
  )
  assert.equal(both.lastCommandEndReason, 'interrupt')
  assert.equal(both.interrupt.state, 'interrupted')
})

// ─────────────────────────────────────────────────────────────────────────────
// commandStateTrustworthy：真值表
// ─────────────────────────────────────────────────────────────────────────────

test('I5 commandStateTrustworthy 真值表：帧 + 未证实的 delivered/verifying/interrupt-pending 才是 false', () => {
  const frame = { start: 'S', end: 'E' }
  const cases = [
    ['无未闭合帧 + 无 interrupt', {}, true],
    ['无未闭合帧 + delivered', { interrupt: interruptRecord({ state: 'delivered' }) }, true],
    ['有未闭合帧 + 无 interrupt', { pendingFrame: frame }, true],
    ['有未闭合帧 + delivered', { pendingFrame: frame, interrupt: interruptRecord({ state: 'delivered' }) }, false],
    ['有未闭合帧 + verifying', { pendingFrame: frame, interrupt: interruptRecord({ state: 'verifying' }) }, false],
    ['有未闭合帧 + interrupt-pending', { pendingFrame: frame, interrupt: interruptRecord({ state: 'interrupt-pending' }) }, false],
    // 已被下一个帧的开启证实过中断 → 帧再次可信
    ['有未闭合帧 + interrupted', { pendingFrame: frame, interrupt: interruptRecord({ state: 'interrupted' }) }, true],
    // SIGINT 没送达：这条命令的帧仍然有效
    ['有未闭合帧 + failed', { pendingFrame: frame, interrupt: interruptRecord({ state: 'failed' }) }, true],
    // 契约的 false 集合是**精确枚举**，requested 不在其中（还没送达，帧仍有效）
    ['有未闭合帧 + requested', { pendingFrame: frame, interrupt: interruptRecord({ state: 'requested' }) }, true],
    // 词表外取值的字面读法（"其余 → true"）：不是本实现产出的取值，只验证默认分支
    ['有未闭合帧 + 词表外取值', { pendingFrame: frame, interrupt: interruptRecord({ state: 'weird-state' }) }, true],
    // ── P0-INT-2：第二个触发条件 —— 会话被收掉/崩掉时帧同样永不闭合 ──────────────
    ['有未闭合帧 + exited（无中断）', { pendingFrame: frame, phase: 'exited' }, false],
    ['有未闭合帧 + killed（无中断）', { pendingFrame: frame, phase: 'killed' }, false],
    ['有未闭合帧 + failed（无中断）', { pendingFrame: frame, phase: 'failed' }, false],
    // **反例**：cleanup-failed 的语义是"进程可能还在"（README 已知限制 §7 / HANDOVER §7）。
    // 此时命令真有可能仍在跑，把它标成"不可信"是**反向谎报**。
    // 注意它属于 SETTLED_PHASES —— 所以判据必须另立集合，不能直接复用那个。
    ['有未闭合帧 + cleanup-failed（反例：进程可能还在）', { pendingFrame: frame, phase: 'cleanup-failed' }, true],
    // 没有未闭合的帧时，phase 再死也没有"由帧推出的值"可失真
    ['无未闭合帧 + exited', { phase: 'exited' }, true],
  ]

  for (const [label, extra, expected] of cases) {
    const snapshot = snapshotSession({ id: 'term-1', phase: 'running', ...extra }, AT)
    assert.equal(snapshot.commandStateTrustworthy, expected, `${label} → commandStateTrustworthy=${expected}`)
    // 这条新字段的存在理由：commandRunning 由"帧未闭合"推出，而中断打断了整行、
    // 行尾的结束标记永不执行。所以有帧时 commandRunning 必须照旧为 true——
    // 否则这条断言测的就不是"那个不可信的 true"了。
    assert.equal(
      snapshot.commandRunning,
      extra.pendingFrame !== undefined,
      `${label}：commandRunning 仍由帧决定（这正是它不可信的原因）`,
    )
  }
})

test('I6 中断词汇表：六个取值原样投影（含本次不产出的 requested / verifying）', () => {
  const states = ['delivered', 'interrupted', 'interrupt-pending', 'failed', 'requested', 'verifying']
  const projected = states.map(
    (state) => snapshotSession({ id: 'term-1', interrupt: interruptRecord({ state }) }, AT).interrupt.state,
  )
  assert.deepEqual(
    projected,
    states,
    '投影必须只读：不得规范化取值，也不得把前向兼容的 requested / verifying 吞成 null',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// 只读纪律
// ─────────────────────────────────────────────────────────────────────────────

test('I7 只读投影：带 interrupt 的记录投影后逐字段不变（含嵌套对象）', () => {
  const record = {
    id: 'term-1',
    phase: 'running',
    pendingFrame: { start: 'S', end: 'E' },
    interrupt: interruptRecord({ detail: 'watcher: SIGINT delivered' }),
    lastCommand: { endReason: 'natural', exitCode: 0, at: 1_900 },
  }
  const before = JSON.stringify(record)
  const frameBefore = { ...record.pendingFrame }

  snapshotSession(record, AT)

  assert.equal(JSON.stringify(record), before, '投影不得改写记录（含嵌套对象）')
  assert.deepEqual(record.pendingFrame, frameBefore, '帧不得被投影消费')
})

test('I8 commandStateTrustworthyOf 是导出的纯函数，且快照与它同口径（单一来源）', async () => {
  assert.equal(typeof commandStateTrustworthyOf, 'function', '必须从 lib/session-state.mjs 导出')

  // 直接调用的真值表：false 当且仅当「有未闭合帧」且（中断未验证 或 phase 已死）
  const frame = { start: 'S', end: 'E' }
  const direct = [
    ['无帧 + phase 已死', { phase: 'exited' }, undefined, null, true],
    ['有帧 + running', { phase: 'running' }, frame, null, true],
    ['有帧 + exited', { phase: 'exited' }, frame, null, false],
    ['有帧 + killed', { phase: 'killed' }, frame, null, false],
    ['有帧 + failed', { phase: 'failed' }, frame, null, false],
    ['有帧 + cleanup-failed（反例：进程可能还在）', { phase: 'cleanup-failed' }, frame, null, true],
    ['有帧 + delivered', { phase: 'running' }, frame, { state: 'delivered' }, false],
    ['有帧 + verifying', { phase: 'running' }, frame, { state: 'verifying' }, false],
    ['有帧 + interrupt-pending', { phase: 'running' }, frame, { state: 'interrupt-pending' }, false],
    ['有帧 + interrupted', { phase: 'running' }, frame, { state: 'interrupted' }, true],
    ['有帧 + failed（中断没送达）', { phase: 'running' }, frame, { state: 'failed' }, true],
    ['两个条件同时成立', { phase: 'exited' }, frame, { state: 'delivered' }, false],
  ]
  for (const [label, record, pending, interrupt, expected] of direct) {
    assert.equal(commandStateTrustworthyOf(record, pending, interrupt), expected, `${label} → ${expected}`)
  }

  // 快照与直接调用同口径：证明 snapshotSession 复用的就是这份规则（内联第二份会在这里露馅）
  const records = [
    { id: 't1', phase: 'running', pendingFrame: frame },
    { id: 't2', phase: 'exited', pendingFrame: frame },
    { id: 't3', phase: 'killed', pendingFrame: frame },
    { id: 't4', phase: 'cleanup-failed', pendingFrame: frame },
    { id: 't5', phase: 'running', pendingFrame: frame, interrupt: interruptRecord({ state: 'delivered' }) },
    { id: 't6', phase: 'exited', interrupt: interruptRecord({ state: 'delivered' }) },
  ]
  for (const record of records) {
    assert.equal(
      snapshotSession(record, AT).commandStateTrustworthy,
      commandStateTrustworthyOf(record, record.pendingFrame, record.interrupt ?? null),
      `快照的 commandStateTrustworthy 必须与 commandStateTrustworthyOf 同口径（${record.id}）`,
    )
  }

  // 源文本断言（局限）：只证明那个具名函数被导出、且快照调用的是它；
  // 证明不了它是唯一一份计算（别处再算一遍看不出来）。行为级证据是上面的同口径循环。
  const source = await readFile(new URL('../lib/session-state.mjs', import.meta.url), 'utf8')
  assert.match(source, /export function commandStateTrustworthyOf\(/, '必须以具名函数导出')
  assert.match(source, /commandStateTrustworthy:\s*commandStateTrustworthyOf\(/, '快照必须调用它，不得内联第二份')
})

test('I12 P1-HONEST-1 边界：说明面必须写清 natural 不等于「没有人类干预」，并记下 endedBy 不可得', async () => {
  // 局限：这是**源文本**断言（读 lib/index.js 的说明数组），证明不了模型实际看到的文本。
  // 要做成注册态断言得挂载插件——那是 tool-description-contract.test.js 的地盘，不在本轮写作用域内。
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')

  assert.ok(
    [
      /natural[^'`]{0,400}(NOT|never|does not|doesn'?t|is not)[^'`]{0,100}(no human|without human|human (intervention|involvement)|nobody)/i,
      /(no human|human (intervention|involvement)|nobody)[^'`]{0,300}natural/i,
      /natural[^'`]{0,400}(does not|doesn'?t|not)[^'`]{0,60}(mean|imply)[^'`]{0,140}(no|without)[^'`]{0,60}human/i,
    ].some((pattern) => pattern.test(source)),
    '说明面必须写清：natural 只表示「帧自己闭合了」，不等于「没有人干预」',
  )
  assert.ok(
    [/endedBy/i, /human \| host/i].some((pattern) => pattern.test(source)),
    '必须把「endedBy: human|host 插件侧不可得、需调用方/宿主提供」记成一条明确限制，而不是沉默跳过',
  )
})
// ─────────────────────────────────────────────────────────────────────────────
// 接线层（假 PTY）：从工具面驱动 SIGINT
// ─────────────────────────────────────────────────────────────────────────────

const SHELL = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const READY_BEACON = '__DSH_BGTERM_READY__'
const CRLF = '\r\n'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 轮询到条件成立（引用型定时器，别让事件循环提前空掉）。 */
async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(5)
  }
  return predicate()
}

/** 最小假 ctx：只提供注册工具与起步 toolExec 所需的四个服务。 */
function mountRuntime() {
  const tools = new Map()
  const spawn = makeFakeSpawn()
  let jobSeq = 0
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
      resolve: () => ({ mode: 'workspace-write', workspaceRoot: 'F:/ws' }),
    },
    sessionProjections: { stateOf: () => 'workspace-write' },
    jobs: {
      start(spec) {
        jobSeq += 1
        const hooks = spec.run({ append() {}, updateProgress() {} })
        hooks.done?.then(() => {}, () => {})
        return `terminal-${jobSeq}`
      },
    },
    get: (n) => (n === 'sandbox' ? { confine: async (a) => ({ argv: ['runner', '--', ...a] }) } : undefined),
  }
  const runtime = apply(ctx, {
    shellPath: SHELL,
    shellDialect: 'pwsh',
    ptyBackend: 'host',
    startupGraceMs: 30,
    startTimeoutMs: 60,
  })
  const owner = {
    id: 'a1',
    status: 'idle',
    followup() {},
    inject() {},
    ctx: { on() {}, off() {} },
    session: { header: { cwd: 'F:/ws' } },
  }
  const call = (name, args) => tools.get(name).execute(args, { agent: owner })
  return { tools, spawn, runtime, owner, call }
}

test('I15 接线：从工具面驱动 terminal_signal 的 SIGINT，中断事实必须真的落到 record 上', async () => {
  // 从工具面出发：terminal_exec → terminal_signal(SIGINT)，断言中断事实真的落到 record 上。
  // 边界（别高估）：这条**抓不到**那条死掉的确认路径——它要的是"第二条带帧命令"，本模型下不存在，
  // 有无死代码这条测试都绿。它补的是此前没人覆盖的"工具面 → record 落点"这一面。
  const h = mountRuntime()
  const pty = makeFakePty()
  h.spawn.spawnTerminal = async (spec) => {
    h.spawn.spawnCalls.push(spec)
    return pty.handle
  }
  const exec = await h.call('terminal_exec', { command: 'sleep 100', waitMs: 400 })
  assert.equal(exec.status, 'starting', '驱动前提：先拿到会话（未就绪 → starting）')
  pty.emit(READY_BEACON + CRLF)
  assert.ok(await until(() => pty.writeCalls().length >= 2), '驱动前提：信标后首条命令应被写入')

  const signalled = await h.call('terminal_signal', { sessionId: exec.sessionId, signal: 'SIGINT' })

  // ① record 上确实产生了中断事实（不是只测了投影函数）
  const record = h.runtime.admission.listForOwner(h.owner)[0]
  assert.ok(record.interrupt, 'record.interrupt 必须由工具路径写出来')
  assert.equal(record.interrupt.state, 'delivered', '已送达但会话侧尚无证据 → delivered')
  assert.equal(record.interrupt.evidence.sessionSide, null, '还没观测到会话侧证据 → null（不假装）')
  assert.equal(record.interrupt.evidence.externalSide, null, '外部侧恒为 null（不在插件视野内）')

  // ② 同一 record 的快照：帧还开着，但那个 true 不可信
  const state = snapshotSession(record)
  assert.equal(state.commandRunning, true, '帧未闭合 → commandRunning 仍是 true（如实上报）')
  assert.equal(state.commandStateTrustworthy, false, '中断未确认 → 该值此刻不可信')

  // ③ 返回值带上中断身份，模型据此知道"哪次中断、什么状态、为什么"
  assert.equal(signalled.interruptId, record.interrupt.id)
  assert.equal(signalled.interruptState, 'delivered')
  assert.ok(Object.hasOwn(signalled, 'interruptDetail'), '返回里必须带 interruptDetail')
})

