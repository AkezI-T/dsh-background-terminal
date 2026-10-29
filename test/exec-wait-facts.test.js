/**
 * terminal_exec 六条返回路径的两个事实字段（P1-EXEC-1 / 文档 §2.1 D1）。
 *
 * 契约：`commandSettled` 与 `waitExpired` 分开回答「这次调用为什么返回」——
 *   · 命令在等待窗口内结束（拿到真实的命令帧闭合，有命令级 exit code）
 *        → commandSettled: true,  waitExpired: false（**与退出码是否为 0 无关**）
 *   · 窗口到期、命令仍在跑                    → false, true
 *   · 启动未就绪（已发布未就绪 / 启动门超时）  → false, false
 *   · 启动失败（spawn 被拒 / 发布后未就绪即死）→ false, false
 * 硬约束：**二者互斥**，任何路径都不得同时为 true。
 * 契约点名两个易错点，本文件专测：① 互斥性；② 启动未就绪**不算** waitExpired
 * （那是启动门的事，混为一谈正是文档 §2.1 要消灭的「分不清为什么返回」）。
 *
 * 路径数：**6 条**（契约初稿写 4 条是数错了；两条 startup-failed 的 note 文案不同，
 * 只看见一条就会漏）。本文件按源码复核的实际 6 条各驱动一次。
 *
 * 做法：假 ctx + 假 PTY **真的驱动 toolExec**，不是源文本断言（源文本断言只用于下面
 * E9 那条互补的互斥扫描）。
 *
 * 局限（诚实声明）：
 *   1. 假 PTY：路径 6 的「命令结束」是用帧标记**模拟**的，不是真 shell 执行；
 *   2. E8（说明面）只看**注册出去的 description 文本**，证明不了运行时行为；
 *   3. E9 是源文本扫描，且计数含说明文本里 `字段名:` 的写法，只当"下限"用——
 *      行为级覆盖由 E1~E7 提供；
 *   4. 不覆盖 setup 阶段**抛错**的路径（confine 失败 / 容量拒绝）：那些不返回对象。
 *
 * 反向判别力（claim 时快照，2026-10-05）：`commandSettled` / `waitExpired` 在
 * lib 与 test 里命中数为 **0**（只在 docs 里出现）。当时 6 个 return 对象一个都没有这两个键，
 * 所以 E1~E7、E9 在改动前必然全红（typeof 断言当场就会失败）。
 *
 * 全冷：假 spawn / 假 PTY，不创建真实进程。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { apply } from '../lib/index.js'
import { makeFakePty, makeFakeSpawn } from './helpers/fake-ctx.mjs'

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

/**
 * 等一个 promise，同时握住事件循环。
 *
 * 为什么必须：`raceStart` 的启动门超时定时器是 **unref()** 的（见 lib/index.js），
 * 若此刻事件循环上没有其它引用型句柄，进程会直接退出——本文件第一版就因此在 E5 之后
 * 被 node:test 判成 **cancelled**（不是 failed，很容易误读成"没跑到"）。
 */
async function withKeepAlive(promise) {
  const ticker = setInterval(() => {}, 10)
  try {
    return await promise
  } finally {
    clearInterval(ticker)
  }
}

/** 帧标记：从写入的 stdin 里取 start/end（真值来源）。 */
function markersOf(written) {
  const start = /__DSH_BGTERM_[0-9a-f-]+_S__/.exec(written)?.[0]
  const end = /__DSH_BGTERM_[0-9a-f-]+_E__/.exec(written)?.[0]
  return { start, end }
}

/**
 * 假 ctx 挂载插件。startupGraceMs / startTimeoutMs 压小，启动门那两条路径才跑得快。
 */
function mount(opts = {}) {
  const { spawnRejects = null, ...config } = opts
  const tools = new Map()
  const jobs = new Map()
  const spawn = makeFakeSpawn({ rejectWith: spawnRejects ?? undefined })
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
        jobs.set(id, { id, status: 'running' })
        // 真注册表同步调用 run(handle) 并立刻读 hooks；失败不得冒泡成未处理拒绝
        const hooks = spec.run({ append() {}, updateProgress() {} })
        hooks.done?.then(() => {}, () => {})
        return id
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
    ...config,
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
  return { tools, jobs, spawn, runtime, owner, call }
}

/** 装一个会返回假 PTY 的 spawn。 */
function usePty(h, pty) {
  h.spawn.spawnTerminal = async (spec) => {
    h.spawn.spawnCalls.push(spec)
    return pty.handle
  }
}

/**
 * 两个字段的存在性 + 类型 + 互斥 + 期望取值，一次断言到位。
 * 路径漏加字段时，typeof 断言会直接点名是哪条路径缺哪个键。
 */
function assertFacts(result, expected, label) {
  for (const key of ['commandSettled', 'waitExpired']) {
    assert.equal(typeof result[key], 'boolean', `${label}: ${key} 必须是布尔（该路径漏加字段）`)
  }
  assert.equal(result.commandSettled, expected.commandSettled, `${label}: commandSettled`)
  assert.equal(result.waitExpired, expected.waitExpired, `${label}: waitExpired`)
  // 契约硬约束：二者互斥
  assert.equal(
    result.commandSettled && result.waitExpired,
    false,
    `${label}: 两个字段不得同时为 true（契约要求互斥）`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 路径 6：命令在等待窗口内结束（settled=true / expired=false）
// ─────────────────────────────────────────────────────────────────────────────

/** 起一次 exec、让 shell 就绪（首条命令被写入），返回待决调用与帧标记。 */
async function startReady(h, args) {
  const pty = makeFakePty()
  usePty(h, pty)
  const pending = h.call('terminal_exec', args)
  pty.emit(READY_BEACON + CRLF)
  const written = await until(() => pty.writeCalls().length >= 2)
  assert.ok(written, '驱动前提：信标之后 shell 应写入首条命令')
  return { pty, pending, markers: markersOf(pty.writeCalls()[1]) }
}

/** 模拟真实 shell 收口一帧：先回显命令行（start 标记因此进入窗口），再打结束标记与退出码。 */
function closeFrame(pty, markers, exitCode) {
  pty.emit(`${pty.writeCalls()[1]}`)
  pty.emit(`${CRLF}done${CRLF}${markers.end}${exitCode}${CRLF}`)
}

test('E1 路径6 命令在窗口内结束（exit 0）→ commandSettled=true, waitExpired=false', async () => {
  const h = mount()
  const { pty, pending, markers } = await startReady(h, { command: 'echo hi', waitMs: 800 })
  assert.ok(markers.end, '必须能取到帧结束标记')
  closeFrame(pty, markers, 0)

  const result = await pending
  assertFacts(result, { commandSettled: true, waitExpired: false }, 'E1')
  assert.equal(result.status, 'completed', '退出码 0 → completed')
  assert.equal(result.commandExitCode, 0, 'settled 的含义是拿到了命令级退出码')
})

test('E2 路径6 非 0 退出码同样算 settled（与退出码是否为 0 无关）', async () => {
  const h = mount()
  const { pty, pending, markers } = await startReady(h, { command: 'exit 3', waitMs: 800 })
  closeFrame(pty, markers, 3)

  const result = await pending
  assertFacts(result, { commandSettled: true, waitExpired: false }, 'E2')
  assert.equal(result.status, 'failed', '非 0 → failed（这是会话/命令生命周期，与 settled 是两件事）')
  assert.equal(result.commandExitCode, 3, '必须带真实的命令级退出码')
})

// ─────────────────────────────────────────────────────────────────────────────
// 路径 5：窗口到期、命令仍在跑（settled=false / expired=true）
// ─────────────────────────────────────────────────────────────────────────────

test('E3 路径5 窗口到期而命令仍在跑 → commandSettled=false, waitExpired=true', async () => {
  const h = mount()
  const { pending } = await startReady(h, { command: 'sleep 100', waitMs: 120 })
  const result = await pending

  assertFacts(result, { commandSettled: false, waitExpired: true }, 'E3')
  assert.equal(result.status, 'running', '命令没结束 → running')
})
// ─────────────────────────────────────────────────────────────────────────────
// 路径 4 / 2：两条 starting（启动未就绪 ≠ waitExpired —— 契约点名的易错点）
// ─────────────────────────────────────────────────────────────────────────────

test('E4 路径4 已发布但 shell 未就绪 → starting，waitExpired=false', async () => {
  const h = mount()
  const pty = makeFakePty()
  usePty(h, pty)
  // 刻意不发就绪信标：PTY 已发布、shell 未就绪，启动观察窗走完
  const result = await h.call('terminal_exec', { command: 'echo hi', waitMs: 1 })

  assert.equal(result.status, 'starting', '未就绪 → starting')
  assertFacts(result, { commandSettled: false, waitExpired: false }, 'E4（启动未就绪不得算 waitExpired）')
})

test('E5 路径2 启动门超时（另一条 starting）→ waitExpired=false', async () => {
  const h = mount({ startTimeoutMs: 60 })
  // 永不发布：startGate 不落定 → raceStart 超时。这条与 E4 是**两条不同的** starting 路径。
  h.spawn.spawnTerminal = () => new Promise(() => {})
  const result = await withKeepAlive(h.call('terminal_exec', { command: 'echo hi', waitMs: 1 }))

  assert.equal(result.status, 'starting')
  // note 只用来区分是哪条 starting（文案差异是这两条路径唯一的可观测差别）
  assert.match(String(result.note), /not published/i, '应当是"启动门超时"那条 starting')
  assertFacts(result, { commandSettled: false, waitExpired: false }, 'E5（启动门超时不等于命令等待到期）')
})

// ─────────────────────────────────────────────────────────────────────────────
// 路径 1 / 3：两条 startup-failed（note 文案不同，只按 status 与字段锚定）
// ─────────────────────────────────────────────────────────────────────────────

test('E6 路径1 spawn 被宿主拒绝 → startup-failed，waitExpired=false', async () => {
  const h = mount({ spawnRejects: Object.assign(new Error('terminal spawn unsupported'), { code: 'SANDBOX_PTY_UNSUPPORTED' }) })
  const result = await h.call('terminal_exec', { command: 'echo hi', waitMs: 1 })

  assert.equal(result.status, 'startup-failed')
  assertFacts(result, { commandSettled: false, waitExpired: false }, 'E6')
})

test('E7 路径3 已发布但未就绪即死（宿主拒绝 PTY）→ startup-failed，waitExpired=false', async () => {
  const h = mount({ startupGraceMs: 200 })
  const pty = makeFakePty()
  usePty(h, pty)
  const pending = h.call('terminal_exec', { command: 'echo hi', waitMs: 1 })
  await sleep(5)
  pty.exit(127, null) // 真机形态：exit 127 + 零输出
  const result = await pending

  assert.equal(result.status, 'startup-failed')
  assertFacts(result, { commandSettled: false, waitExpired: false }, 'E7')
})

// ─────────────────────────────────────────────────────────────────────────────
// 说明面 + 源文本互斥扫描
// ─────────────────────────────────────────────────────────────────────────────

test('E8 说明面：terminal_exec 的 description 讲清 status 与两个字段的分工', () => {
  const h = mount()
  const description = h.tools.get('terminal_exec')?.description
  assert.equal(typeof description, 'string', 'terminal_exec 必须注册且带说明')
  assert.ok(description.includes('commandSettled'), '说明必须出现 commandSettled')
  assert.ok(description.includes('waitExpired'), '说明必须出现 waitExpired')

  // 作用域 = 含 commandSettled 的**整条 bullet**（说明是按行 join 的）。
  // 早先这里用"字段名前后各 400 字"的窗口，结果分工那句话正好落在窗口之外 —— 窗口切在
  // "status describes the session/command lifecyc" 中间，于是断言误报。按 bullet 取才是对的。
  const bullet = description.split(/\r?\n/).filter((line) => line.includes('commandSettled')).join('\n')
  assert.notEqual(bullet, '', '说明必须出现 commandSettled')
  assert.ok(bullet.includes('waitExpired'), '同一条 bullet 必须同时给出两个字段')
  assert.ok(
    [
      /status[^.]{0,240}(lifecycle|life cycle)[^.]{0,240}(why|reason)/i,
      // 措辞不冻结：'came back' 与 'returned' 都是"为什么返回"的正常说法
      /(why|reason)[^.]{0,200}(this|the) call[^.]{0,80}(came back|come back|return|returned)/i,
      /(why|reason)[^.]{0,120}(came back|come back|return|returned)[^.]{0,200}status/i,
      /status[^.]{0,300}(why|reason)[^.]{0,200}(came back|come back|return|returned)/i,
    ].some((pattern) => pattern.test(bullet)),
    `说明必须讲清分工：status 说会话/命令的生命周期，两个字段说"这次调用为什么返回"；实际是：\n${bullet}`,
  )
})

test('E9 源文本互斥扫描：不得有返回对象把两个字段同时写成 true（局限见文件头）', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')

  const bothTrue = /commandSettled:\s*true\s*,\s*waitExpired:\s*true/.test(source)
    || /waitExpired:\s*true\s*,\s*commandSettled:\s*true/.test(source)
  assert.equal(bothTrue, false, '任何返回对象都不得同时为 true')

  // 六个返回点都成对写了这两个字段（漏一个键 = 那条路径没做）。
  // 按结构取字段名，不依赖缩进与 note 文案；计数只当"下限"（说明文本里若有 `字段名:` 的写法会抬高它）。
  const settled = (source.match(/commandSettled:/g) ?? []).length
  const expired = (source.match(/waitExpired:/g) ?? []).length
  assert.ok(settled >= 6, `commandSettled 至少出现在 6 个返回点，实得 ${settled}`)
  assert.ok(expired >= 6, `waitExpired 至少出现在 6 个返回点，实得 ${expired}`)
})


