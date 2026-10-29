/**
 * 阶段 A 验收：读取等待语义（`docs/terminal-notifications/OUTPUT_EVENTS_AND_LLM_WAKEUP.md` §6/§13）。
 *
 * ## 为什么单独一个文件
 *
 * 文档点名了一个静态检查发现的缺陷：
 *
 * > `waitMs > 0` 时 `toolRead` 先进入 `waitForData`，等待函数内未见订阅前的未读数据检查。
 * > 存在"已有未读输出但没有新事件，仍等到超时"的风险。
 *
 * 该缺陷的后果不是"报错"，而是**白等满 waitMs**——安静、昂贵、且不会被功能测试发现
 * （数据最终还是读到了，只是晚了 30 秒）。这类缺陷必须用**时间断言**锁住，
 * 所以单独成文件、集中放等待语义的用例。
 *
 * 本文件自行装配假 ctx（不依赖 `index.test.js` 的内部函数），因此与它互不影响。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../lib/index.js'
import { makeFakePty, makeFakeSpawn } from './helpers/fake-ctx.mjs'

const SHELL = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const CRLF = '\r\n'
const READY_BEACON = '__DSH_BGTERM_READY__'

/** 带引用定时器的竞速兜底：实现被改坏时不会让整条用例被标成 cancelled。 */
async function raceWithTimeout(promise, ms) {
  const started = Date.now()
  const woke = await Promise.race([
    promise.then(() => Date.now() - started),
    new Promise((resolve) => setTimeout(() => resolve(-1), ms)),
  ])
  return woke
}

/**
 * 等一个有可能"白等"的读取。
 *
 * 读取自身的等待定时器是 **unref** 的：若事件循环里没有别的带引用句柄，
 * Node 会直接退出并把用例标成 `cancelled`，还连带取消后续用例
 * （`index.test.js` 里有同样的教训记录）。所以这里**始终**配一个带引用的兜底
 * 定时器，它同时也决定了本用例能容忍的最长等待。
 */
async function awaitRead(promise, capMs = 3000) {
  const cap = new Promise((resolve) => setTimeout(() => resolve('__CAP__'), capMs))
  const outcome = await Promise.race([promise.then((v) => ({ value: v })), cap])
  if (outcome !== '__CAP__') return { value: outcome.value, capped: false }
  // 兜底先到：仍要等读取真正落定，避免留下未处理的 promise
  return { value: await promise, capped: true }
}

function mount() {
  const tools = new Map()
  const spawn = makeFakeSpawn()
  const ownerCtxs = new Map()

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
        const hooks = spec.run({ append() {}, updateProgress() {} })
        return 'terminal-1'
      },
    },
    get: (name) => (name === 'sandbox' ? { confine: async (argv) => ({ argv: ['runner', '--', ...argv] }) } : undefined),
  }
  const runtime = apply(ctx, { shellPath: SHELL, shellDialect: 'pwsh', ptyBackend: 'host' })
  const agentFor = (id = 'agent-1') => {
    if (!ownerCtxs.has(id)) ownerCtxs.set(id, { on() {}, off() {} })
    return { id, ctx: ownerCtxs.get(id), session: { header: { cwd: 'F:/ws' } } }
  }
  const callTool = (name, args, owner) => {
    const def = tools.get(name)
    assert.ok(def, `工具未注册: ${name}`)
    // 测试统一注入极短 `waitMs`（产品默认是有界等待 10s；假 PTY 的帧永不闭合）
    const effective = name === 'terminal_exec' ? { waitMs: 1, ...args } : args
    return def.execute(effective, { agent: owner })
  }
  return { tools, spawn, runtime, agentFor, callTool }
}

/** 起一个已就绪的会话，并清空游标。 */
async function readySession(h, owner) {
  const pty = makeFakePty()
  h.spawn.spawnTerminal = async (spec) => {
    h.spawn.spawnCalls.push(spec)
    return pty.handle
  }
  const exec = await h.callTool('terminal_exec', { command: 'echo hi' }, owner)
  pty.emit(READY_BEACON + CRLF)
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && h.runtime.admission.listForOwner(owner)[0]?.ready !== true) {
    await new Promise((r) => setTimeout(r, 5))
  }
  await h.callTool('terminal_read', { sessionId: exec.sessionId }, owner) // 清空游标
  return { pty, sessionId: exec.sessionId }
}

// ─────────────────────────────────────────────────────────────────────────────
// 验收矩阵第一条：读取前已有未读数据，waitMs=30000 → 立即返回
// ─────────────────────────────────────────────────────────────────────────────

test('R1 已有未读数据时 waitMs 必须立即返回，不得等满', async () => {
  const h = mount()
  const owner = h.agentFor()
  const { pty, sessionId } = await readySession(h, owner)

  // 产生输出但**不读**：此时 ring 里有未读数据，cursor 落后
  pty.emit('unread-before-wait\r\n')
  await new Promise((r) => setTimeout(r, 30))

  const started = Date.now()
  const pending = h.callTool('terminal_read', { sessionId, waitMs: 3000 }, owner)
  pending.then(() => {}, () => {})
  const woke = await raceWithTimeout(pending, 1200)
  assert.notEqual(woke, -1, '有未读数据时必须立即返回（等满说明缺少"订阅前检查未读数据"）')
  assert.ok(woke < 500, `有未读数据应立刻返回，实得 ${woke}ms`)

  // 断言**这一次**的返回值：读取是增量契约，数据已被它消费，再读一次自然是空的
  const result = await pending
  assert.match(result.text, /unread-before-wait/, '未读数据必须在这**一次**读取里返回')
  void started
})

test('R2 无未读数据时仍按 waitMs 等待并返回 timeout 语义', async () => {
  const h = mount()
  const owner = h.agentFor()
  const { sessionId } = await readySession(h, owner)

  // 游标已清空、无新输出 → 应当等满（这里用较短的 waitMs）
  const woke = await raceWithTimeout(
    h.callTool('terminal_read', { sessionId, waitMs: 300 }, owner),
    2000,
  )
  assert.notEqual(woke, -1, '无数据时应在 waitMs 后返回，而不是永不返回')
  assert.ok(woke >= 250, `无数据时应等待约 waitMs，实得 ${woke}ms`)
  assert.ok(woke < 1500, `不应超过 waitMs 太多，实得 ${woke}ms`)
})

test('R3 等待期间的输出必须唤醒，且只收口一次', async () => {
  const h = mount()
  const owner = h.agentFor()
  const { pty, sessionId } = await readySession(h, owner)

  const pending = h.callTool('terminal_read', { sessionId, waitMs: 5000 }, owner)
  pending.then(() => {}, () => {})
  await new Promise((r) => setTimeout(r, 40)) // 让 sink 挂上

  pty.emit('woke-by-output\r\n')
  const woke = await raceWithTimeout(pending, 2000)
  assert.notEqual(woke, -1, '新输出必须唤醒等待中的读取')
  assert.ok(woke < 800, `输出到达后应尽快唤醒，实得 ${woke}ms`)

  const result = await pending
  assert.match(result.text, /woke-by-output/, '唤醒后应读到该输出')
})

test('R4 输出流结束（EOF）也必须唤醒，不等满 waitMs', async () => {
  const h = mount()
  const owner = h.agentFor()
  const { pty, sessionId } = await readySession(h, owner)

  const pending = h.callTool('terminal_read', { sessionId, waitMs: 5000 }, owner)
  pending.then(() => {}, () => {})
  await new Promise((r) => setTimeout(r, 40))

  pty.endOutput()
  const woke = await raceWithTimeout(pending, 2000)
  assert.notEqual(woke, -1, 'EOF 必须唤醒等待中的读取')
  assert.ok(woke < 800, `EOF 后应尽快唤醒，实得 ${woke}ms`)
})

// ─────────────────────────────────────────────────────────────────────────────
// 验收矩阵第二条：检查与订阅之间产生输出 → 注册后复查捕获，无丢唤醒
// ─────────────────────────────────────────────────────────────────────────────

test('R5 订阅与检查之间到达的数据不得丢唤醒（注册后复查）', async () => {
  const h = mount()
  const owner = h.agentFor()
  const { pty, sessionId } = await readySession(h, owner)

  // 在"发起读取"与"等待真正挂上 sink"之间注入输出——正是检查/订阅竞态窗口。
  // 实现若只在订阅**之前**检查一次，这里的输出不会触发 sink，就会白等满 waitMs。
  const pending = h.callTool('terminal_read', { sessionId, waitMs: 3000 }, owner)
  pending.then(() => {}, () => {})
  pty.emit('arrived-during-race\r\n')

  const woke = await raceWithTimeout(pending, 2000)
  assert.notEqual(woke, -1, '竞态窗口内到达的数据必须被复查捕获，不能丢唤醒')
  assert.ok(woke < 1000, `竞态窗口的数据应在复查时立刻返回，实得 ${woke}ms`)

  const result = await pending
  assert.match(result.text, /arrived-during-race/, '复查捕获后必须能读到这段数据')
})

// ─────────────────────────────────────────────────────────────────────────────
// wakeReason 协议扩展（文档 §6："可建议新增 wakeReason: data | output-ended |
// state-change | timeout | cancelled；这是返回协议扩展，实施时更新 schema 和说明"）
// ─────────────────────────────────────────────────────────────────────────────

test('W1 wakeReason=already-readable：订阅前已有未读数据', async () => {
  const h = mount()
  const owner = h.agentFor()
  const { pty, sessionId } = await readySession(h, owner)

  pty.emit('pending-before-wait\r\n')
  await new Promise((r) => setTimeout(r, 30))

  // 走到 waitForData 的"注册后复查"分支（订阅前检查已被上面的 emit 满足，
  // 但两次判定相同，这里锁的是返回协议本身）
  const result = await h.callTool('terminal_read', { sessionId, waitMs: 2000 }, owner)
  assert.ok(
    ['already-readable', 'data'].includes(result.wakeReason),
    `已有未读数据时 wakeReason 应为 already-readable（或 data），实得 ${result.wakeReason}`,
  )
  assert.match(result.text, /pending-before-wait/)
})

test('W2 wakeReason=data：等待期间到达新输出', async () => {
  const h = mount()
  const owner = h.agentFor()
  const { pty, sessionId } = await readySession(h, owner)

  const pending = h.callTool('terminal_read', { sessionId, waitMs: 5000 }, owner)
  pending.then(() => {}, () => {})
  await new Promise((r) => setTimeout(r, 40))
  pty.emit('woke-by-data\r\n')

  const result = await pending
  assert.equal(result.wakeReason, 'data', '等待期间的新输出应报 data')
  assert.match(result.text, /woke-by-data/)
})

test('W3 wakeReason=timeout：什么都没发生', async () => {
  const h = mount()
  const owner = h.agentFor()
  const { sessionId } = await readySession(h, owner)

  const { value, capped } = await awaitRead(
    h.callTool('terminal_read', { sessionId, waitMs: 250 }, owner),
    3000,
  )
  assert.equal(capped, false, '无数据时应在 waitMs 后返回')
  assert.equal(value.wakeReason, 'timeout', '无新数据也无落定应报 timeout')
  assert.equal(value.text, '', '超时不应凭空产生内容')
})

test('W4 wakeReason=output-ended：输出流结束', async () => {
  const h = mount()
  const owner = h.agentFor()
  const { pty, sessionId } = await readySession(h, owner)

  const pending = h.callTool('terminal_read', { sessionId, waitMs: 5000 }, owner)
  pending.then(() => {}, () => {})
  await new Promise((r) => setTimeout(r, 40))
  pty.endOutput()

  const { value } = await awaitRead(pending, 3000)
  assert.equal(value.wakeReason, 'output-ended', 'EOF 应报 output-ended')
})

test('W5 waitMs=0 时不带 wakeReason（没有等待就没有唤醒原因）', async () => {
  const h = mount()
  const owner = h.agentFor()
  const { sessionId } = await readySession(h, owner)

  const result = await h.callTool('terminal_read', { sessionId, waitMs: 0 }, owner)
  assert.equal(result.wakeReason, undefined, '非阻塞读取不应有 wakeReason 字段')
})

// ─────────────────────────────────────────────────────────────────────────────
// 并发读取的串行消费契约
// 文档 §6："多个并发读取若共享 cursor，应定义串行消费；不允许两个读取静默竞争
// 导致结果难以追踪"；验收矩阵："两次并发读取 → 符合串行消费契约，无重复或静默丢失"
// ─────────────────────────────────────────────────────────────────────────────

test('C1 两次并发读取：同一段输出恰好投喂一次（不重复、不丢失）', async () => {
  const h = mount()
  const owner = h.agentFor()
  const { pty, sessionId } = await readySession(h, owner)

  // 连跑多轮：单轮"恰好一次"可能是巧合，多轮才能证明契约稳定
  for (let round = 0; round < 4; round += 1) {
    const mark = `CONCURRENT_R${round}_MARK`
    const a = h.callTool('terminal_read', { sessionId, waitMs: 600 }, owner)
    const b = h.callTool('terminal_read', { sessionId, waitMs: 600 }, owner)
    a.then(() => {}, () => {})
    b.then(() => {}, () => {})
    await new Promise((r) => setTimeout(r, 30)) // 让两个 sink 都挂上
    pty.emit(`${mark}\r\n`)

    const cap = new Promise((r) => setTimeout(() => r('__CAP__'), 2500))
    const [ra, rb] = await Promise.race([
      Promise.all([a, b]),
      cap.then(() => [{ text: '' }, { text: '' }]),
    ])
    const count = `${ra?.text ?? ''}${rb?.text ?? ''}`.split(mark).length - 1
    assert.equal(
      count,
      1,
      `第 ${round + 1} 轮：并发读取应恰好投喂一次，实得 ${count} 次（0 = 丢失，>1 = 重复投喂）`,
    )
  }
})

test('R6 等待本身不消费输出：超时返回后未读数据仍在', async () => {
  const h = mount()
  const owner = h.agentFor()
  const { pty, sessionId } = await readySession(h, owner)

  // 先产生输出吃掉一次"立即返回"，再读掉它
  pty.emit('first-batch\r\n')
  await new Promise((r) => setTimeout(r, 20))
  const first = await h.callTool('terminal_read', { sessionId, waitMs: 200 }, owner)
  assert.match(first.text, /first-batch/)

  // 现在无未读数据 → 会等满；等待期间到达的数据不能被"等待动作"消费掉
  const pending = h.callTool('terminal_read', { sessionId, waitMs: 400 }, owner)
  pending.then(() => {}, () => {})
  await new Promise((r) => setTimeout(r, 40))
  pty.emit('during-wait\r\n')
  const { value } = await awaitRead(pending, 3000)
  assert.match(value.text, /during-wait/, '等待期间到达的数据必须在返回时可读（等待不得消费）')
})