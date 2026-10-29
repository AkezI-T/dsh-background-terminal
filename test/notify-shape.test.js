/**
 * 通知形态与诊断按需取（对应 `docs/terminal-notifications/OUTPUT_EVENTS_AND_LLM_WAKEUP.md`
 * §11「模型收到的消息应该长什么样」与 §9「投递」）。
 *
 * ## 背景：宿主已经有完整的通知链路
 *
 * 读宿主源码（`@deepseek-ai/dsh-tool-jobs/lib/index.js`）确认它已经实现了文档 §10 的全部要求：
 *
 * ```js
 * ctx.jobs.events.subscribe({ owners: 'scope' }, (event) => {
 *   if (event.type !== 'settled') return
 *   if (killedByModel.delete(...) || event.awaited || event.cause === 'teardown') return  // 去重
 *   const owner = ctx.get('agents')?.get(event.job.owner)                                 // owner 路由
 *   const message = createUserMessage({ content: [{ type: 'text', text: fitCompletionNotice(event.job) }], ... })
 *   if (delivery === 'wakeup' && owner.status === 'idle') { ...; owner.followup(message); return }  // 空闲唤醒
 *   owner.inject(message)                                                                  // 忙时投递
 * })
 * ```
 *
 * 通知文案：`background job <id> (<kind>: <label>) finished [status: <detail>]`。
 *
 * ## 关键区分：通知用的 detail 与 terminal_read 用的 detail **不是同一份字符串**
 *
 * - 通知读的是 jobs 注册表里的 `detail`，来自 `settleJobs(record, outcome)` 的
 *   `outcome.detail`（**没有**追加诊断块）；
 * - `record.terminal.detail` 才带完整证据链（`withDiagnostics` 追加），供
 *   `terminal_read` / `terminal_state` 使用。
 *
 * 一开始我把两者当成同一份，据此以为"通知被诊断撑成了长文"——那是错的。
 * 这些用例锁住真实分工：通知一句话（含尾部线索 + 127 提示），诊断按需取。
 *
 * ## 阶段 B 加固：两条失败路径的通知形态必须一致
 *
 * 修前只有正常路径守这条分工：`finish` 正常失败把 `outcome.detail`（一句话）交给 Jobs，
 * 而 cleanup-failed 路径把 `record.terminal.detail`（**一句话 + 整段诊断**）交出去——
 * 同一类"任务失败"因此有长度差一个数量级的两种通知（实测 44 字符 vs 550 字符）。
 * 修法见 `lib/controller.mjs` 的 `applyCleanupFailureView`：失败视图只在那一处构造，
 * 通知拿短文案，`record.terminal` 保留带诊断的那份。
 *
 * **为什么"短"是唯一防线**：宿主 `fitCompletionNotice` 的截断预算是
 * `job.outputLimitBytes`（`dsh-tool-jobs/lib/index.js:168`），而插件传的是
 * `config.maxOutputChars = 16000`（`lib/index.js:501`）。带诊断的通知也不过几百字节，
 * 远在预算之下 ⇒ **不会被截断**，会整段进模型上下文。所以不能指望"反正会被砍"。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'

import { apply } from '../lib/index.js'
import { makeFakePty, makeFakeSpawn } from './helpers/fake-ctx.mjs'

const SHELL = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const READY_BEACON = '__DSH_BGTERM_READY__'

function mount(opts = {}) {
  const tools = new Map()
  const jobs = new Map()
  const spawn = makeFakeSpawn({ rejectWith: opts.spawnRejects })
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
        const id = `terminal-${jobSeq}`
        // 形状对齐宿主注册表：kind / label / outputLimitBytes 都记下来，progress 由
        // updateProgress 写入（`dsh-jobs-local/lib/index.js:442-454`），结算时清空（`:741`）。
        const handle = {
          append() {},
          updateProgress(line) { jobs.get(id).progress = line },
        }
        jobs.set(id, {
          id,
          kind: spec.kind,
          label: spec.label,
          outputLimitBytes: spec.outputLimitBytes,
          status: 'running',
          progress: undefined,
          detail: undefined,
        })
        const hooks = spec.run(handle)
        Promise.resolve(hooks.done).then(
          (o) => { const j = jobs.get(id); j.status = o?.status; j.detail = o?.detail; j.progress = undefined },
          () => { const j = jobs.get(id); j.status = 'failed'; j.progress = undefined },
        )
        return id
      },
    },
    get: (n) => (n === 'sandbox' ? { confine: async (a) => ({ argv: ['runner', '--', ...a] }) } : undefined),
  }
  const runtime = apply(ctx, { shellPath: SHELL, shellDialect: 'pwsh', ptyBackend: 'host', startupGraceMs: 40 })
  // 假 agent：`notifyOnExit` 的送达直接依赖 owner 自身的 `status` / `followup` / `inject`
  // （插件拿的就是 `exec.agent` 这个活对象，不另经 `ctx.get('agents')` 查表）。
  const wakes = []
  const owner = {
    id: opts.agentId ?? 'a1',
    status: opts.agentStatus ?? 'idle',
    followup: (m) => wakes.push({ via: 'followup', message: m }),
    inject: (m) => wakes.push({ via: 'inject', message: m }),
    ctx: { on() {}, off() {} },
    session: { header: { cwd: 'F:/ws' } },
  }
  if (opts.followupThrows === true) {
    owner.followup = () => { throw new Error('inbox closed') }
  }
  // 测试统一注入极短 `waitMs`（产品默认是有界等待 10s；假 PTY 的帧永不闭合）。
  // 调用方显式传 waitMs 时以调用方为准（有界等待的用例靠这个）。
  const call = (n, a) => tools.get(n).execute(
    n === 'terminal_exec' ? { waitMs: 1, ...a } : a,
    { agent: owner },
  )
  return { tools, jobs, spawn, runtime, owner, call, wakes }
}

/** 复合帧标记：写入的 stdin 里取 start/end（真值来源），用于模拟命令结束。 */
function markersOf(written) {
  const start = /__DSH_BGTERM_[0-9a-f-]+_S__/.exec(written)?.[0]
  const end = /__DSH_BGTERM_[0-9a-f-]+_E__/.exec(written)?.[0]
  return { start, end }
}

const CRLF = '\r\n'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 宿主选中给通知的那一行：`job.progress ?? job.detail`
 * （`dsh-tool-jobs/lib/index.js:20-22` 的 `jobDetail`）。结算时宿主已清空 `progress`
 * （`dsh-jobs-local/lib/index.js:741`），所以结算后拿到的就是 detail。
 */
const noticeDetail = (job) => job.progress ?? job.detail

/** 宿主通知模板的逐字转写（`dsh-tool-jobs/lib/index.js:163-167`），只用来量字节数。 */
function noticeText(job) {
  return `background job ${job.id} (${job.kind}: ${job.label}) finished `
    + `[status: ${job.status}, ${noticeDetail(job)}]. Read its output with job_output.`
}

/**
 * 通知 detail 的形态不变量。三条都是硬要求：
 *  · 单行 —— 宿主把它拼进 `[status: …, …]`（`dsh-tool-jobs/lib/index.js:45-46`）；
 *  · 无诊断块 —— 完整证据链走 `terminal_read` / `terminal_state` 按需取；
 *  · 有界 —— 截断预算（`outputLimitBytes`）远大于诊断块，长文案不会被砍，只能靠它自己短。
 */
function assertNoticeShape(detail, label) {
  assert.equal(typeof detail, 'string', `${label}: job detail 必须是字符串`)
  assert.ok(detail.length > 0, `${label}: job detail 不能为空`)
  assert.ok(!detail.includes('\n'), `${label}: 通知 detail 必须是单行，实得 ${JSON.stringify(String(detail).slice(0, 160))}`)
  assert.ok(!detail.includes('[bgterm diagnostics]'), `${label}: 诊断块不得进通知`)
  assert.ok(detail.length < 400, `${label}: 通知 detail 应当简短，实长 ${detail.length}`)
}

/**
 * 走完一次 cleanup-failed：发布 → 就绪 → terminate 失败 → close 重试入口。
 * 返回 { h, exec, pty }，调用方负责断言"确实落到了 cleanup-failed"（否则用例形同虚设）。
 */
async function driveCleanupFailed() {
  const h = mount()
  const pty = makeFakePty()
  h.spawn.spawnTerminal = async (spec) => { h.spawn.spawnCalls.push(spec); return pty.handle }
  const exec = await h.call('terminal_exec', { command: 'sleep 100' }, h.owner)
  pty.emit(READY_BEACON + CRLF)
  await sleep(30)
  pty.failNextTerminate('terminal cleanup failed; surviving pid: 4242')
  const closed = await h.call('terminal_signal', { sessionId: exec.sessionId, close: true }, h.owner)
  return { h, exec, pty, closed }
}

test('N1 通知用的 detail 是短文案（诊断块只进 terminal_read/state）', async () => {
  // spawn 被宿主拒绝：走 spawn-failed 分支
  const h = mount({ spawnRejects: Object.assign(new Error('terminal spawn unsupported'), { code: 'SANDBOX_PTY_UNSUPPORTED' }) })
  const exec = await h.call('terminal_exec', { command: 'echo hi' }, h.owner)
  assert.equal(exec.status, 'startup-failed')

  const job = [...h.jobs.values()][0]
  assert.ok(job.detail, 'job 必须有 detail（宿主用它渲染通知）')
  // 通知里不得出现诊断块的分节标记——那是给 terminal_state 按需取的
  assertNoticeShape(noticeDetail(job), 'N1 正常失败')

  // 对照：record.terminal.detail（terminal_read 用）**确实**带诊断 —— 证明两者不同源
  const rec = h.runtime.admission.listForOwner(h.owner)[0]
  assert.match(
    String(rec.terminal.detail),
    /\[bgterm diagnostics\]/,
    'record.terminal.detail 必须带诊断（两者是不同字符串，这正是本用例要锁的区分）',
  )
})

test('N2 退出码 127 的通知带定向提示（一句话版）', async () => {
  const h = mount()
  const pty = makeFakePty()
  h.spawn.spawnTerminal = async (spec) => { h.spawn.spawnCalls.push(spec); return pty.handle }
  const exec = await h.call('terminal_exec', { command: 'echo hi' }, h.owner)

  // 已就绪后以 127 退出 → natural-exit + exitCode 127
  pty.emit(READY_BEACON + CRLF)
  await sleep(30)
  pty.exit(127, null)

  // 等结算落定。**不要用"没结算就 return"跳过**——那会让用例看起来通过、
  // 实际什么都没断言（本项目已经吃过恒真断言的亏）。
  const deadline = Date.now() + 2000
  let job = [...h.jobs.values()][0]
  while (Date.now() < deadline && job?.detail === undefined) {
    await sleep(20)
    job = [...h.jobs.values()][0]
  }

  assert.ok(job, 'job 应已注册')
  assert.notEqual(job.detail, undefined, '会话必须结算并产生 detail（否则本用例形同虚设）')
  assert.match(String(job.detail), /127/, 'detail 应报告退出码')
  assert.match(String(job.detail), /host runner's own failure code/, '127 应带定向提示，避免模型误以为命令写错')
  assert.ok(!/windows-acl-run/.test(String(job.detail)), '长解释留给诊断块，不进通知')
})

test('N3 完整诊断经 terminal_state 按需取（含 argv）', async () => {
  const h = mount({ spawnRejects: Object.assign(new Error('terminal spawn unsupported by sandbox runner'), { code: 'SANDBOX_PTY_UNSUPPORTED' }) })
  const exec = await h.call('terminal_exec', { command: 'echo hi' }, h.owner)

  const state = await h.call('terminal_state', { sessionId: exec.sessionId }, h.owner)
  assert.equal(state.phase, 'failed')
  assert.ok(typeof state.diagnostics === 'string' && state.diagnostics.length > 0, '失败会话的 terminal_state 必须带诊断')
  assert.match(state.diagnostics, /argv:/, '诊断里必须有 confine 后的 argv')
  assert.match(state.diagnostics, /SANDBOX_PTY_UNSUPPORTED|terminal spawn unsupported/, '诊断里必须有宿主侧错误')
})

test('N4 成功会话的 terminal_state 不带诊断（不污染正常路径）', async () => {
  const h = mount()
  const pty = makeFakePty()
  h.spawn.spawnTerminal = async (spec) => { h.spawn.spawnCalls.push(spec); return pty.handle }
  const exec = await h.call('terminal_exec', { command: 'echo hi' }, h.owner)
  pty.emit(READY_BEACON + CRLF)
  pty.emit('output\r\n')
  await sleep(40)

  const state = await h.call('terminal_state', { sessionId: exec.sessionId }, h.owner)
  assert.equal(state.phase, 'running')
  assert.equal(state.diagnostics, undefined, '运行中的会话不应附加诊断')
})

// ─────────────────────────────────────────────────────────────────────────────
// 阶段 B 加固：cleanup-failed 路径的通知形态（与正常失败一致）
// ─────────────────────────────────────────────────────────────────────────────

test('N5 cleanup-failed 的通知 detail 也是单行短文案，诊断只留在 terminal 那份', async () => {
  const { h, exec, closed } = await driveCleanupFailed()
  assert.equal(closed.status, 'cleanup-failed', '前置条件：必须真的落到 cleanup-failed')

  const job = [...h.jobs.values()][0]
  assert.equal(job.status, 'failed', 'cleanup-failed 的 job 以 failed 结算')
  assertNoticeShape(noticeDetail(job), 'N5 cleanup-failed')
  assert.equal(noticeDetail(job), job.detail, '结算后 progress 已清空，通知读的就是 detail')
  assert.match(job.detail, /cleanup failed/, '一句话事实必须留在通知里')
  assert.match(job.detail, /surviving pid: 4242/, '可行动事实（幸存 pid）必须留在通知里')

  // 对照：terminal 那份仍带完整诊断，且与通知那份同源（短文案 + 诊断后缀）
  const rec = h.runtime.admission.listForOwner(h.owner)[0]
  assert.match(String(rec.terminal.detail), /\[bgterm diagnostics\]/, 'terminal_read 的 detail 必须仍带诊断')
  assert.ok(
    String(rec.terminal.detail).startsWith(`${job.detail}\n`),
    '通知那份必须是 terminal 那份去掉诊断后缀后的短文案（同源、两种形态）',
  )
})

test('N6 cleanup-failed 的完整诊断经 terminal_state / terminal_read 按需取（短化不丢证据）', async () => {
  const { h, exec, closed } = await driveCleanupFailed()
  assert.equal(closed.status, 'cleanup-failed', '前置条件：必须真的落到 cleanup-failed')

  const state = await h.call('terminal_state', { sessionId: exec.sessionId }, h.owner)
  assert.equal(state.phase, 'cleanup-failed')
  assert.equal(typeof state.diagnostics, 'string', 'cleanup-failed 必须能按需取到诊断')
  assert.match(state.diagnostics, /\[bgterm diagnostics\]/)
  assert.match(state.diagnostics, /^sessionId: /m)
  assert.match(state.diagnostics, /^jobId: /m)
  assert.match(state.diagnostics, /^argv: /m, '诊断里必须有 confine 后的 argv')

  // terminal_read 的 detail 同样带诊断（模型不调 terminal_state 也能读到证据链）
  const read = await h.call('terminal_read', { sessionId: exec.sessionId }, h.owner)
  assert.equal(read.status, 'cleanup-failed')
  assert.match(String(read.detail), /\[bgterm diagnostics\]/, 'terminal_read 的 detail 也必须带诊断')
})

test('N7 正常失败与 cleanup-failed 的通知形态一致，且都不靠 outputLimitBytes 截断兜底', async () => {
  // 路径 A：spawn 被宿主拒绝 → finish 的正常失败路径（outcome.detail）
  const a = mount({ spawnRejects: Object.assign(new Error('terminal spawn unsupported'), { code: 'SANDBOX_PTY_UNSUPPORTED' }) })
  await a.call('terminal_exec', { command: 'echo hi' }, a.owner)
  const jobA = [...a.jobs.values()][0]
  assert.equal(jobA.status, 'failed', '路径 A 必须以 failed 结算')

  // 路径 B：terminate 失败 → cleanup-failed 路径
  const { h: b, closed } = await driveCleanupFailed()
  assert.equal(closed.status, 'cleanup-failed', '路径 B 必须真的落到 cleanup-failed')
  const jobB = [...b.jobs.values()][0]
  assert.equal(jobB.status, 'failed', '路径 B 也必须以 failed 结算')

  for (const [label, job] of [['路径 A（正常失败）', jobA], ['路径 B（cleanup-failed）', jobB]]) {
    assertNoticeShape(noticeDetail(job), label)
    const bytes = Buffer.byteLength(noticeText(job), 'utf8')
    // 截断预算就是插件给的 outputLimitBytes：两条路径都远在其下 ⇒ 宿主不会截断，
    // 长 detail 会整段进上下文。"短"没有兜底，必须由 detail 自己保证。
    assert.ok(
      bytes < job.outputLimitBytes,
      `${label}: 通知未被截断（${bytes} < ${job.outputLimitBytes}）`,
    )
    assert.ok(bytes < 400, `${label}: 未截断时也必须是短文案，实为 ${bytes} 字节`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// notifyOnExit：命令结束时的**按需**唤醒（W1..W5）
//
// 背景：宿主对唤醒次数**没有全局上限**（`dsh-agent-loop` 的 `wakeDriver` 只有并发闩锁，
// 唯一的预算 `spentWakes` 在 `dsh-tool-jobs` 自己的闭包里）。所以插件一旦默认唤醒，
// 就能造出无界循环。纪律是：**只有调用方声明"我在等这条命令"才送达**。
// ─────────────────────────────────────────────────────────────────────────────

/** 起一个会话并等它就绪，返回 { h, exec, pty, markers }。 */
async function readySession(h, command, execArgs = {}) {
  const pty = makeFakePty()
  h.spawn.spawnTerminal = async (spec) => {
    h.spawn.spawnCalls.push(spec)
    return pty.handle
  }
  const exec = await h.call('terminal_exec', { command, ...execArgs }, h.owner)
  pty.emit(READY_BEACON + CRLF)
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && pty.writeCalls().length < 2) await sleep(20)
  const markers = markersOf(pty.writeCalls()[1])
  return { exec, pty, markers }
}

/** 让一条命令的帧闭合（含真实 shell 会做的回显）。 */
async function closeFrame(h, pty, exec, markers, exitCode = 0) {
  const record = h.runtime.admission.listForOwner(h.owner).find((r) => r.id === exec.sessionId)
  pty.emit(`${pty.writeCalls()[1]}`)
  pty.emit(`${CRLF}done${CRLF}${markers.end}${exitCode}${CRLF}`)
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && record.pendingFrame !== undefined) await sleep(20)
  return record
}

test('W1 默认关：命令结束**不**唤醒（没声明就不该被打扰）', async () => {
  const h = mount()
  const { exec, pty, markers } = await readySession(h, 'npm run build')
  assert.ok(markers.end, '必须能取到帧标记')
  await closeFrame(h, pty, exec, markers)
  assert.equal(h.wakes.length, 0, 'notifyOnExit 默认 false 时**不得**唤醒')
})

test('W2 notifyOnExit=true 且 agent 空闲 → followup（开会话）', async () => {
  const h = mount({ agentStatus: 'idle' })
  const { exec, pty, markers } = await readySession(h, 'npm run build', { notifyOnExit: true })
  await closeFrame(h, pty, exec, markers, 0)

  assert.equal(h.wakes.length, 1, '必须恰好唤醒一次')
  assert.equal(h.wakes[0].via, 'followup', '空闲时必须 followup（开会话），不是 inject')
})

test('W3 agent 忙 → inject（只排队，**不**递归唤醒）', async () => {
  // 这条是"自唤起不会无限循环"的机制依据：agent 自己发命令时 phase !== 'idle'，
  // 命令结束只把消息排进 inbox。
  const h = mount({ agentStatus: 'running' })
  const { exec, pty, markers } = await readySession(h, 'npm run build', { notifyOnExit: true })
  await closeFrame(h, pty, exec, markers, 0)

  assert.equal(h.wakes.length, 1)
  assert.equal(h.wakes[0].via, 'inject', '忙时必须 inject——followup 会在忙时闩锁，语义不同')
})

test('W4 消息必须是宿主认可的最小合法形状（四字段，一个都不能少）', async () => {
  // 形状校验只在 adopt/restore 路径执行（`dsh-session` 的 assertMessageEventShape）：
  // 畸形消息**当场不报错**，重启恢复时才判死会话日志。所以这里必须逐字段锁。
  const h = mount({ agentStatus: 'idle' })
  const { exec, pty, markers } = await readySession(h, 'echo hi', { notifyOnExit: true })
  await closeFrame(h, pty, exec, markers, 3)

  const msg = h.wakes[0].message
  assert.equal(typeof msg.id, 'string', 'id 必须是非空字符串')
  assert.ok(msg.id.length > 0)
  assert.equal(msg.role, 'user', 'role 必须是 user')
  assert.equal(typeof msg.source?.kind, 'string', 'source.kind 必须是非空字符串')
  assert.ok(msg.source.kind.length > 0)
  assert.ok(Array.isArray(msg.content), 'content 必须是数组')
  assert.ok(msg.content.length > 0, 'content 不能是空数组')
  assert.equal(msg.content[0].type, 'text')
  // 唤醒消息必须带上"命令结束了、退出码是多少、去哪读输出"这三件事
  assert.match(msg.content[0].text, /exit code 3/, '消息必须带退出码')
  assert.match(msg.content[0].text, new RegExp(exec.sessionId), '消息必须带会话 id')
  assert.match(msg.content[0].text, /terminal_read/, '消息必须告诉调用方去哪读输出')
})

test('W5 一条命令只唤醒一次；每次唤醒都是新的 message id', async () => {
  const h = mount({ agentStatus: 'idle' })
  const { exec, pty, markers } = await readySession(h, 'echo hi', { notifyOnExit: true })
  await closeFrame(h, pty, exec, markers, 0)
  assert.equal(h.wakes.length, 1)

  // 再喂同样的结束标记：帧已闭合（pendingFrame 已置空）⇒ 不得重复送达
  pty.emit(`${markers.end}0${CRLF}`)
  await sleep(80)
  assert.equal(h.wakes.length, 1, '同一帧不得重复唤醒（幂等来自 pendingFrame 一次性）')

  // 第二条命令（新会话）→ 新唤醒，且 id 必须不同
  const second = await readySession(h, 'echo two', { notifyOnExit: true })
  await closeFrame(h, second.pty, second.exec, second.markers, 0)
  assert.equal(h.wakes.length, 2, '新命令应产生新唤醒')
  assert.notEqual(h.wakes[1].message.id, h.wakes[0].message.id, '每次唤醒必须是新的 message id')
})

test('W6 唤醒失败不得影响终端会话（通道是观测，不是产品功能）', async () => {
  const h = mount({ agentStatus: 'idle', followupThrows: true })
  const { exec, pty, markers } = await readySession(h, 'echo hi', { notifyOnExit: true })
  const record = await closeFrame(h, pty, exec, markers, 0)

  assert.equal(h.wakes.length, 0, 'followup 抛错 → 没有成功唤醒')
  assert.equal(record.pendingFrame, undefined, '帧必须已闭合（唤醒失败不回滚帧状态）')
  const state = await h.call('terminal_state', { sessionId: exec.sessionId }, h.owner)
  assert.equal(state.phase, 'running', '会话必须照常运行——唤醒失败绝不能影响终端本身')
})
test('W7 收口通知携带 endReason：自然收口 → endReason=natural（P1-NOTIFY-1）', async () => {
  // 三条收口路径（自然 / 人类触发 / 主动中断）必须可分辨，而这条异步唤醒是 agent
  // **唯一被动看到**的信号。这里钉住自然路径的取值；中断路径的收口事实记在 record.interrupt 上。
  const h = mount({ agentStatus: 'idle' })
  const { exec, pty, markers } = await readySession(h, 'echo hi', { notifyOnExit: true })
  await closeFrame(h, pty, exec, markers, 0)

  const text = h.wakes[0].message.content[0].text
  assert.match(text, /endReason=natural/, '帧自然闭合 → 通知必须写 endReason=natural')
  // 既有要求不得被削弱（W4 仍逐字段锁形状）：这里只补 endReason 这一条判据
  assert.match(text, /exit code 0/, '消息仍须带退出码')
  assert.match(text, new RegExp(exec.sessionId), '消息仍须带会话 id')
  assert.match(text, /terminal_read/, '消息仍须告诉调用方去哪读输出')
})

test('W8 取不到 lastCommand 时必须写 unknown，不得默认写 natural（源文本断言，局限见下）', async () => {
  // 局限：这条只看 lib/index.js 的构造源码，证明不了运行时会走到这个兜底分支。
  // 事实上**正常路径走不到**：onCommandSettled 只在帧自然闭合时触发，而那条路径总会先写下
  // lastCommand（lib/index.js:618-625）。所以这里锁的是"兜底写的是什么"，不是"兜底可达"；
  // 可达性由 W7 的实测取值覆盖。要真正覆盖 unknown 分支，得在集成层造出"帧闭合但
  // lastCommand 缺失"的记录——那需要改产品代码，不在本测试层。
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(
    source.includes("endReason=${record.lastCommand?.endReason ?? 'unknown'}"),
    '通知必须从 lastCommand 取 endReason，取不到写 unknown',
  )
  assert.equal(
    source.includes('endReason=natural'),
    false,
    '不得硬编码 endReason=natural —— 那等于把"不知道"伪装成"自然结束"',
  )
})

