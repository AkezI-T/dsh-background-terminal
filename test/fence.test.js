/**
 * fence.mjs 冷测试：沙箱模式变更围栏（FINAL.md §12.2、§16.1 F 组）。
 * 真实 fence + 真实 admission + makeOwnerCtx 注入的 owner ctx；不创建进程。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createAdmission } from '../lib/records.mjs'
import { createSandboxFence } from '../lib/fence.mjs'
import { makeFakeCtx, makeOwnerCtx } from './helpers/fake-ctx.mjs'

const CURRENT = 'workspace-write'
const STRICTER = 'read-only'

function modeEvent(mode) {
  return { type: 'sandbox/mode', data: { mode } }
}

function dispatchMode(ownerCtx, session, mode) {
  ownerCtx.dispatch('session/event', [session, modeEvent(mode)])
}

/** 一个 owner + 一份 admission + 已注入的 fence。 */
function setup({ maxSessionsPerAgent = 4, ctxOverrides, stateOf } = {}) {
  const ctx = makeFakeCtx(ctxOverrides ?? {})
  if (stateOf !== undefined) ctx.sessionProjections = { stateOf }
  const ownerCtx = makeOwnerCtx()
  const owner = { id: 'agent-1', session: { id: 'session-1' }, ctx: ownerCtx }
  const admission = createAdmission({ maxSessionsPerAgent })
  const fence = createSandboxFence(ctx, admission)
  admission.setFence(fence)
  return { ctx, ownerCtx, owner, admission, fence }
}

test('F1: reserve 之前没有活动记录，模式切换放行', () => {
  const { owner, ownerCtx, fence } = setup()
  assert.equal(fence.shouldBlock(owner, STRICTER), undefined)
  dispatchMode(ownerCtx, owner.session, STRICTER) // 不抛
})

test('F2: running 时切到更严格模式被拒绝，文案含 open or being created', () => {
  const { owner, ownerCtx, admission, fence } = setup()
  const record = admission.reserve(owner, { command: 'npm run dev' })
  record.phase = 'running'

  const text = fence.shouldBlock(owner, STRICTER)
  assert.match(text, /open or being created/)
  assert.match(text, /"workspace-write"/)
  assert.match(text, /"read-only"/)

  assert.throws(() => dispatchMode(ownerCtx, owner.session, STRICTER), /open or being created/)
  assert.equal(record.phase, 'running') // 围栏不改动记录状态
})

test('F3: reserved/spawning/running/stopping/cleanup-failed 全部拒绝', () => {
  const { owner, admission, fence } = setup()
  const record = admission.reserve(owner, { command: 'sleep 30' })

  for (const phase of ['reserved', 'spawning', 'running', 'stopping', 'cleanup-failed']) {
    record.phase = phase
    assert.match(fence.shouldBlock(owner, STRICTER) ?? '', /open or being created/, phase)
  }
})

test('F4: confine await 期间（reserve 后尚未发布）切换被拒绝', async () => {
  const { owner, ownerCtx, admission, fence } = setup()
  admission.reserve(owner, { command: 'sleep 1' })

  await new Promise((resolve) => setImmediate(resolve)) // 模拟 confine 的 await 窗口
  assert.match(fence.shouldBlock(owner, STRICTER) ?? '', /open or being created/)
  assert.throws(() => dispatchMode(ownerCtx, owner.session, STRICTER), /open or being created/)
})

test('F5: startTimeout 之后（spawning、未发布、未 finish）仍拒绝', () => {
  const { owner, admission, fence } = setup()
  const record = admission.reserve(owner, { command: 'x' })
  record.phase = 'spawning'
  record.spawnAttempted = true
  record.spawnFinished = false // spawnTerminal 尚未落定

  assert.match(fence.shouldBlock(owner, STRICTER) ?? '', /open or being created/)
})

test('F6: cleanup-failed 时拒绝；成功清理之前活动状态不释放', async () => {
  const { owner, ownerCtx, admission, fence } = setup()
  const record = admission.reserve(owner, { command: 'x' })
  record.phase = 'cleanup-failed'

  assert.match(fence.shouldBlock(owner, STRICTER) ?? '', /open or being created/)
  await new Promise((resolve) => setImmediate(resolve)) // 重试仍在进行
  assert.match(fence.shouldBlock(owner, STRICTER) ?? '', /open or being created/)
  assert.throws(() => dispatchMode(ownerCtx, owner.session, STRICTER), /open or being created/)

  // 重试成功：确认进程消失 → 终态 → release
  record.phase = 'killed'
  admission.release(record)
  assert.equal(fence.shouldBlock(owner, STRICTER), undefined)
  dispatchMode(ownerCtx, owner.session, STRICTER)
})

test('F7: 终态且在保留期时放行（记录仍可按 id 查到）', () => {
  const { owner, admission, fence } = setup()
  const record = admission.reserve(owner, { command: 'x' })
  record.phase = 'exited'
  admission.enterRetention(record)

  assert.equal(admission.get(record.id, owner), record)
  assert.equal(fence.shouldBlock(owner, STRICTER), undefined)
})

test('F8: 目标是当前模式时不误拒（有活动记录也放行）', () => {
  const { owner, ownerCtx, admission, fence } = setup()
  const record = admission.reserve(owner, { command: 'x' })
  record.phase = 'running'

  assert.equal(fence.shouldBlock(owner, CURRENT), undefined)
  dispatchMode(ownerCtx, owner.session, CURRENT)

  const projected = setup({ stateOf: () => 'read-only' })
  const other = projected.admission.reserve(projected.owner, { command: 'y' })
  other.phase = 'running'
  assert.equal(projected.fence.shouldBlock(projected.owner, 'read-only'), undefined)
  assert.match(projected.fence.shouldBlock(projected.owner, CURRENT) ?? '', /open or being created/)
})

test('F8b: stateOf 取不到时回退 sandboxPolicy.defaultMode', () => {
  const { ctx, owner, admission, fence } = setup({ stateOf: () => undefined })
  const record = admission.reserve(owner, { command: 'x' })
  record.phase = 'running'

  assert.equal(fence.shouldBlock(owner, ctx.sandboxPolicy.defaultMode), undefined)
  assert.match(fence.shouldBlock(owner, STRICTER) ?? '', /"workspace-write"/) // 当前模式来自 defaultMode
})

test('F9: 缺 ctx.sessionProjections 时 ensure 抛错（挂载失败来源），且不安装 handler', () => {
  const ctx = makeFakeCtx({ sessionProjections: undefined })
  const ownerCtx = makeOwnerCtx()
  const owner = { id: 'agent-1', session: { id: 'session-1' }, ctx: ownerCtx }
  const admission = createAdmission({})
  const fence = createSandboxFence(ctx, admission) // 构造不抛

  assert.throws(() => fence.ensure(owner, ownerCtx), /sessionProjections/)
  assert.equal(fence.installedCount(), 0)
  assert.equal(ownerCtx.handlers.length, 0)
  assert.throws(() => fence.shouldBlock(owner, STRICTER), /sessionProjections/)
})

test('F9b: ensure 缺 ownerCtx/on() 时抛错且不安装', () => {
  const { owner, fence } = setup()
  assert.throws(() => fence.ensure(owner, undefined), /owner ctx/)
  assert.throws(() => fence.ensure(owner, {}), /owner ctx/)
  assert.equal(fence.installedCount(), 0)
})

test('F10: 多 owner 并发——只阻止仍有活动记录的 owner', () => {
  const ctx = makeFakeCtx()
  const admission = createAdmission({ maxSessionsPerAgent: 4 })
  const fence = createSandboxFence(ctx, admission)
  admission.setFence(fence)

  const ctxA = makeOwnerCtx()
  const ctxB = makeOwnerCtx()
  const ownerA = { id: 'agent-a', session: { id: 'sa' }, ctx: ctxA }
  const ownerB = { id: 'agent-b', session: { id: 'sb' }, ctx: ctxB }
  const recordA = admission.reserve(ownerA, { command: 'x' })
  recordA.phase = 'running'

  assert.match(fence.shouldBlock(ownerA, STRICTER) ?? '', /open or being created/)
  assert.throws(() => dispatchMode(ctxA, ownerA.session, STRICTER), /open or being created/)

  assert.equal(fence.shouldBlock(ownerB, STRICTER), undefined)
  dispatchMode(ctxB, ownerB.session, STRICTER) // B 没有会话：不拦
  assert.equal(fence.installedCount(), 1) // 只有 A 预留过 → 只有 A 装了 handler

  const recordB = admission.reserve(ownerB, { command: 'y' })
  recordB.phase = 'running'
  assert.equal(fence.installedCount(), 2)
  assert.throws(() => dispatchMode(ctxB, ownerB.session, STRICTER), /open or being created/)

  admission.release(recordA) // A 收口后只放行 A，B 仍被自己的活动记录拦住
  assert.equal(fence.shouldBlock(ownerA, STRICTER), undefined)
  assert.match(fence.shouldBlock(ownerB, STRICTER) ?? '', /open or being created/)
})

test('F11: ensure 每 owner 幂等，只安装一个 handler', () => {
  const { owner, ownerCtx, fence } = setup()
  fence.ensure(owner, ownerCtx)
  fence.ensure(owner, ownerCtx)
  fence.ensure(owner, ownerCtx)

  assert.equal(ownerCtx.handlers.length, 1)
  assert.equal(fence.installedCount(), 1)
})

test('F12: disposeAll 卸载全部 handler，installedCount 归零且不残留监听器', () => {
  const ctx = makeFakeCtx()
  const admission = createAdmission({})
  const fence = createSandboxFence(ctx, admission)
  admission.setFence(fence)
  const ctxA = makeOwnerCtx()
  const ctxB = makeOwnerCtx()
  const ownerA = { id: 'agent-a', session: { id: 'sa' }, ctx: ctxA }
  const ownerB = { id: 'agent-b', session: { id: 'sb' }, ctx: ctxB }

  admission.reserve(ownerA, { command: 'x' }).phase = 'running'
  admission.reserve(ownerB, { command: 'y' }).phase = 'running'
  assert.equal(fence.installedCount(), 2)
  assert.equal(ctxA.handlers.length, 1)
  assert.equal(ctxB.handlers.length, 1)

  fence.disposeAll()
  assert.equal(fence.installedCount(), 0)
  assert.equal(ctxA.handlers.length, 0)
  assert.equal(ctxB.handlers.length, 0)
  dispatchMode(ctxA, ownerA.session, STRICTER) // 卸载后不再拦截（teardown 语义）
})

test('F13: 非本 session / 非 sandbox-mode 事件不触发围栏', () => {
  const { owner, ownerCtx, admission } = setup()
  const record = admission.reserve(owner, { command: 'x' })
  record.phase = 'running'

  ownerCtx.dispatch('session/event', [{ id: 'other-session' }, modeEvent(STRICTER)])
  ownerCtx.dispatch('session/event', [owner.session, { type: 'turn/start', data: {} }])
  ownerCtx.dispatch('other/event', [owner.session, modeEvent(STRICTER)])
  ownerCtx.dispatch('session/event', undefined)
  ownerCtx.dispatch('session/event', [owner.session, { type: 'sandbox/mode' }]) // 无目标模式
})

test('F14: 未注入 admission 时 ensure/shouldBlock 抛错（不静默不设防），setFence 后才可用', () => {
  const ctx = makeFakeCtx()
  assert.throws(() => createSandboxFence(null), /plugin ctx/)
  assert.throws(() => createSandboxFence(ctx, {}), /admission registry/)
  const fence = createSandboxFence(ctx) // 构造不抛：等待 admission.setFence() 反向绑定
  const ownerCtx = makeOwnerCtx()
  const owner = { id: 'agent-1', session: { id: 'session-1' }, ctx: ownerCtx }

  assert.throws(() => fence.ensure(owner, ownerCtx), /admission registry/)
  assert.throws(() => fence.shouldBlock(owner, STRICTER), /admission registry/)
  assert.equal(fence.installedCount(), 0)
  assert.equal(ownerCtx.handlers.length, 0)

  const admission = createAdmission({})
  admission.setFence(fence) // index.js 的实际接线方式
  fence.ensure(owner, ownerCtx)
  assert.equal(fence.installedCount(), 1)
})

test('F14b: 刻意不再从 ctx.admission 读活动注册表（Cordis 未 inject 会抛）', () => {
  // 真机回归：`ctx.admission` 从未出现在 inject 里，而 Cordis 的 ctx 是代理，
  // 读取未声明的服务属性会抛 `cannot get property "admission" without inject`，
  // 导致整条 entry 无法激活。围栏在 inject 解析前就构造，所以只接受显式传入
  // 或 `admission.setFence(fence)` 反向绑定。
  const ctx = makeFakeCtx()
  ctx.admission = createAdmission({})
  const fence = createSandboxFence(ctx)
  const ownerCtx = makeOwnerCtx()
  const owner = { id: 'agent-1', session: null, ctx: ownerCtx }

  assert.throws(
    () => fence.ensure(owner, ownerCtx),
    /no admission registry attached/,
    '未绑定时必须显式报错，而不是静默不设防',
  )

  // 显式 setFence 绑定后立即可用
  ctx.admission.setFence(fence)
  fence.ensure(owner, ownerCtx)
  assert.equal(fence.installedCount(), 1)
  assert.equal(ownerCtx.handlers.length, 1)
})

test('F14c: 端到端接线（createSandboxFence(ctx) + setFence）能拦截并放行', () => {
  const ctx = makeFakeCtx()
  const ownerCtx = makeOwnerCtx()
  const owner = { id: 'agent-1', session: { id: 'session-1' }, ctx: ownerCtx }
  const admission = createAdmission({ maxSessionsPerAgent: 4 })
  const fence = createSandboxFence(ctx)
  admission.setFence(fence)

  const record = admission.reserve(owner, { command: 'npm run dev' })
  record.phase = 'running'
  assert.equal(ownerCtx.handlers.length, 1)
  assert.throws(() => dispatchMode(ownerCtx, owner.session, STRICTER), /open or being created/)

  record.phase = 'killed'
  admission.release(record)
  assert.equal(fence.shouldBlock(owner, STRICTER), undefined)
  dispatchMode(ownerCtx, owner.session, STRICTER)
})
