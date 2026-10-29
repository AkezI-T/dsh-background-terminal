/**
 * 失败诊断冷测试（lib/diagnostic.mjs + 三个写入点）。
 *
 * 覆盖 task-6 的 D1-D7，以及审阅意见新增的三条：
 *   R001-06 结构化字段（sessionId/jobId/policyMode/shellDialect/provider/exitCode/hostErrorId）
 *   R001-02 `SANDBOX_PTY_START_FAILED` + `classifyStartupOutcome()` 三态
 *   R001-03 logEvent 关联字段（sessionId/jobId/phase）
 *
 * 全冷：假 PTY、假 spawn、假 sandbox，不起真实进程、不碰文件系统。
 * 每条断言都配了「非恒真」的对照（同一份数据在另一种条件下必须给出不同结果），
 * 否则"文本里有某字段"这类断言很容易永远为真。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DIAGNOSTIC_LIMITS,
  SANDBOX_PTY_START_FAILED,
  STARTUP_OUTCOMES,
  classifyStartupOutcome,
  createDiagnostics,
} from '../lib/diagnostic.mjs'
import { apply } from '../lib/index.js'
import { makeFakeCtx, makeFakeSpawn, makeOwnerCtx } from './helpers/fake-ctx.mjs'
import { READY_BEACON } from '../lib/shell-bash.mjs'

const SHELL = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

/** 等待条件成立（轮询宏任务），最多 tries 次。 */
async function until(predicate, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 1))
  }
  return predicate()
}

// ─────────────────────────────────────────────────────────────────────────────
// 插件级挂载：走真实的 toolExec → controller.begin → finish → terminal_read 链路
// ─────────────────────────────────────────────────────────────────────────────

function mountPlugin(opts = {}) {
  const tools = new Map()
  const jobs = new Map()
  let jobSeq = 0
  const spawn = makeFakeSpawn({ rejectWith: opts.spawnRejects })
  const ownerCtxs = new Map()

  const ctx = makeFakeCtx({
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    subprocess: { spawnTerminal: (spec) => spawn.spawnTerminal(spec) },
    // provider 标签由集成层从 sandbox 服务读出（审阅 R001-06 要求 provider 字段）
    sandbox: { provider: 'windows-acl', confine: async (argv) => ({ argv: ['windows-acl-run', '--', ...argv] }) },
    jobs: {
      start(spec) {
        jobSeq += 1
        const id = `terminal-${jobSeq}`
        const hooks = spec.run({ append() {}, updateProgress() {} })
        hooks.done.then(
          (outcome) => jobs.set(id, { status: outcome?.status, detail: outcome?.detail }),
          () => jobs.set(id, { status: 'failed', detail: 'producer rejected' }),
        )
        return id
      },
    },
  })

  // 显式选 `host` 后端：本文件用**假 ctx.subprocess.spawnTerminal** 驱动集成层，
  // 而产品默认后端（`node-pty`）会绕开这个假体去调真实 node-pty（受限沙箱下必 EPERM）。
  const runtime = apply(ctx, { shellPath: SHELL, shellDialect: 'pwsh', ptyBackend: 'host' })
  // makeFakeCtx 的 logger 闭包写它自己的 logs 数组，所以必须从 ctx 上取
  const logs = ctx.logs

  function agentFor(id = 'sess-1') {
    const session = { header: { cwd: 'F:/ws' } }
    let ownerCtx = ownerCtxs.get(id)
    if (ownerCtx === undefined) {
      ownerCtx = makeOwnerCtx({ id, session })
      ownerCtxs.set(id, ownerCtx)
    }
    return { id, session, ctx: ownerCtx }
  }

  const exec = (name, args, owner) => {
    const definition = tools.get(name)
    assert.ok(definition, `工具 ${name} 未注册`)
    // 测试统一注入极短 `waitMs`：产品默认是有界等待 10s，而这些用例走假 PTY
    // （帧永不闭合），不注入就得每条等满 10s。有界等待由 index.test.js 专门验证。
    const effective = name === 'terminal_exec' ? { waitMs: 1, ...args } : args
    return definition.execute(effective, { agent: owner, signal: undefined })
  }

  const recordOf = (owner) => runtime.admission.listForOwner(owner)[0]

  return { tools, runtime, spawn, jobs, logs, agentFor, exec, recordOf }
}

/** 起一个会话并等它真的就绪（served）。 */
async function startReadySession(h, owner) {
  const exec = await h.exec('terminal_exec', { command: 'echo hi' }, owner)
  h.spawn.lastPty.emit(`${READY_BEACON}\r\n`)
  const ready = await until(() => h.recordOf(owner)?.ready === true)
  assert.ok(ready, 'shell 必须先就绪，否则下面的用例会落到另一个分支')
  return exec
}

// ─────────────────────────────────────────────────────────────────────────────
// D1 有界
// ─────────────────────────────────────────────────────────────────────────────

test('D1 诊断有界：超长 argv/输出被截断，头尾都保留且带中间省略标记', () => {
  const record = { id: 'term-bounded', jobId: 'terminal-9' }
  const hugeArgv = ['runner', '--', 'ARG_HEAD_' + 'x'.repeat(3000) + 'ARG_MID_' + 'x'.repeat(3000) + 'ARG_TAIL']
  const hugeOutput = `OUT_HEAD_${'y'.repeat(1200)}_OUT_TAIL`
  const spec = {
    argv: hugeArgv,
    cwd: 'F:/ws',
    cols: 120,
    rows: 30,
    graceMs: 3000,
    confined: true,
    policyMode: 'workspace-write',
    shellDialect: 'pwsh',
    provider: 'windows-acl',
  }

  // 同一份数据、放开边界：数据本身完整 → 证明下面的"缺失"是截断造成的
  const unbounded = createDiagnostics({ maxChars: 100000 })
  unbounded.recordSpec(record, spec)
  unbounded.recordSpawn(record, { pid: 4242 })
  const full = unbounded.render(record, { exitCode: 127, signal: null, outputTail: hugeOutput })
  assert.ok(full.includes('ARG_MID_'), '放开边界时中段 token 必须在（否则本用例是空断言）')
  assert.ok(full.includes('ARG_TAIL'), '放开边界时 argv 尾部必须在')
  assert.ok(full.length > DIAGNOSTIC_LIMITS.maxChars, '这份数据必须确实超限')

  const diagnostics = createDiagnostics()
  diagnostics.recordSpec(record, spec)
  diagnostics.recordSpawn(record, { pid: 4242 })
  const text = diagnostics.render(record, { exitCode: 127, signal: null, outputTail: hugeOutput })

  assert.ok(text.length <= DIAGNOSTIC_LIMITS.maxChars, `诊断必须 ≤ ${DIAGNOSTIC_LIMITS.maxChars} 字符，实得 ${text.length}`)
  assert.ok(text.length > DIAGNOSTIC_LIMITS.maxChars * 0.75, '应当用满预算，而不是截成一小段')
  // 头在
  assert.match(text, /^\[bgterm diagnostics\]/)
  assert.ok(text.includes('ARG_HEAD_'), '头部必须保留（argv 开头）')
  // 尾在：定向提示完整收尾
  assert.ok(text.includes('windows-acl-run:" line.'), '尾部必须保留（127 提示的结尾）')
  assert.ok(text.endsWith('line.'), '截断必须从尾部原样保留，而不是把结尾砍掉')
  // 中间省略有标记，且计数为正
  const marker = text.match(/…\[(\d+) chars elided\]…/)
  assert.ok(marker, '中间必须有省略标记')
  assert.ok(Number(marker[1]) > 0, '省略计数必须为正')
  // 对照：被省略的中段确实不在（同一 token 在放开边界时是在的）
  assert.ok(!text.includes('ARG_MID_'), '中段 token 必须已被省略')
})

test('D1b 未超限时不截断、不出现省略标记：完整 argv 原样保留', () => {
  const diagnostics = createDiagnostics()
  const record = { id: 'term-small' }
  diagnostics.recordSpec(record, { argv: ['runner', '--', 'bash', '-i'], cwd: 'F:/ws', cols: 120, rows: 30, graceMs: 3000 })
  diagnostics.recordSpawn(record, { pid: 7 })
  const text = diagnostics.render(record, { exitCode: 1, signal: null, outputTail: 'boom' })
  assert.ok(text.length < DIAGNOSTIC_LIMITS.maxChars)
  assert.ok(!text.includes('chars elided'), '未超限不得出现省略标记')
  assert.ok(text.includes('"runner" "--" "bash" "-i"'), '未超限时 argv 必须完整')
})

// ─────────────────────────────────────────────────────────────────────────────
// D2 / D3 / D4：失败与成功路径（插件级，经 terminal_read）
// ─────────────────────────────────────────────────────────────────────────────

test('D2 exit 127：详情含 argv/pid/退出码/耗时 + RUNNER_FAILURE_EXIT 与 windows-acl-run 定向提示', async () => {
  const h = mountPlugin()
  const owner = h.agentFor()
  const exec = await h.exec('terminal_exec', { command: 'echo hi' }, owner)

  h.spawn.lastPty.exit(127, null)
  const settled = await until(() => h.recordOf(owner)?.phase === 'failed')
  assert.ok(settled, '起来就挂必须收口为 failed')

  const read = await h.exec('terminal_read', { sessionId: exec.sessionId }, owner)
  const detail = String(read.detail ?? '')

  assert.equal(read.exitCode, 127)
  assert.equal(read.status, 'failed')
  assert.match(detail, /argv: "windows-acl-run" "--"/, 'confine 后的完整 argv 必须在')
  assert.match(detail, /spawn: ok pid=4242/)
  assert.match(detail, /exitCode=127/)
  assert.match(detail, /elapsed=\d+ms \(spawn → exit\)/)
  assert.match(detail, /RUNNER_FAILURE_EXIT/, '必须点明 127 是 runner 自己的失败码')
  assert.match(detail, /windows-acl-run:/, '必须指向宿主日志里的 windows-acl-run 行')
  assert.match(detail, new RegExp(SANDBOX_PTY_START_FAILED), '必须给出稳定的启动失败码')
})

test('D2b 差分：同一份证据换个退出码，127 提示必须消失', () => {
  const diagnostics = createDiagnostics()
  const record = { id: 'term-127' }
  diagnostics.recordSpec(record, { argv: ['runner', '--', 'bash'], cwd: 'F:/ws', cols: 120, rows: 30, graceMs: 3000 })
  diagnostics.recordSpawn(record, { pid: 11 })

  const text127 = diagnostics.render(record, { exitCode: 127, signal: null })
  const text1 = diagnostics.render(record, { exitCode: 1, signal: null })
  assert.match(text127, /RUNNER_FAILURE_EXIT/)
  assert.ok(!text1.includes('RUNNER_FAILURE_EXIT'), '非 127 不得出现 runner 失败码提示')
  assert.match(text1, /exitCode=1/)
})

test('D3 exit 0：成功路径不附加诊断，detail 保持原样', async () => {
  const h = mountPlugin()
  const owner = h.agentFor()
  const exec = await startReadySession(h, owner)

  h.spawn.lastPty.exit(0, null)
  const settled = await until(() => h.recordOf(owner)?.phase === 'exited')
  assert.ok(settled, '自然退出必须走完 finish')

  const read = await h.exec('terminal_read', { sessionId: exec.sessionId }, owner)
  assert.equal(read.status, 'exited')
  assert.equal(read.detail, 'exit code 0', '成功路径 detail 必须一字不改（不附加诊断）')
  assert.ok(!String(read.detail).includes('[bgterm diagnostics]'))

  // 非恒真对照：同一个 record 的证据链确实记过东西——只是成功路径不附加
  const record = h.recordOf(owner)
  const manual = h.runtime.diagnostics.render(record, { exitCode: 127, signal: null })
  assert.ok(typeof manual === 'string' && manual.includes('argv:'), '证据确实存在，说明 D3 的"没有"来自成功路径判定')
})

test('D4 spawn 抛错：返回 startup-failed，详情含错误 code/message、argv 与启动失败码', async () => {
  const error = new Error('terminal spawn unsupported by sandbox runner')
  error.code = 'SANDBOX_PTY_UNSUPPORTED'
  const h = mountPlugin({ spawnRejects: error })
  const owner = h.agentFor()

  // 契约变更（R001-02）：宿主拒绝创建 PTY 时返回 startup-failed + 诊断，而不是裸抛。
  const result = await h.exec('terminal_exec', { command: 'echo hi' }, owner)
  assert.equal(result.status, 'startup-failed')
  assert.equal(result.code, SANDBOX_PTY_START_FAILED)
  assert.match(String(result.diagnostics ?? ''), /SANDBOX_PTY_UNSUPPORTED/, '必须带宿主侧的错误 code')
  const record = h.recordOf(owner)
  assert.ok(record, '失败的会话仍可查到')

  const read = await h.exec('terminal_read', { sessionId: record.id }, owner)
  const detail = String(read.detail ?? '')
  assert.equal(read.status, 'failed')
  assert.match(detail, /code=SANDBOX_PTY_UNSUPPORTED/, '必须带错误 code')
  assert.match(detail, /message="terminal spawn unsupported by sandbox runner"/, '必须带错误 message')
  assert.match(detail, /argv: "windows-acl-run" "--"/, 'spawn spec 的 argv 必须在')
  assert.match(detail, /spawn: failed/, '必须如实标注 spawn 失败（没有 pid）')
  assert.match(detail, new RegExp(SANDBOX_PTY_START_FAILED))

  // 非恒真对照：换一个 code，详情必须跟着变
  const other = mountPlugin({ spawnRejects: Object.assign(new Error('nope'), { code: 'EACCES' }) })
  const otherOwner = other.agentFor()
  const otherResult = await other.exec('terminal_exec', { command: 'echo hi' }, otherOwner)
  assert.equal(otherResult.status, 'startup-failed')
  const otherDetail = String((await other.exec('terminal_read', { sessionId: other.recordOf(otherOwner).id }, otherOwner)).detail ?? '')
  assert.match(otherDetail, /code=EACCES/)
  assert.ok(!otherDetail.includes('SANDBOX_PTY_UNSUPPORTED'), 'code 不是写死的常量')
})

// ─────────────────────────────────────────────────────────────────────────────
// D5 耗时
// ─────────────────────────────────────────────────────────────────────────────

test('D5 耗时字段：假 PTY 控制 40ms，elapsed 反映真实经过时间', async () => {
  const h = mountPlugin()
  const owner = h.agentFor()
  const exec = await h.exec('terminal_exec', { command: 'echo hi' }, owner)

  await new Promise((r) => setTimeout(r, 40))
  h.spawn.lastPty.exit(127, null)
  await until(() => h.recordOf(owner)?.phase === 'failed')

  const read = await h.exec('terminal_read', { sessionId: exec.sessionId }, owner)
  const match = String(read.detail ?? '').match(/elapsed=(\d+)ms \(spawn → exit\)/)
  assert.ok(match, '必须带 spawn → exit 的耗时字段')
  const elapsed = Number(match[1])
  assert.ok(Number.isFinite(elapsed), '耗时必须是数字')
  assert.ok(elapsed >= 25, `耗时必须反映真实等待（≥25ms），实得 ${elapsed}ms`)
})

test('D5b 耗时数值精确来自时钟（注入 now）：不是占位常量', () => {
  let clock = 1000
  const diagnostics = createDiagnostics({ now: () => clock })
  const record = { id: 'term-clock' }
  diagnostics.recordSpec(record, { argv: ['bash'], cols: 120, rows: 30, graceMs: 3000 })
  clock = 1042 // spawn 成功
  diagnostics.recordSpawn(record, { pid: 5 })
  clock = 1099 // 退出后渲染
  const text = diagnostics.render(record, { exitCode: 127, signal: null })
  assert.match(text, /elapsed=57ms \(spawn → exit\)/)
  assert.ok(!text.includes('elapsed=0ms'), '不能是占位常量')
})

// ─────────────────────────────────────────────────────────────────────────────
// D6 永不抛
// ─────────────────────────────────────────────────────────────────────────────

test('D6 循环引用 / 超长值 / 抛错 getter：诊断不抛错且仍有界', () => {
  const diagnostics = createDiagnostics()
  const record = { id: 'term-circular' }

  const argv = ['bash', '-i']
  argv.push(argv) // 数组自引用
  const spec = { argv, cwd: 'F:/ws', cols: 120, rows: 30, graceMs: 3000 }
  spec.self = spec // 对象自引用
  spec.cwd = { get boom() { throw new Error('getter exploded') } } // 取值器抛错

  const error = new Error('spawn exploded')
  error.code = 'ENOENT'
  error.self = error // Error 自引用
  error.details = { nested: { deeper: error } }

  assert.doesNotThrow(() => diagnostics.recordSpec(record, spec))
  assert.doesNotThrow(() => diagnostics.recordSpawn(record, { error }))
  assert.doesNotThrow(() => diagnostics.recordSpec(null, spec))
  assert.doesNotThrow(() => diagnostics.recordSpawn(undefined, { error }))
  assert.doesNotThrow(() => diagnostics.render(42, { exitCode: 127 }))

  let text
  assert.doesNotThrow(() => {
    text = diagnostics.render(record, { exitCode: 127, signal: null, outputTail: 'z'.repeat(5000) })
  })
  assert.equal(typeof text, 'string')
  assert.ok(text.length <= DIAGNOSTIC_LIMITS.maxChars)
  assert.match(text, /code=ENOENT/)
  // 确实走到了循环分支，而不是靠异常兜底
  assert.ok(text.includes('[Circular]'), '自引用必须被标记为 [Circular]')
  assert.ok(text.includes('threw: getter exploded') || text.includes('getter exploded'), '取值器抛错必须被就地兜住')
})

test('D6b 无证据时 render 返回 undefined：不制造空诊断块', () => {
  const diagnostics = createDiagnostics()
  assert.equal(diagnostics.render({ id: 'never-touched' }, { exitCode: 127 }), undefined)
})

// ─────────────────────────────────────────────────────────────────────────────
// R001-06 结构化字段
// ─────────────────────────────────────────────────────────────────────────────

test('R001-06 失败详情带独立结构化字段（sessionId/jobId/policyMode/shellDialect/provider/exitCode/hostErrorId）', async () => {
  const h = mountPlugin()
  const owner = h.agentFor()
  const exec = await h.exec('terminal_exec', { command: 'echo hi' }, owner)
  h.spawn.lastPty.exit(127, null)
  await until(() => h.recordOf(owner)?.phase === 'failed')

  const read = await h.exec('terminal_read', { sessionId: exec.sessionId }, owner)
  const detail = String(read.detail ?? '')
  assert.match(detail, new RegExp(`^sessionId: ${exec.sessionId}$`, 'm'))
  assert.match(detail, new RegExp(`^jobId: ${exec.jobId}$`, 'm'))
  assert.match(detail, /^policyMode: workspace-write$/m)
  // 断言"如实上报**实际配置的**方言"，不硬编码某个值（夹具方言须与平台能力一致）
  assert.match(detail, new RegExp(`^shellDialect: ${h.runtime.config.shellDialect}$`, 'm'))
  assert.match(detail, /^provider: windows-acl$/m, 'provider 必须来自沙箱服务，而不是写死')
  assert.match(detail, /^exitCode: 127$/m)
  assert.match(detail, /^hostErrorId: \(none\)$/m, '宿主没给 hostErrorId 时必须显式写 none')

  // 同一个诊断器的结构化取值也要能独立取到（不只埋在文本里）
  const fields = h.runtime.diagnostics.describe(h.recordOf(owner), { exitCode: 127, signal: null })
  assert.equal(fields.sessionId, exec.sessionId)
  assert.equal(fields.jobId, exec.jobId)
  assert.equal(fields.policyMode, 'workspace-write')
  assert.equal(fields.shellDialect, h.runtime.config.shellDialect)
  assert.equal(fields.provider, 'windows-acl')
  assert.equal(fields.exitCode, 127)
  assert.equal(fields.hostErrorId, undefined)
})

// ─────────────────────────────────────────────────────────────────────────────
// R001-02 三态判定
// ─────────────────────────────────────────────────────────────────────────────

test('R001-02 classifyStartupOutcome 三态：starting / startup-failed / running 都可区分', async () => {
  assert.deepEqual([...STARTUP_OUTCOMES], ['starting', 'startup-failed', 'running'])
  assert.equal(SANDBOX_PTY_START_FAILED, 'SANDBOX_PTY_START_FAILED')

  // 纯函数层：三态各有明确判据
  assert.equal(classifyStartupOutcome({ spawnAttempted: true, spawnFinished: false }), 'starting')
  assert.equal(classifyStartupOutcome({ spawnAttempted: true, spawnFinished: true, ptyCreated: true }), 'starting')
  assert.equal(classifyStartupOutcome({ spawnError: new Error('refused'), spawnAttempted: true, spawnFinished: true }), 'startup-failed')
  assert.equal(classifyStartupOutcome({ spawnAttempted: true, spawnFinished: true, ptyCreated: false }), 'startup-failed')
  assert.equal(classifyStartupOutcome({ spawnAttempted: true, spawnFinished: true, ptyCreated: true, ptyExited: true }), 'startup-failed')
  assert.equal(classifyStartupOutcome({ spawnAttempted: true, spawnFinished: true, ptyCreated: true, ptyExited: true, served: true }), 'running')
  // 取消不是宿主拒绝：调用方自己关的会话不得被报成启动失败
  assert.equal(classifyStartupOutcome({ cancelRequested: 'user', spawnAttempted: true, spawnFinished: true, ptyCreated: false }), 'starting')
  // 永不抛
  assert.equal(classifyStartupOutcome(undefined), 'starting')
  assert.equal(classifyStartupOutcome({ get served() { throw new Error('boom') } }), 'starting')

  // 集成层：spawn 被宿主拒绝时，terminal_exec 返回 startup-failed（R001-02 的对外契约）
  const h = mountPlugin({ spawnRejects: Object.assign(new Error('refused'), { code: 'SANDBOX_PTY_UNSUPPORTED' }) })
  const owner = h.agentFor()
  const refused = await h.exec('terminal_exec', { command: 'echo hi' }, owner)
  assert.equal(refused.status, 'startup-failed', '宿主拒绝必须对外报 startup-failed')
  assert.equal(refused.code, SANDBOX_PTY_START_FAILED)
  assert.equal(classifyStartupOutcome(h.recordOf(owner)), 'startup-failed')

  // 集成层：正常就绪的会话判定为 running（否则上面的 startup-failed 无法证明判据有效）
  const ok = mountPlugin()
  const okOwner = ok.agentFor()
  await startReadySession(ok, okOwner)
  assert.equal(classifyStartupOutcome(ok.recordOf(okOwner)), 'running')
})

// ─────────────────────────────────────────────────────────────────────────────
// R001-03 日志关联字段
// ─────────────────────────────────────────────────────────────────────────────

test('R001-03 logEvent 每条日志都带 sessionId / jobId / phase 关联字段', async () => {
  const h = mountPlugin()
  const owner = h.agentFor()
  const exec = await startReadySession(h, owner)
  h.spawn.lastPty.exit(127, null)
  await until(() => h.recordOf(owner)?.phase === 'failed')

  const text = h.logs.map(([, line]) => line).join('\n')
  const spawnOk = h.logs.find(([, line]) => line.includes('spawn ok'))
  assert.ok(spawnOk, `应有 spawn ok 日志，实得：\n${text}`)
  assert.match(spawnOk[1], /sessionId/, 'spawn ok 必须带 sessionId')
  assert.match(spawnOk[1], /jobId/, 'spawn ok 必须带 jobId')
  assert.match(spawnOk[1], /phase/, 'spawn ok 必须带 phase')
  assert.ok(spawnOk[1].includes(exec.sessionId), '关联值必须是真实 sessionId')
  assert.ok(spawnOk[1].includes(exec.jobId), '关联值必须是真实 jobId')

  assert.match(text, /shell exited during startup|spawn ok/, '生命周期事件必须落日志')
})

// ─────────────────────────────────────────────────────────────────────────────
// D7 集成：启动期崩溃时 terminal_read 的 detail 必须含 argv（index.test.js S3b 的同款断言）
// ─────────────────────────────────────────────────────────────────────────────

test('D7 启动期崩溃（served 之后 exit 127）：detail 含 argv + 结构化字段 + 127 提示', async () => {
  const h = mountPlugin()
  const owner = h.agentFor()
  const exec = await startReadySession(h, owner)

  h.spawn.lastPty.emit('windows-acl-run: terminal spawn unsupported\r\n')
  h.spawn.lastPty.exit(127, null)
  const settled = await until(() => {
    const record = h.recordOf(owner)
    return record !== undefined && record.phase !== 'starting' && record.phase !== 'running'
  })
  assert.ok(settled, 'shell 崩溃必须被收口')

  const read = await h.exec('terminal_read', { sessionId: exec.sessionId }, owner)
  const detail = String(read.detail ?? '')
  assert.equal(read.exitCode, 127)
  assert.match(detail, /argv: "windows-acl-run" "--"/, 'D7：detail 必须含 argv')
  assert.match(detail, /spawn: ok pid=4242/)
  assert.match(detail, /^sessionId: /m)
  assert.match(detail, /^jobId: /m)
  assert.match(detail, /windows-acl-run/)
  assert.match(detail, /RUNNER_FAILURE_EXIT/)

  // 对照：成功退出（exit 0）时同样的会话不会出现这些字段
  const ok = mountPlugin()
  const okOwner = ok.agentFor()
  const okExec = await startReadySession(ok, okOwner)
  ok.spawn.lastPty.exit(0, null)
  await until(() => ok.recordOf(okOwner)?.phase === 'exited')
  const okRead = await ok.exec('terminal_read', { sessionId: okExec.sessionId }, okOwner)
  assert.equal(okRead.detail, 'exit code 0')
})

// ─────────────────────────────────────────────────────────────────────────────
// D8 PTY 尾部语义：给的是"最后 300 字符"，不是输出开头
// ─────────────────────────────────────────────────────────────────────────────

test('D8 输出尾部取自末尾：长输出崩溃时诊断给的是最后一段，而不是开头', async () => {
  const h = mountPlugin()
  const owner = h.agentFor()
  const exec = await h.exec('terminal_exec', { command: 'echo hi' }, owner)

  const head = 'HEAD_ONLY_TOKEN'
  const tail = 'TAIL_ONLY_TOKEN'
  h.spawn.lastPty.emit(`${head} ${'x'.repeat(600)} ${tail}\r\n`)
  const pumped = await until(() => (h.recordOf(owner)?.pump?.totalBytes?.() ?? 0) > 0)
  assert.ok(pumped, '输出必须先进 ring，否则本用例是空断言')

  h.spawn.lastPty.exit(127, null)
  await until(() => h.recordOf(owner)?.phase === 'failed')
  const read = await h.exec('terminal_read', { sessionId: exec.sessionId }, owner)

  // 只看诊断块：detail 前缀里的 captured output 是另一条既有路径（头部窗口）
  const detail = String(read.detail ?? '')
  const block = detail.slice(detail.indexOf('[bgterm diagnostics]'))
  assert.ok(block.startsWith('[bgterm diagnostics]'), '失败详情必须带诊断块')
  assert.ok(block.includes(tail), '诊断必须给输出末尾')
  assert.ok(!block.includes(head), '诊断不得退回到输出开头')
})

// ─────────────────────────────────────────────────────────────────────────────
// 硬约束：诊断不引入外部依赖
// ─────────────────────────────────────────────────────────────────────────────

test('硬约束：diagnostic.mjs 只 import node:* 与相对路径，不碰 @deepseek-ai/*', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/diagnostic.mjs', import.meta.url), 'utf8')
  const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith('node:') || specifier.startsWith('.'),
      `非法依赖 ${specifier}：只允许 node:* 与相对路径`,
    )
    assert.ok(!specifier.startsWith('@deepseek-ai/'), `不得依赖 ${specifier}`)
  }
})

