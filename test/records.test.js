/**
 * records.mjs 冷测试：同步预留（§6.3）、事实位（§6.1）、容量（§6.11）、终态保留期 LRU。
 * 不创建进程、不碰文件系统。测试名带验收编号（C1 组）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRecord, createAdmission } from '../lib/records.mjs'
import { dispositionOf } from '../lib/contract.mjs'

const ACTIVE_PHASES = ['reserved', 'spawning', 'running', 'stopping', 'cleanup-failed']
const TERMINAL_PHASES = ['exited', 'killed', 'failed']
const GATE_NAMES = ['startGate', 'outcomeGate', 'spawnSettled', 'cleanupSettled']
const FACT_NAMES = ['spawnAttempted', 'spawnFinished', 'ptyCreated', 'ptyExited']

function makeOwner(id = 'agent-1') {
  return { id, session: { id: `session-${id}` }, ctx: { on: () => () => {} } }
}

function makeAdmission(overrides = {}) {
  return createAdmission({ maxSessionsPerAgent: 4, maxSettledRetainedPerAgent: 4, ...overrides })
}

test('C1a: reserve() 同步返回完整 record（四个 Gate、四个事实位、处置 = no-pty）', () => {
  const admission = makeAdmission()
  const owner = makeOwner()
  const spec = { command: 'ls -la', label: 'list' }

  const record = admission.reserve(owner, spec)

  assert.match(record.id, /^term-\d+$/)
  assert.equal(record.owner, owner)
  assert.equal(record.ownerKey, owner.id)
  assert.equal(record.init, spec)
  assert.equal(record.phase, 'reserved')
  assert.equal(record.reservation.owner, owner)

  for (const gate of GATE_NAMES) {
    assert.equal(typeof record[gate].resolve, 'function', `${gate}.resolve`)
    assert.equal(typeof record[gate].reject, 'function', `${gate}.reject`)
    assert.ok(record[gate].promise instanceof Promise, `${gate}.promise`)
  }
  for (const fact of FACT_NAMES) assert.equal(record[fact], false, fact)

  assert.equal(dispositionOf(record), 'no-pty')
  assert.ok(record.abort instanceof AbortController)
  assert.deepEqual(record.terminal, { exitCode: null, signal: null, detail: 'starting' })
  assert.equal(record.jobDoneResolved, false)
  assert.deepEqual(record.pendingWrites, [])
  assert.deepEqual(record.pendingSignals, [])

  // 同步：还没有任何 await 就已入注册表并计入容量
  assert.equal(admission.size(), 1)
  assert.equal(admission.activeCount(owner), 1)
})

test('C1a-2: 四个 Gate 可落定，outcomeGate 允许恒 resolve', async () => {
  const admission = makeAdmission()
  const record = admission.reserve(makeOwner())

  record.startGate.resolve({ sessionId: record.id })
  record.outcomeGate.resolve({ status: 'failed' })
  record.spawnSettled.resolve()
  record.cleanupSettled.resolve()

  assert.deepEqual(await record.startGate.promise, { sessionId: record.id })
  assert.deepEqual(await record.outcomeGate.promise, { status: 'failed' })
  await record.spawnSettled.promise
  await record.cleanupSettled.promise
})

test('C1a-3: startGate 被 reject 不产生未处理拒绝', async () => {
  const record = createRecord(makeOwner(), {}, {})
  record.startGate.reject(new Error('spawn failed'))
  const error = await record.startGate.promise.catch((e) => e)
  assert.match(error.message, /spawn failed/)
  await new Promise((resolve) => setImmediate(resolve))
})

test('C1b: 容量超限同步抛错，且不建 record、不调用 fence.ensure', () => {
  const ensureCalls = []
  const admission = makeAdmission({ maxSessionsPerAgent: 2 })
  admission.setFence({ ensure: (...args) => ensureCalls.push(args) })
  const owner = makeOwner()

  const first = admission.reserve(owner, { command: 'a' })
  const second = admission.reserve(owner, { command: 'b' })
  assert.equal(ensureCalls.length, 2)

  assert.throws(() => admission.reserve(owner, { command: 'c' }), /maxSessionsPerAgent=2/)

  assert.equal(ensureCalls.length, 2) // 未走到 ③ 围栏
  assert.equal(admission.size(), 2) // 未建 record
  assert.equal(admission.activeCount(owner), 2)
  assert.deepEqual(admission.listForOwner(owner), [first, second])
})

test('C1c: fence.ensure 抛错时 reserve 抛错且不留 record/容量', () => {
  const admission = makeAdmission({ maxSessionsPerAgent: 2 })
  admission.setFence({
    ensure() {
      throw new Error('missing sessionProjections')
    },
  })
  const owner = makeOwner()

  assert.throws(() => admission.reserve(owner, { command: 'a' }), /missing sessionProjections/)
  assert.equal(admission.size(), 0)
  assert.equal(admission.activeCount(owner), 0)
  assert.equal(admission.hasOwnerActivity(owner), false)
})

test('C1d: 容量只计非终态 phase，cleanup-failed 计入', () => {
  const admission = makeAdmission({ maxSessionsPerAgent: 2 })
  const owner = makeOwner()
  const a = admission.reserve(owner)
  const b = admission.reserve(owner)

  b.phase = 'cleanup-failed'
  assert.equal(admission.activeCount(owner), 2)
  assert.equal(admission.hasOwnerActivity(owner), true)
  assert.throws(() => admission.reserve(owner), /maxSessionsPerAgent=2/)

  b.phase = 'killed'
  assert.equal(admission.activeCount(owner), 1)
  const c = admission.reserve(owner)
  assert.equal(c.phase, 'reserved')

  a.phase = 'exited'
  c.phase = 'failed'
  assert.equal(admission.activeCount(owner), 0)
  assert.equal(admission.hasOwnerActivity(owner), false)
})

test('C1e: hasOwnerActivity 覆盖活动 phase 全集，终态 phase 均不计', () => {
  const admission = makeAdmission()
  const owner = makeOwner()
  const record = admission.reserve(owner)

  for (const phase of ACTIVE_PHASES) {
    record.phase = phase
    assert.equal(admission.hasOwnerActivity(owner), true, phase)
    assert.equal(admission.activeCount(owner), 1, phase)
  }
  for (const phase of TERMINAL_PHASES) {
    record.phase = phase
    assert.equal(admission.hasOwnerActivity(owner), false, phase)
    assert.equal(admission.activeCount(owner), 0, phase)
  }
})

test('C1f: release() 幂等——容量只释放一次、记录只移除一次', () => {
  const admission = makeAdmission({ maxSessionsPerAgent: 1 })
  const owner = makeOwner()
  const record = admission.reserve(owner)
  record.phase = 'running' // 活动记录：release 必须释放容量

  admission.release(record)
  assert.equal(admission.activeCount(owner), 0)
  assert.equal(admission.size(), 0)
  assert.equal(admission.get(record.id, owner), undefined)
  assert.equal(admission.listForOwner(owner).length, 0)

  admission.release(record)
  admission.release(record)
  assert.equal(admission.size(), 0)
  assert.equal(admission.activeCount(owner), 0)

  const next = admission.reserve(owner) // 容量确实只有一份
  assert.notEqual(next.id, record.id)
  assert.equal(admission.activeCount(owner), 1)
})

test('C1f-2: release() 对未知/无关 record 是 no-op', () => {
  const admission = makeAdmission()
  const owner = makeOwner()
  const record = admission.reserve(owner)

  admission.release({ id: 'term-999', ownerKey: owner.id })
  admission.release(undefined)
  admission.release(null)

  assert.equal(admission.size(), 1)
  assert.equal(admission.activeCount(owner), 1)
  assert.equal(admission.get(record.id, owner), record)
})

test('C1g: enterRetention 后仍可按 id 查到，超出 maxSettledRetainedPerAgent 时 LRU 淘汰最旧', () => {
  const admission = makeAdmission({ maxSettledRetainedPerAgent: 2 })
  const owner = makeOwner()
  const first = admission.reserve(owner)
  const second = admission.reserve(owner)
  const third = admission.reserve(owner)

  for (const record of [first, second, third]) {
    record.phase = 'exited'
    admission.enterRetention(record)
  }

  assert.equal(admission.activeCount(owner), 0)
  assert.equal(admission.hasOwnerActivity(owner), false)
  assert.equal(admission.size(), 2)
  assert.equal(admission.get(first.id, owner), undefined) // 最旧被淘汰
  assert.equal(admission.get(second.id, owner), second)
  assert.equal(admission.get(third.id, owner), third)
  assert.equal(admission.find(owner, third.id), third)

  admission.sweepNow()
  assert.equal(admission.size(), 2) // 未到期：sweepNow 不误删
})

test('C1h: enterRetention 要求终态且幂等（不改变 LRU 次序）', () => {
  const admission = makeAdmission({ maxSettledRetainedPerAgent: 2 })
  const owner = makeOwner()
  const record = admission.reserve(owner)

  record.phase = 'running'
  assert.throws(() => admission.enterRetention(record), /terminal phase/)
  assert.equal(admission.activeCount(owner), 1) // 拒绝无副作用
  assert.equal(admission.hasOwnerActivity(owner), true)

  record.phase = 'killed'
  admission.enterRetention(record)
  const retainedAt = record.retainedAt
  assert.equal(typeof retainedAt, 'number')

  const other = admission.reserve(owner)
  other.phase = 'exited'
  admission.enterRetention(other)
  admission.enterRetention(record) // 幂等：不刷新 LRU 位置
  assert.equal(record.retainedAt, retainedAt)

  const third = admission.reserve(owner)
  third.phase = 'failed'
  admission.enterRetention(third) // 溢出 → 最旧（record）淘汰
  assert.equal(admission.get(record.id, owner), undefined)
  assert.equal(admission.get(other.id, owner), other)
  assert.equal(admission.get(third.id, owner), third)
})

test('C1i: settledRetainMs 到期后 sweepNow 清除保留期记录', () => {
  let clock = 1000
  const admission = makeAdmission({ settledRetainMs: 50, now: () => clock })
  const owner = makeOwner()
  const record = admission.reserve(owner)
  record.phase = 'exited'
  admission.enterRetention(record)
  assert.equal(admission.get(record.id, owner), record)

  clock = 1049
  admission.sweepNow()
  assert.equal(admission.get(record.id, owner), record) // 未到期

  clock = 1050
  admission.sweepNow()
  assert.equal(admission.get(record.id, owner), undefined)
  assert.equal(admission.size(), 0)
})

test('C1j: release() 与 enterRetention() 顺序无关——容量只释放一次、保留期内仍可查', () => {
  const admission = makeAdmission({ maxSessionsPerAgent: 1 })
  const owner = makeOwner()

  // 顺序 A：先 release 再 enterRetention
  const a = admission.reserve(owner)
  a.phase = 'exited'
  admission.release(a)
  admission.enterRetention(a)
  assert.equal(admission.get(a.id, owner), a)
  assert.equal(admission.activeCount(owner), 0)
  admission.release(a) // 再 release 一次不把保留期记录抹掉
  assert.equal(admission.get(a.id, owner), a)

  const b = admission.reserve(owner) // 容量只有一份：能再开
  assert.equal(admission.activeCount(owner), 1)

  // 顺序 B：先 enterRetention 再 release
  b.phase = 'killed'
  admission.enterRetention(b)
  admission.release(b)
  assert.equal(admission.get(b.id, owner), b)
  assert.equal(admission.activeCount(owner), 0)
  assert.equal(admission.hasOwnerActivity(owner), false)
})

test('C1k: get/find 校验 owner，listForOwner/activeCount 按 owner 隔离', () => {
  const admission = makeAdmission()
  const ownerA = makeOwner('agent-a')
  const ownerB = makeOwner('agent-b')
  const a = admission.reserve(ownerA)
  const b = admission.reserve(ownerB)

  assert.equal(admission.get(a.id, ownerA), a)
  assert.equal(admission.get(a.id, ownerB), undefined)
  assert.equal(admission.find(ownerB, b.id), b)
  assert.equal(admission.find(ownerA, b.id), undefined)
  assert.equal(admission.get(a.id), a) // 省略 owner = 不校验归属
  assert.deepEqual(admission.listForOwner(ownerA), [a])
  assert.equal(admission.activeCount(ownerA), 1)
  assert.equal(admission.activeCount(ownerB), 1)
  assert.equal(admission.hasOwnerActivity({ id: 'agent-c' }), false)
})

test('C1l: reserve 把 owner/ownerCtx 交给 fence.ensure（init.ownerCtx 优先）', () => {
  const calls = []
  const admission = makeAdmission()
  admission.setFence({ ensure: (owner, ownerCtx) => calls.push([owner, ownerCtx]) })
  const ctxA = { on: () => () => {} }
  const ctxB = { on: () => () => {} }
  const owner = { id: 'agent-1', session: { id: 's1' }, ctx: ctxA }

  admission.reserve(owner, { command: 'a' })
  admission.reserve(owner, { command: 'b', ownerCtx: ctxB })
  assert.deepEqual(calls, [[owner, ctxA], [owner, ctxB]])

  const withoutFence = makeAdmission()
  withoutFence.reserve(owner, { command: 'c' }) // 未注入 fence：不装围栏也不抛
  assert.equal(withoutFence.size(), 1)
})

test('C1m: setFence 校验形状；createAdmission 校验上限', () => {
  const admission = makeAdmission()
  assert.throws(() => admission.setFence({}), /ensure/)
  assert.throws(() => admission.setFence(42), /ensure/)
  admission.setFence(undefined)

  assert.throws(() => createAdmission(null), /options/)
  assert.throws(() => createAdmission({ maxSessionsPerAgent: 0 }), /maxSessionsPerAgent/)
  assert.throws(() => createAdmission({ maxSessionsPerAgent: 1.5 }), /maxSessionsPerAgent/)
  assert.throws(() => createAdmission({ maxSettledRetainedPerAgent: -1 }), /maxSettledRetainedPerAgent/)
  assert.throws(() => createAdmission({ settledRetainMs: -1 }), /settledRetainMs/)
})

test('C1n: reserve 参数校验先于任何状态改动', () => {
  const admission = makeAdmission()
  assert.throws(() => admission.reserve(undefined), TypeError)
  assert.throws(() => admission.reserve({}), TypeError)
  assert.throws(() => admission.reserve({ id: '' }), TypeError)
  assert.throws(() => admission.reserve(makeOwner(), []), TypeError)
  assert.equal(admission.size(), 0)

  const record = admission.reserve(makeOwner('agent-null'), null) // null init 视作空
  assert.equal(record.phase, 'reserved')
  assert.deepEqual(record.init, {})
})

test('C1o: createRecord 独立导出——id 唯一、config/limits/init 落到 record 上', () => {
  const owner = makeOwner()
  const fixed = createRecord(owner, { command: 'a' }, { id: 'term-fixed', maxPendingWriteCount: 3 })
  const auto = createRecord(owner, {}, {})

  assert.equal(fixed.id, 'term-fixed')
  assert.match(auto.id, /^term-\d+$/)
  assert.notEqual(auto.id, fixed.id)
  assert.equal(fixed.limits.maxPendingWriteCount, 3)
  assert.equal(auto.limits.maxPendingWriteCount, undefined)
  assert.equal(fixed.init.command, 'a')
  assert.equal(fixed.config.id, 'term-fixed')
  assert.equal(fixed.pendingWriteBytes, 0)
})

test('C1q: allRecords() 返回活动 + 保留期全部记录（teardown 遍历用）', () => {
  const admission = makeAdmission()
  const owner = makeOwner()
  const active = admission.reserve(owner)
  const settled = admission.reserve(owner)
  settled.phase = 'exited'
  admission.enterRetention(settled)

  assert.deepEqual(admission.allRecords(), [active, settled])
  admission.release(active) // 非保留期 release → 从 allRecords 消失
  assert.deepEqual(admission.allRecords(), [settled])
})

test('C1r: setFence 反向绑定——fence.attach(admission) 收到注册表自身', () => {
  const admission = makeAdmission()
  const attached = []
  admission.setFence({ ensure: () => {}, attach: (registry) => attached.push(registry) })
  assert.equal(attached.length, 1)
  assert.equal(attached[0], admission)
  assert.equal(typeof attached[0].hasOwnerActivity, 'function')

  admission.setFence({ ensure: () => {} }) // 没有 attach 的 fence 也能注入
  admission.setFence(undefined)
})

test('C1p: 同一 admission 的 sessionId 递增且不重复', () => {
  const admission = makeAdmission()
  const owner = makeOwner()
  assert.deepEqual(
    [admission.reserve(owner).id, admission.reserve(owner).id],
    ['term-1', 'term-2'],
  )
})
