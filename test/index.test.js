/**
 * 集成层测试（lib/index.js）。
 *
 * 覆盖跨模块接缝：工具注册、admission-first 时序、confine 接线、
 * 队列 flush、终态视图、输入限流、信号语义、沙箱闸门。
 *
 * 全冷：假 spawnTerminal、假 jobs、假 sandbox —— 不创建真实进程。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

import { apply } from '../lib/index.js'
import { makeFakePty, makeFakeSpawn, makeFakeCtx, makeOwnerCtx } from './helpers/fake-ctx.mjs'
import { READY_BEACON, extractFrame, wrapCommand } from '../lib/shell-bash.mjs'
import { snapshotSession } from '../lib/session-state.mjs'

/** 启动序列与命令都以 CR 结尾写入 PTY。 */
const CRLF = '\r\n'

const SHELL = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

/**
 * ctx 自身的框架方法（不是服务，不需要 inject）。
 * 与 mountPlugin 里的严格代理共用同一份定义，避免两处漂移。
 */
const FRAMEWORK_KEYS = new Set(['on', 'off', 'effect', 'get', 'inject', 'logger', 'then'])

/** 等待若干微任务/宏任务，让 controller 的异步分支推进。 */
async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

/** 等待条件成立（轮询微任务），最多 tries 次。 */
async function until(predicate, tries = 50) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 1))
  }
  return predicate()
}

/**
 * 让假 shell 走完"就绪"这一步：发信标，并**等到 ready 真的置位**。
 *
 * 不能只发信标就往下走：pump 的数据投递是异步的，若紧接着让 shell 退出，
 * 控制器结算时 `ready` 可能还没置位——那会被正确地判成"启动期失败"，
 * 于是测试想验证的"自然退出"就变成了另一个场景（这类假失败很能浪费时间）。
 */
async function makeReady(pty, runtime, owner) {
  pty.emit(READY_BEACON + CRLF)
  return until(() => runtime.admission.listForOwner(owner)[0]?.ready === true)
}

/**
 * 装出一个够真的假 ctx 并挂载插件。
 *
 * `agentFor(id)` 返回 owner 对象时会带上 `ctx`（含 `on()`），因为沙箱模式围栏
 * 在 reserve 阶段就要往 `owner.ctx` 上挂 `internal/dispatch` 监听——缺 `on()`
 * 时围栏按设计 fail-closed 抛错（那是正确行为，不是测试可以绕过的）。
 *
 * @param {{confinement?:boolean, spawnRejects?:Error, manualSpawn?:boolean}} [opts]
 * @param {object} [rawConfig] 默认显式选 `host` 后端：本文件用**假 ctx.subprocess.spawnTerminal**
 *   驱动集成层，而产品默认后端（`node-pty`）会绕开这个假体去调真实的 node-pty，
 *   在受限沙箱下必然 EPERM。直连后端的真正验收在 `tools/probe-acceptance.mjs`
 *   （需非受限环境），此处只测不依赖真派生的部分。
 */
function mountPlugin(opts = {}, rawConfig = { shellPath: SHELL, shellDialect: 'pwsh', ptyBackend: 'host' }) {
  const tools = new Map()
  const spawn = makeFakeSpawn({ manual: opts.manualSpawn === true, rejectWith: opts.spawnRejects })
  const ownerCtxs = new Map()

  const jobs = new Map()
  let jobSeq = 0
  const jobCancels = []

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
        jobs.set(id, { spec, status: 'running' })
        // 真注册表同步调用 run(handle)，并立刻读 hooks.done / hooks.cancel
        const hooks = spec.run({ append() {}, updateProgress() {} })
        assert.equal(typeof hooks.done?.then, 'function', 'hooks.done 必须是 Promise')
        assert.equal(typeof hooks.cancel, 'function', 'hooks.cancel 必须是函数')
        hooks.done.then(
          (outcome) => {
            const job = jobs.get(id)
            job.status = outcome?.status
            job.detail = outcome?.detail
          },
          (error) => {
            const job = jobs.get(id)
            job.status = 'failed'
            job.detail = `producer rejected: ${String(error)}`
          },
        )
        jobCancels.push((reason) => hooks.cancel(reason))
        return id
      },
    },
  }

  // 与真实 Cordis 一致：直接属性读只对 inject 里声明过的服务成立。
  // `sandbox` / `logger` 是**可选**服务，必须留在 declared 之外、只能经 ctx.get 取；
  // 把它们放进 declared 就会掩盖"可选服务被当硬依赖读"这一类缺陷。
  const declared = new Set(['tools', 'subprocess', 'sandboxPolicy', 'sessionProjections', 'jobs'])
  const optional = {}
  if (opts.confinement !== false) {
    optional.sandbox = { confine: async (argv) => ({ argv: ['runner', '--', ...argv] }) }
  }
  if (opts.dropLogger !== true) {
    optional.logger = { info() {}, warn() {}, error() {} }
  }
  ctx.get = (name) => optional[name]
  ctx.injectDeclared = declared

  // 模拟 Cordis 的 ctx 代理：读取**未在 inject 里声明**的服务属性会抛错，
  // 而 `?.` 与 `=== undefined` 都挡不住——`ctx.admission` / `ctx.logger` 就是这样
  // 让插件整条 entry 无法激活的。
  //
  // 注意：`on` / `off` / `effect` 是 ctx 自身的框架方法，不是服务，不需要 inject，
  // 所以放行；真正要拦的是"把服务当普通属性读"。
  let effectiveCtx = ctx
  if (opts.strictCtx === true) {
    const reads = []
    ctx.__reads = reads
    effectiveCtx = new Proxy(ctx, {
      get(target, property, receiver) {
        if (typeof property === 'string') {
          reads.push(property)
          const known = Object.prototype.hasOwnProperty.call(target, property)
          if (!known && !declared.has(property) && !FRAMEWORK_KEYS.has(property)) {
            throw new Error(`cannot get property "${property}" without inject`)
          }
        }
        return Reflect.get(target, property, receiver)
      },
    })
  }

  const runtime = apply(effectiveCtx, rawConfig)

  /**
   * owner 对象：带 `.ctx.on()`，与真实 Cordis agent 形状一致。
   * 同一个 id 复用同一个 ownerCtx，便于断言监听器。
   */
  function agentFor(id = 'sess-1') {
    const session = { header: { cwd: 'F:/ws' } }
    let ownerCtx = ownerCtxs.get(id)
    if (ownerCtx === undefined) {
      ownerCtx = makeOwnerCtx({ id, session })
      ownerCtxs.set(id, ownerCtx)
    }
    return { id, session, ctx: ownerCtx, ownerCtx }
  }

  return { tools, runtime, spawn, jobs, jobCancels, ctx: effectiveCtx, rawCtx: ctx, agentFor, ownerCtxs, jobId: () => `terminal-${jobSeq}` }
}

function callTool(tools, name, args, owner) {
  const definition = tools.get(name)
  assert.ok(definition, `工具 ${name} 未注册`)
  // 测试统一注入极短的 `waitMs`：`terminal_exec` 的**产品默认**是有界等待 10s，
  // 而这些用例走的是假 PTY（不会真的执行命令，帧永不闭合），不注入就得每条等满 10s。
  // 有界等待本身由 T2c/T2d 专门验证；这里只需要"立刻把控制权还回来"。
  const effective = name === 'terminal_exec' ? { waitMs: 1, ...args } : args
  return definition.execute(effective, { agent: owner, signal: undefined })
}

// ─────────────────────────────────────────────────────────────────────────────
// 注册与配置闸门
// ─────────────────────────────────────────────────────────────────────────────

test('S1 四个工具全部注册，且 schema 里没有提权字段（E1）', () => {
  const { tools } = mountPlugin()
  for (const name of ['terminal_exec', 'terminal_read', 'terminal_write', 'terminal_signal']) {
    assert.ok(tools.has(name), `缺少工具 ${name}`)
  }
  for (const [name, definition] of tools) {
    const properties = definition.parameters?.properties ?? {}
    assert.equal(properties.sandbox_permissions, undefined, `${name} 不得暴露 sandbox_permissions`)
    assert.equal(properties.justification, undefined, `${name} 不得暴露 justification`)
  }
})

test('S2 pwsh 方言现在能挂载，但未知方言仍被拒绝', () => {
  const { ctx } = mountPlugin()
  const pwsh = apply(ctx, { shellPath: 'C:\\pwsh.exe', shellDialect: 'pwsh' })
  assert.equal(pwsh.config.shellDialect, 'pwsh')
  assert.deepEqual(pwsh.config.shellArgs, ['-NoLogo', '-NoProfile'])
  assert.throws(() => apply(ctx, { shellPath: SHELL, shellDialect: 'zsh' }), /is not supported/)
})

test('S2f 能力矩阵在**启动前**拒绝不支持的方言（接线必须真的生效）', async () => {
  // 这条锁住 `assertShellSupported` 的生产接线。
  //
  // 背景：能力矩阵写好后**只有测试在调它**（零生产调用点），等于白写——
  // 受限 Windows 下配 bash 仍会走到 "exit code 127 + 零输出"，
  // 调用方只能对着 127 猜。接线后应当在 spawn 之前就给出可操作原因。
  if (process.platform !== 'win32') return // 该组合只在 win32 受限模式下被拒

  const { tools, spawn, agentFor } = mountPlugin(
    {},
    { shellPath: 'F:\\Program Files\\Git\\bin\\bash.exe', shellDialect: 'bash', ptyBackend: 'host' },
  )
  const owner = agentFor()
  await assert.rejects(
    () => callTool(tools, 'terminal_exec', { command: 'echo hi' }, owner),
    (error) => {
      assert.match(error.message, /SHELL_UNSUPPORTED_IN_CONFINED_WINDOWS/, '必须报明确的能力错误码')
      assert.match(error.message, /pwsh/, '错误里必须给可操作替代方案')
      return true
    },
  )
  assert.equal(spawn.spawnCalls.length, 0, '被能力矩阵拒绝时**不得**尝试 spawn（拒绝必须发生在启动前）')
})

test('S3 缺 sessionProjections 时挂载失败', () => {
  const { ctx } = mountPlugin()
  delete ctx.sessionProjections
  assert.throws(() => apply(ctx, { shellPath: SHELL }), /sessionProjections/)
})

test('S2b shellPath 缺失时按方言发现，不再 fail 在 "shellPath is required" 上', () => {
  // 契约变更：shellPath 从「必填」变成「可省略——省略则按方言与平台发现」。
  // 判据因此从「必须抛错」变成「要么挂载成功，要么报 SHELL_NOT_FOUND」，
  // 而不能是裸的 shellPath is required。发现失败的确定性覆盖在
  // test/shell-resolve.test.js（注入假文件系统）。
  const { ctx } = mountPlugin()
  try {
    const runtime = apply(ctx, { shellDialect: 'pwsh' })
    assert.ok(runtime, '发现到 shell 时应挂载成功')
  } catch (error) {
    assert.match(String(error?.message), /SHELL_NOT_FOUND/)
  }
})

test('S2c host 行与 agent 行用同一份 config 都能挂载', () => {
  const config = { shellPath: SHELL, shellDialect: 'pwsh' }
  const first = mountPlugin({}, config)
  assert.ok(first.runtime, 'host 平面挂载应成功')
  const second = mountPlugin({}, config)
  assert.ok(second.runtime, 'agent 平面挂载应成功（同一份 config，不同 ctx）')
  assert.equal(second.runtime.config.shellPath, config.shellPath)
  // 断言"配置被原样采纳"，而不是硬编码某个方言——夹具用的方言必须与平台能力一致
  // （Windows 受限模式下 bash 会被 `assertShellSupported` 在启动前拒绝）。
  assert.equal(second.runtime.config.shellDialect, config.shellDialect)
})

test('S2d 在会抛的 ctx 代理下也能挂载：不读任何未 inject 的服务', () => {
  // 回归：真机上一度因为 `ctx.admission`（fence）与 `ctx.logger`（warn）
  // 抛 `cannot get property "…" without inject` 而整条 entry 无法激活。
  // strictCtx 用 Proxy 复现 Cordis 的这条语义。
  const { runtime, ctx } = mountPlugin({ strictCtx: true })
  assert.ok(runtime, '未声明服务的读取必须已经消除，挂载应成功')
  const reads = new Set(ctx.__reads)
  const declared = ctx.injectDeclared
  const illegal = [...reads].filter(
    (name) => !declared.has(name) && !FRAMEWORK_KEYS.has(name) && name !== '__reads' && name !== 'injectDeclared',
  )
  assert.deepEqual(illegal, [], `挂载期读了未声明的服务：${illegal.join(', ')}`)
})

test('S2e 缺 logger 的 ctx 也能挂载（logger 是可选服务）', () => {
  const { runtime } = mountPlugin({ strictCtx: true, dropLogger: true })
  assert.ok(runtime, 'logger 缺失不得阻止挂载')
})

// ─────────────────────────────────────────────────────────────────────────────
// admission-first 时序：I1 / I2 / I3 —— 任何拒绝都不得创建 PTY
// ─────────────────────────────────────────────────────────────────────────────

test('I1 容量超限：spawnTerminal 调用次数为 0，且不注册 job', async () => {
  const { tools, spawn, jobs, runtime, agentFor } = mountPlugin()
  const owner = agentFor()
  const before = jobs.size

  for (let i = 0; i < runtime.config.maxSessionsPerAgent; i += 1) {
    // 预留后不发布，占住容量
    runtime.admission.reserve(owner, { command: 'x' })
  }

  await assert.rejects(() => callTool(tools, 'terminal_exec', { command: 'ls' }, owner), /maxSessionsPerAgent=4/)
  assert.equal(spawn.spawnCalls.length, 0, '容量拒绝必须发生在 spawn 之前')
  assert.equal(jobs.size, before, '容量拒绝不得注册 job')
})

test('I2 confine 失败：spawnTerminal 为 0，预留已释放', async () => {
  const { tools: tools2, spawn: spawn2, runtime: runtime2, agentFor: agentFor2 } = mountPlugin({ confinement: false })
  const owner2 = agentFor2()
  await assert.rejects(() => callTool(tools2, 'terminal_exec', { command: 'ls' }, owner2), /requires a ctx\.sandbox provider/)
  assert.equal(spawn2.spawnCalls.length, 0, 'confine 失败必须发生在 spawn 之前')
  assert.equal(runtime2.admission.activeCount(owner2), 0, 'confine 失败必须释放预留')
})

test('I3 spawn 拒绝：返回 startup-failed（不再裸抛），无 PTY 收口、Job 结算为 failed', async () => {
  // 契约变更（审阅 R001-02）：宿主明确拒绝创建 PTY 时，terminal_exec 返回
  // `startup-failed` + 诊断证据，而不是抛一个裸错误让调用方去猜。
  const { tools, spawn, jobs, runtime, agentFor } = mountPlugin({ spawnRejects: new Error('pty exploded') })
  const owner = agentFor()
  const result = await callTool(tools, 'terminal_exec', { command: 'ls' }, owner)
  assert.equal(result.status, 'startup-failed', '宿主拒绝创建 PTY 必须报 startup-failed，不是 starting，也不是裸抛')
  assert.equal(result.code, 'SANDBOX_PTY_START_FAILED')
  assert.match(String(result.diagnostics ?? ''), /pty exploded/, '诊断里必须能看到宿主侧的失败原因')
  assert.match(String(result.diagnostics ?? ''), /argv:/, '诊断里必须带 confine 后的 argv')

  assert.equal(spawn.spawnCalls.length, 1, 'spawn 应恰好尝试一次')
  const record = runtime.admission.listForOwner(owner)[0]
  assert.ok(record, '失败的会话应仍可查到（供读取失败原因）')
  assert.equal(record.phase, 'failed', 'spawn 失败必须走 failed，而不是 cleanup-failed')
  const job = [...jobs.values()][0]
  assert.ok(job, 'job 应已注册')
  assert.equal(job.status, 'failed', 'job 必须以合法终态结算')
})

// ─────────────────────────────────────────────────────────────────────────────
// confine 接线：I5
// ─────────────────────────────────────────────────────────────────────────────

test('I5 受限模式下 spawn 收到的是 confine 返回的 argv（前缀包装形态）', async () => {
  const { tools, spawn, agentFor, runtime } = mountPlugin()
  const owner = agentFor()
  await callTool(tools, 'terminal_exec', { command: 'echo hi' }, owner).catch(() => {})
  assert.equal(spawn.spawnCalls.length, 1, '应恰好触发一次 spawn')
  const spec = spawn.spawnCalls[0]
  assert.equal(spec.argv[0], 'runner', 'argv 必须是 confine 的包装结果')
  // 尾部应是**实际配置的**交互 shell argv（从 runtime 取，不硬编码方言：
  // Windows 受限模式下 bash 会被能力矩阵在启动前拒绝）
  assert.deepEqual(
    spec.argv.slice(2),
    [runtime.config.shellPath, ...runtime.config.shellArgs],
    '包装后尾部应是交互 shell argv',
  )
  assert.ok(!spec.argv.includes('echo hi'), '命令不得进入 argv——它必须经 stdin 写入')
  assert.equal(spec.cwd, 'F:/ws', 'cwd 应来自策略 workspaceRoot')
  assert.ok(runtime.config.cols > 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// 成功路径：发布、队列 flush、终态读
// ─────────────────────────────────────────────────────────────────────────────

test('I4 成功路径：spawnTerminal 恰好 1 次，首条命令经 stdin 写入', async () => {
  const { tools, spawn, runtime, agentFor } = mountPlugin()
  const owner = agentFor()
  const pty = makeFakePty()
  spawn.spawnTerminal = async (spec) => {
    spawn.spawnCalls.push(spec)
    return pty.handle
  }

  await callTool(tools, 'terminal_exec', { command: 'echo hi' }, owner)
  assert.equal(spawn.spawnCalls.length, 1, '成功路径 spawn 必须恰好一次')

  // 启动序列在发布时就写了（第 1 次）；信标到达后队列 flush（第 2 次）
  pty.emit(READY_BEACON + CRLF)
  const flushed = await until(() => pty.writeCalls().length >= 2)
  assert.ok(flushed, '首条命令必须被写入 shell 的 stdin')
  const writes = pty.writeCalls()
  assert.equal(writes.length, 2, '启动序列 1 次 + 首条命令 1 次')
  assert.match(writes[0], /__DSH_BGTERM_READY__/, '第 1 次写入必须是启动序列（含就绪信标）')
  assert.match(writes[1], /__DSH_BGTERM_/, '第 2 次写入必须带 framing marker')
  assert.match(writes[1], /echo hi/)
  assert.equal(runtime.admission.activeCount(owner), 1)
})

test('T2b 命令级 framing：从 PTY 输出闭合帧 → 拿到命令退出码（接线 extractFrame）', async () => {
  // ## 这条锁的是一根曾经缺失的线
  //
  // `wrapCommand` 一直在写帧标记、`extractFrame` 也一直能解析，但两者之间**没有人连**
  // （`extractFrame` 零生产调用点）。后果：插件只知道**会话**何时结束、不知道**命令**
  // 何时结束——而持久 shell 的会话永远不结束，所以既没有命令级退出码，
  // 也没有"命令跑完了"这个事件（前端按钮据此唤醒 agent 的尝试因此不可能成功）。
  const { tools, spawn, runtime, agentFor } = mountPlugin()
  const owner = agentFor()
  const pty = makeFakePty()
  spawn.spawnTerminal = async (spec) => {
    spawn.spawnCalls.push(spec)
    return pty.handle
  }

  const exec = await callTool(tools, 'terminal_exec', { command: 'npm run build' }, owner)
  const ready = await makeReady(pty, runtime, owner)
  assert.ok(ready, '会话必须就绪')

  const flushed = await until(() => pty.writeCalls().length >= 2)
  assert.ok(flushed, '首条命令必须写入 stdin')

  // 从**实际写入的 stdin** 里取帧标记：这是唯一可靠的真值来源
  const written = pty.writeCalls()[1]
  const startMarker = /__DSH_BGTERM_[0-9a-f-]+_S__/.exec(written)?.[0]
  const endMarker = /__DSH_BGTERM_[0-9a-f-]+_E__/.exec(written)?.[0]
  assert.ok(startMarker && endMarker, `写入的命令必须带帧标记：${written.slice(0, 120)}`)
  assert.equal(
    startMarker.replace('_S__', ''),
    endMarker.replace('_E__', ''),
    'start 与 end 必须来自**同一次** wrapCommand（调两次会得到不匹配的 nonce，帧永远闭不上）',
  )

  const record = runtime.admission.listForOwner(owner)[0]
  assert.equal(
    snapshotSession(record).commandRunning,
    true,
    '命令已发出、帧未闭合 → 必须报 commandRunning=true',
  )
  assert.equal(snapshotSession(record).lastCommandExitCode, null, '还没跑完 → 不得报退出码')

  // 模拟 shell 执行完：**回显包装命令行**（含 start 标记）+ 打印 end 标记与退出码。
  // 回显是真实行为——PTY 会把写入的命令行原样吐回来；`extractFrame` 取 start/end 的
  // **最后一次**出现，正是为了让命令输出里伪造的 end 不可能提前闭合帧（SH4）。
  pty.emit(`${written}`)
  pty.emit(`\r\noutput line\r\n${endMarker}0\r\n`)
  const closed = await until(() => snapshotSession(record).commandRunning === false)
  assert.ok(closed, '帧闭合后必须判定命令已结束')
  assert.equal(snapshotSession(record).lastCommandExitCode, 0, '必须取到真实的命令级退出码')

  // 非零退出码同样要如实反映（不能只认成功）
  const pty2 = makeFakePty()
  spawn.spawnTerminal = async (spec) => {
    spawn.spawnCalls.push(spec)
    return pty2.handle
  }
  const exec2 = await callTool(tools, 'terminal_exec', { command: 'exit 3' }, owner)
  await makeReady(pty2, runtime, owner)
  await until(() => pty2.writeCalls().length >= 2)
  const end2 = /__DSH_BGTERM_[0-9a-f-]+_E__/.exec(pty2.writeCalls()[1])[0]
  pty2.emit(`${pty2.writeCalls()[1]}`)
  pty2.emit(`\r\n${end2}3\r\n`)
  const rec2 = runtime.admission.listForOwner(owner).find((r) => r.id === exec2.sessionId)
  const closed2 = await until(() => snapshotSession(rec2).commandRunning === false)
  assert.ok(closed2, '第二条会话的帧也必须闭合')
  assert.equal(snapshotSession(rec2).lastCommandExitCode, 3, '非零退出码必须原样上报，不得归零')

  assert.ok(exec.sessionId !== exec2.sessionId, '两次 exec 必须是两个会话')
})

/** 从写入 shell 的那行里取出帧标记（真值来源：实际写进 stdin 的内容）。 */
function markersOfWritten(written) {
  const start = /__DSH_BGTERM_[0-9a-f-]+_S__/.exec(written)?.[0]
  const end = /__DSH_BGTERM_[0-9a-f-]+_E__/.exec(written)?.[0]
  return { start, end }
}

test('T2c 有界等待：窗口内结束 → 直接返回 completed/failed + 退出码 + 输出', async () => {
  // 这是"有界等待"的核心契约：在 waitMs 内跑完就把结果直接交回来，
  // 调用方一次调用就能拿到成功/失败并作出调整，不必再发一次 terminal_read。
  const { tools, spawn, runtime, agentFor } = mountPlugin()
  const owner = agentFor()
  const pty = makeFakePty()
  spawn.spawnTerminal = async (spec) => {
    spawn.spawnCalls.push(spec)
    return pty.handle
  }

  const pending = callTool(tools, 'terminal_exec', { command: 'npm run build', waitMs: 5000 }, owner)
  await makeReady(pty, runtime, owner)
  const flushed = await until(() => pty.writeCalls().length >= 2)
  assert.ok(flushed, '首条命令必须写入 stdin')

  const written = pty.writeCalls()[1]
  const { start, end } = markersOfWritten(written)
  assert.ok(start && end, '必须能取到帧标记')
  // shell 回显命令行 + 打印结束标记与退出码
  pty.emit(`${written}`)
  pty.emit(`${CRLF}built ok${CRLF}${end}0${CRLF}`)

  const result = await pending
  assert.equal(result.status, 'completed', '窗口内结束应返回 completed')
  assert.equal(result.commandExitCode, 0, '必须带上命令级退出码')
  assert.match(String(result.output), /built ok/, '必须顺带把输出交回来')
  assert.equal(result.outputReads, 1, '默认只读 1 次')
})

test('T2d 有界等待：超时 → 返回 running 且**会话仍活着**（不是失败）', async () => {
  // 超时的语义是"把控制权还给调用方"，不是"命令失败"。
  // 会话必须仍然活着——这正是持久终端独有的能力：稍后可以自己 terminal_read /
  // terminal_state 看到底发生了什么，或者换策略。
  const { tools, spawn, runtime, agentFor } = mountPlugin()
  const owner = agentFor()
  const pty = makeFakePty()
  spawn.spawnTerminal = async (spec) => {
    spawn.spawnCalls.push(spec)
    return pty.handle
  }

  const pending = callTool(tools, 'terminal_exec', { command: 'npm install', waitMs: 60 }, owner)
  await makeReady(pty, runtime, owner)
  await until(() => pty.writeCalls().length >= 2)
  // 刻意不闭合帧（命令"还在跑"）→ 等到窗口超时
  const result = await pending

  assert.equal(result.status, 'running', '超时必须返回 running，而不是 failed/completed')
  assert.equal(result.commandRunning, true, '必须显式说明命令仍在跑')
  assert.equal(result.commandExitCode, undefined, '没跑完就不该有退出码')
  assert.match(String(result.note), /did not finish within waitMs=60/, '必须说明超时窗口')
  assert.match(String(result.note), /terminal_state/, '必须告诉调用方怎么继续查')

  // 关键：会话本身仍然活着，且状态如实反映"命令在跑"
  const record = runtime.admission.listForOwner(owner)[0]
  assert.equal(record.phase, 'running', '超时后会话必须仍然 running（不是 failed）')
  assert.ok(record.pendingFrame !== undefined, '帧仍未闭合 = 命令确实还在跑')

  const state = await callTool(tools, 'terminal_state', { sessionId: result.sessionId }, owner)
  assert.equal(state.phase, 'running', '会话层面也是 running')
  assert.equal(state.commandRunning, true, 'terminal_state 必须如实报告命令仍在跑')
  assert.equal(state.lastCommandExitCode, null, '还没跑完 → 不得报退出码')
})

test('S4 close 的 reason 不得被重复前缀（用户取消是完整句子）', async () => {
  // 真机症状：用户点取消 → 通知文案成了
  //   "closed by request: cancelled by the user; cancelled by the user"
  // 原因是宿主把**完整句子**当 reason 传进来，而实现无条件拼了前缀。
  // 旧修法用"完整句子黑名单"（只排除 closed by request / unload）——句子是无穷的，
  // 下一个 `cancelled by the user` 立刻漏网。现在改为**短令牌白名单**。
  const cases = [
    ['SIGKILL', 'closed by request: SIGKILL'], // 短令牌：需要前缀才读得懂
    ['cancelled by the user', 'cancelled by the user'], // 宿主传入的完整句子：原样
    ['closed by request', 'closed by request'], // 本插件默认值：原样
    ['plugin unloaded', 'plugin unloaded'], // teardown：原样
  ]

  for (const [reason, expected] of cases) {
    const { tools, spawn, runtime, agentFor } = mountPlugin()
    const owner = agentFor()
    const pty = makeFakePty()
    spawn.spawnTerminal = async (spec) => {
      spawn.spawnCalls.push(spec)
      return pty.handle
    }
    const exec = await callTool(tools, 'terminal_exec', { command: 'echo hi', waitMs: 1 }, owner)
    await makeReady(pty, runtime, owner)

    await callTool(tools, 'terminal_signal', { sessionId: exec.sessionId, close: true, reason }, owner)
    const record = runtime.admission.listForOwner(owner).find((r) => r.id === exec.sessionId)
    const settled = await until(() => record.terminal?.detail !== undefined)
    assert.ok(settled, `reason=${reason} 时必须结算出 terminal.detail`)
    assert.equal(record.terminal.detail, expected, `reason=${JSON.stringify(reason)} 的 detail 形态错误`)
    // 兜底：任何一种 reason 都不得出现"句子被拼了两遍"
    assert.ok(
      !record.terminal.detail.includes(`${reason}; ${reason}`),
      `detail 不得重复：${record.terminal.detail}`,
    )
  }
})

test('DG6 危险命令在**预留之前**被拒：不 spawn、不占容量、不留记录', async () => {
  // 被拒绝的命令不该起 shell、不该占容量、也不该留下任何痕迹。
  // 这正是"放在 admission.reserve 之前"的意义——放到后面就会占一个名额再释放。
  const { tools, spawn, runtime, agentFor } = mountPlugin()
  const owner = agentFor()

  await assert.rejects(
    () => callTool(tools, 'terminal_exec', { command: 'rm -rf /', waitMs: 1 }, owner),
    (error) => {
      assert.equal(error.code, 'DANGEROUS_COMMAND_REFUSED', '必须有稳定错误码')
      assert.match(error.message, /NOT a security boundary/, '措辞不得声称这是安全边界')
      assert.match(error.message, /allowDangerous: true/, '必须给出覆盖方式')
      return true
    },
  )

  assert.equal(spawn.spawnCalls.length, 0, '被拒绝时不得尝试 spawn')
  assert.equal(runtime.admission.activeCount(owner), 0, '被拒绝时不得占用容量')
  assert.equal(runtime.admission.listForOwner(owner).length, 0, '被拒绝时不得留下会话记录')
})

test('DG7 allowDangerous: true 可覆盖（其余流程照常）', async () => {
  const { tools, spawn, agentFor } = mountPlugin()
  const owner = agentFor()
  const pty = makeFakePty()
  spawn.spawnTerminal = async (spec) => {
    spawn.spawnCalls.push(spec)
    return pty.handle
  }

  const exec = await callTool(
    tools,
    'terminal_exec',
    { command: 'rm -rf /', allowDangerous: true, waitMs: 1 },
    owner,
  )
  assert.equal(typeof exec.sessionId, 'string', '显式覆盖后必须正常启动会话')
  assert.equal(spawn.spawnCalls.length, 1, '覆盖后应当真的去 spawn')
})

test('T3 终态读取：退出码落到 terminal 视图，Jobs 以合法状态结算', async () => {
  const { tools, spawn, jobs, runtime, agentFor } = mountPlugin()
  const owner = agentFor()
  const pty = makeFakePty()
  spawn.spawnTerminal = async (spec) => {
    spawn.spawnCalls.push(spec)
    return pty.handle
  }

  const exec = await callTool(tools, 'terminal_exec', { command: 'false' }, owner)
  const ready = await makeReady(pty, runtime, owner)
  assert.ok(ready, 'shell 必须先就绪，否则下面的"自然退出"会被正确判成启动期失败')

  pty.exit(3, null)
  const settled = await until(() => runtime.admission.listForOwner(owner)[0]?.phase === 'exited')
  assert.ok(settled, '自然退出必须走完 finish')

  const record = runtime.admission.listForOwner(owner)[0]
  assert.equal(record.terminal.exitCode, 3, '退出码必须被收下（不能被吞成未知）')
  const job = jobs.get(exec.jobId)
  assert.equal(job.status, 'failed', '非 0 退出码映射为 failed')
  assert.match(String(job.detail ?? ''), /exit code 3/)

  // 终态读取仍能拿到尾巴与退出码
  const read = await callTool(tools, 'terminal_read', { sessionId: exec.sessionId }, owner)
  assert.equal(read.status, 'exited')
  assert.equal(read.exitCode, 3)
})

// ─────────────────────────────────────────────────────────────────────────────
// 输入限流与信号语义
// ─────────────────────────────────────────────────────────────────────────────

test('IO2 单次输入超限：整笔拒绝且带稳定错误码', async () => {
  const { tools, spawn, runtime, agentFor } = mountPlugin()
  const owner = agentFor()
  const pty = makeFakePty()
  spawn.spawnTerminal = async (spec) => {
    spawn.spawnCalls.push(spec)
    return pty.handle
  }
  const exec = await callTool(tools, 'terminal_exec', { command: 'cat' }, owner)
  pty.emit(READY_BEACON + CRLF)
  await until(() => runtime.admission.listForOwner(owner)[0]?.ready === true)

  const tooBig = 'a'.repeat(runtime.config.maxInputBytes + 1)
  await assert.rejects(
    () => callTool(tools, 'terminal_write', { sessionId: exec.sessionId, data: tooBig }, owner),
    (error) => error.code === 'INPUT_TOO_LARGE',
  )
  assert.equal(pty.writeCalls().length, 2, '被拒绝的输入不得落到 PTY（只有启动序列与首条命令两次写入）')
})

test('S1a SIGINT 不关会话：shell 保持 running，且信号打到前台进程组', async () => {
  const { tools, spawn, runtime, agentFor } = mountPlugin()
  const owner = agentFor()
  const pty = makeFakePty()
  spawn.spawnTerminal = async (spec) => {
    spawn.spawnCalls.push(spec)
    return pty.handle
  }
  const exec = await callTool(tools, 'terminal_exec', { command: 'sleep 100' }, owner)
  pty.emit(READY_BEACON + CRLF)
  await until(() => runtime.admission.listForOwner(owner)[0]?.ready === true)

  const result = await callTool(tools, 'terminal_signal', { sessionId: exec.sessionId }, owner)
  assert.equal(result.delivered, 'SIGINT')
  assert.equal(result.target, 'foreground-process-group')
  assert.equal(result.status, 'running', 'SIGINT 之后会话必须仍然 running')
  assert.deepEqual(pty.state.signalCalls, ['SIGINT'])
  assert.equal(pty.state.terminated, 0, 'SIGINT 绝不能终止会话')
  assert.equal(runtime.admission.activeCount(owner), 1, '容量在 SIGINT 后仍被占用')
})

test('S3 close: true 关闭整个会话并释放容量', async () => {
  const { tools, spawn, runtime, agentFor } = mountPlugin()
  const owner = agentFor()
  const pty = makeFakePty()
  spawn.spawnTerminal = async (spec) => {
    spawn.spawnCalls.push(spec)
    return pty.handle
  }
  const exec = await callTool(tools, 'terminal_exec', { command: 'sleep 100' }, owner)
  pty.emit(READY_BEACON + CRLF)
  await until(() => runtime.admission.listForOwner(owner)[0]?.ready === true)

  const result = await callTool(tools, 'terminal_signal', { sessionId: exec.sessionId, close: true }, owner)
  assert.equal(result.target, 'session')
  assert.equal(result.status, 'killed')
  assert.equal(pty.state.terminated, 1, '关闭必须终止底层 PTY，且恰好一次')
  assert.equal(runtime.admission.activeCount(owner), 0, '关闭后容量必须释放')
})

test('C6 cleanup 失败：容量与围栏保留，重试成功后才释放，Jobs 不二次结算', async () => {
  const { tools, spawn, jobs, runtime, agentFor } = mountPlugin()
  const owner = agentFor()
  const pty = makeFakePty()
  spawn.spawnTerminal = async (spec) => {
    spawn.spawnCalls.push(spec)
    return pty.handle
  }
  const exec = await callTool(tools, 'terminal_exec', { command: 'sleep 100' }, owner)
  pty.emit(READY_BEACON + CRLF)
  await until(() => runtime.admission.listForOwner(owner)[0]?.ready === true)

  pty.failNextTerminate('terminal cleanup failed; surviving pid: 4242')
  const first = await callTool(tools, 'terminal_signal', { sessionId: exec.sessionId, close: true }, owner)
  assert.equal(first.status, 'cleanup-failed', '终止失败必须如实报 cleanup-failed')
  assert.equal(runtime.admission.activeCount(owner), 1, '清理失败时容量必须保留')

  const job = jobs.get(exec.jobId)
  const settledStatus = job.status
  assert.ok(['failed', 'killed'].includes(settledStatus), `job 必须已以合法状态结算，实得 ${settledStatus}`)

  const second = await callTool(tools, 'terminal_signal', { sessionId: exec.sessionId, close: true }, owner)
  assert.equal(second.status, 'killed', '第二次清理应成功')
  assert.equal(runtime.admission.activeCount(owner), 0, '重试成功后必须释放容量')
  assert.equal(pty.state.terminated, 1, '两次尝试只应产生一次成功终止')
  assert.equal(jobs.get(exec.jobId).status, settledStatus, 'Jobs 不得二次结算')
})

// ─────────────────────────────────────────────────────────────────────────────
// 未知会话与信号枚举
// ─────────────────────────────────────────────────────────────────────────────

test('S3b 启动期崩溃：失败详情必须带上已捕获输出（真机排查的唯一线索）', async () => {
  // 真机回归：shell 起来就 exit 127 且零输出时，沙箱 runner 的报错就写在 PTY 输出里。
  // 若 detail 只有 "exit code 127"，故障根本无法定位。
  const { tools, spawn, runtime, agentFor } = mountPlugin()
  const owner = agentFor()
  const pty = makeFakePty()
  spawn.spawnTerminal = async (spec) => {
    spawn.spawnCalls.push(spec)
    return pty.handle
  }

  const exec = await callTool(tools, 'terminal_exec', { command: 'echo hi' }, owner)
  // shell 就绪（开始服役）之后、命令执行期间崩溃：
  // 先发信标（真实顺序：就绪 → 收命令 → 崩溃），再吐错误并退出。
  pty.emit(READY_BEACON + CRLF)
  await until(() => runtime.admission.listForOwner(owner)[0]?.ready === true)
  pty.emit('windows-acl-run: terminal spawn unsupported\r\n')
  pty.exit(127, null)

  const settled = await until(() => {
    const record = runtime.admission.listForOwner(owner)[0]
    return record !== undefined && record.phase !== 'starting' && record.phase !== 'running'
  })
  assert.ok(settled, 'shell 崩溃必须被收口')

  const read = await callTool(tools, 'terminal_read', { sessionId: exec.sessionId }, owner)
  assert.equal(read.exitCode, 127)
  assert.match(String(read.detail ?? ''), /captured output/)
  assert.match(String(read.detail ?? ''), /windows-acl-run/)
  // D7（task-6）：detail 还必须带 confine 之后的完整 argv——起不来时它是唯一坐标
  assert.match(String(read.detail ?? ''), /argv: "runner" "--"/)
})

test('未知 sessionId 报错，不静默成功', async () => {
  const { tools, agentFor } = mountPlugin()
  const owner = agentFor()
  await assert.rejects(() => callTool(tools, 'terminal_read', { sessionId: 'term-nope' }, owner), /unknown terminal session/)
  await assert.rejects(() => callTool(tools, 'terminal_write', { sessionId: 'term-nope', data: 'x' }, owner), /unknown terminal session/)
  await assert.rejects(() => callTool(tools, 'terminal_signal', { sessionId: 'term-nope' }, owner), /unknown terminal session/)
})

test('S4 任意 OS signal 字符串被拒绝（只允许固定枚举）', async () => {
  const { tools, spawn, runtime, agentFor } = mountPlugin()
  const owner = agentFor()
  const pty = makeFakePty()
  spawn.spawnTerminal = async (spec) => {
    spawn.spawnCalls.push(spec)
    return pty.handle
  }
  const exec = await callTool(tools, 'terminal_exec', { command: 'cat' }, owner)
  pty.emit(READY_BEACON + CRLF)
  await until(() => runtime.admission.listForOwner(owner)[0]?.ready === true)

  await assert.rejects(
    () => callTool(tools, 'terminal_signal', { sessionId: exec.sessionId, signal: 'SIGUSR1' }, owner),
    /unknown signal/,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// A 类缺陷的验收用例（docs/bug-reports/AUDIT-A-class.md）
//
// 这些用例补的是"报告声称已覆盖、实际锁不住"的缺口：每条都能在对应实现被
// 改坏时变红（变异矩阵见审计报告 §3），既有用例则不会。
// ─────────────────────────────────────────────────────────────────────────────

/** 终态 phase：用于等待收口完成。 */
const TERMINAL_PHASES = new Set(['exited', 'killed', 'failed', 'cleanup-failed'])

test('A2 cleanup-failed 期间容量与围栏都必须保留，重试成功后才一起放行', async () => {
  // 原 C6 只断言了容量；A-2 声称的"围栏保留"没有任何断言（围栏判据与容量同源，
  // 但"同源推断"不是证据）。这里直接问围栏：它必须拒绝切到别的 sandbox mode。
  const { tools, spawn, runtime, agentFor } = mountPlugin()
  const owner = agentFor()
  const pty = makeFakePty()
  spawn.spawnTerminal = async (spec) => {
    spawn.spawnCalls.push(spec)
    return pty.handle
  }

  const exec = await callTool(tools, 'terminal_exec', { command: 'sleep 100' }, owner)
  pty.emit(READY_BEACON + CRLF)
  await until(() => runtime.admission.listForOwner(owner)[0]?.ready === true)

  assert.match(
    String(runtime.fence.shouldBlock(owner, 'danger-full-access')),
    /cannot change sandbox mode/,
    '有活动会话时围栏必须拦截模式切换',
  )

  pty.failNextTerminate('terminal cleanup failed; surviving pid: 4242')
  const first = await callTool(tools, 'terminal_signal', { sessionId: exec.sessionId, close: true }, owner)
  assert.equal(first.status, 'cleanup-failed', '终止失败必须如实报 cleanup-failed')
  assert.equal(runtime.admission.activeCount(owner), 1, '清理失败时容量必须保留')
  assert.match(
    String(runtime.fence.shouldBlock(owner, 'danger-full-access')),
    /cannot change sandbox mode/,
    'cleanup-failed 仍计入活动：围栏不得放行（进程可能还在跑）',
  )

  const second = await callTool(tools, 'terminal_signal', { sessionId: exec.sessionId, close: true }, owner)
  assert.equal(second.status, 'killed', '第二次清理应成功')
  assert.equal(runtime.admission.activeCount(owner), 0, '重试成功后必须释放容量')
  assert.equal(runtime.fence.shouldBlock(owner, 'danger-full-access'), undefined, '清理成功后围栏必须放行')
})

test('A3 工具入口必须返回 Promise：校验失败不得同步 throw', async () => {
  // 原用例靠 `assert.rejects(() => callTool(...))` 间接覆盖：同步 throw 会让该断言
  // 以原始错误失败（实测成立）。这里把性质本身锁住——返回值必须是 Promise，
  // 同步 throw 连 `instanceof` 这一行都过不去。
  const { tools, agentFor } = mountPlugin()
  const owner = agentFor()

  const cases = [
    ['terminal_exec', { command: '   ' }, /non-empty string/],
    ['terminal_read', { sessionId: 'term-nope' }, /unknown terminal session/],
    ['terminal_write', { sessionId: 'term-nope', data: 'x' }, /unknown terminal session/],
    ['terminal_signal', { sessionId: 'term-nope' }, /unknown terminal session/],
  ]
  for (const [name, args, pattern] of cases) {
    const returned = tools.get(name).execute(args, { agent: owner, signal: undefined })
    assert.ok(returned instanceof Promise, `${name} 的校验失败必须是 rejected Promise，不能同步 throw`)
    await assert.rejects(returned, pattern, `${name} 的校验错误必须可被调用方捕获`)
  }
})

test('A4 首条命令队列：就绪前不落 stdin，就绪后恰好写入一次', async () => {
  // 原 I4 只数写入次数，锁不住"走队列"这件事：把首条命令改成发布即写，I4 依然绿。
  const { tools, spawn, runtime, agentFor } = mountPlugin()
  const owner = agentFor()
  const pty = makeFakePty()
  spawn.spawnTerminal = async (spec) => {
    spawn.spawnCalls.push(spec)
    return pty.handle
  }

  const exec = await callTool(tools, 'terminal_exec', { command: 'echo queued-once' }, owner)
  assert.equal(exec.status, 'starting', '已发布但未就绪必须如实返回 starting，不能报 running')

  const beforeReady = pty.writeCalls()
  assert.equal(beforeReady.length, 1, '就绪之前只允许写入启动序列')
  assert.match(beforeReady[0], /__DSH_BGTERM_READY__/, '第 1 次写入必须是启动序列（含就绪信标）')
  assert.ok(!beforeReady.some((text) => /echo queued-once/.test(text)), '首条命令不得在就绪前落 stdin')

  // 未就绪时的输入进队列：不落 PTY，也不丢
  const queued = await callTool(tools, 'terminal_write', { sessionId: exec.sessionId, data: 'later' }, owner)
  assert.deepEqual([queued.written, queued.queued], [false, true], '未就绪时写入必须先排队')
  assert.equal(pty.writeCalls().length, 1, '排队中的写入不得提前落 stdin')

  pty.emit(READY_BEACON + CRLF)
  const flushed = await until(() => pty.writeCalls().length >= 3)
  assert.ok(flushed, '就绪后首条命令与排队写入都必须补写到 stdin')

  const afterReady = pty.writeCalls()
  assert.equal(afterReady.length, 3, '就绪后恰好补写两条（首条命令 + 排队写入）')
  assert.match(afterReady[1], /__DSH_BGTERM_/, '首条命令必须带 framing marker')
  assert.match(afterReady[1], /echo queued-once/)
  assert.match(afterReady[2], /later/, '排队写入必须按 FIFO 补写')
})

test('A5 output end 必须真正 flush pump：等待中的读取在 EOF 立即醒来', async () => {
  // A-5 的修复是"在 output end 里 flush pump"。S3b 锁不住它（captured output 来自
  // ring，与 flush 无关）。这里让 done 永不落定，隔离出唯一一条通知路径：
  // EOF → pump.flush() → sink.end() → 唤醒等待中的 terminal_read。
  const { tools, spawn, runtime, agentFor } = mountPlugin()
  const owner = agentFor()
  const pty = makeFakePty()
  pty.handle.done = new Promise(() => {}) // 没有进程退出通知：会话不会落定
  spawn.spawnTerminal = async (spec) => {
    spawn.spawnCalls.push(spec)
    return pty.handle
  }

  const exec = await callTool(tools, 'terminal_exec', { command: 'echo hi' }, owner)
  pty.emit(READY_BEACON + CRLF)
  await until(() => runtime.admission.listForOwner(owner)[0]?.ready === true)
  await callTool(tools, 'terminal_read', { sessionId: exec.sessionId }, owner) // 清空游标

  pty.emit('tail-after-eof\r\n')
  await new Promise((resolve) => setTimeout(resolve, 20)) // 让尾部输出先落进 ring

  const startedAt = Date.now()
  const pending = callTool(tools, 'terminal_read', { sessionId: exec.sessionId, waitMs: 1500 }, owner)
  pending.then(() => {}, () => {}) // 断言失败时不留未处理的拒绝
  await new Promise((resolve) => setTimeout(resolve, 30)) // 让等待中的 sink 挂上
  pty.endOutput() // EOF

  // 竞速兜底必须用**带引用**的定时器：读取自己的等待定时器是 unref 的，实现被改坏时
  // 事件循环会先被放空，Node 会把这条用例标成 cancelled，并连带取消后续用例。
  const wokeAt = await Promise.race([
    pending.then(() => Date.now() - startedAt),
    new Promise((resolve) => setTimeout(() => resolve(-1), 800)),
  ])
  assert.ok(wokeAt >= 0 && wokeAt < 700, `EOF 必须立刻唤醒等待中的读取（实得 ${wokeAt}ms；等满 waitMs 说明 end 没有 flush）`)

  const result = await pending
  assert.match(result.text, /tail-after-eof/, 'EOF 时的尾部输出必须已经可读')
})

test('A6 已发布、未就绪即崩（真实顺序：先 end 输出流，再落定 done）→ 必须判 shell-exited', async () => {
  // 真机 127 形态是**零输出**，所以静默兜底定时器不会介入。
  // 共享 fake 注明真实 LocalTerminalHandle 就是"先 end 输出流、再落定 done"。
  const { tools, spawn, runtime, agentFor } = mountPlugin()
  const owner = agentFor()
  const pty = makeFakePty()
  spawn.spawnTerminal = async (spec) => {
    spawn.spawnCalls.push(spec)
    return pty.handle
  }

  const exec = await callTool(tools, 'terminal_exec', { command: 'echo hi' }, owner)
  assert.equal(exec.status, 'starting')

  pty.endOutput()
  await new Promise((resolve) => setTimeout(resolve, 30))

  const record = runtime.admission.listForOwner(owner)[0]
  assert.notEqual(record.served, true, 'output EOF 不是就绪证据：不得据此置 served')
  assert.notEqual(record.ready, true, 'output EOF 不得把未就绪的 shell 变成 ready')

  pty.exit(127, null)
  const settled = await until(() => TERMINAL_PHASES.has(runtime.admission.listForOwner(owner)[0]?.phase))
  assert.ok(settled, 'shell 崩溃必须被收口')

  const read = await callTool(tools, 'terminal_read', { sessionId: exec.sessionId }, owner)
  assert.equal(read.status, 'failed', '起来就挂必须报 failed，不能报 exited（"跑完了"）')
  assert.match(String(read.detail ?? ''), /shell exited during startup/, '必须分类为启动期失败')
  assert.match(String(read.detail ?? ''), /exit code 127/)
})

test('A7 完成/就绪判定不得依赖 PTY activity 探测，完成只认结束标记', async () => {
  // 报告 A-7 声称"inspectActivity 仅作兜底且把 unknown 排除在 idle 之外"，
  // 并声称 SH6 覆盖了它。事实：lib/ 实现层没有任何 inspectActivity 调用点，
  // SH6 测的是 detectReadiness。这条守卫锁住真实的设计约束。
  const libUrl = new URL('../lib/', import.meta.url)
  const files = (await readdir(libUrl)).filter((name) => /\.(?:mjs|js)$/.test(name))
  assert.ok(files.length >= 9, `lib/ 下应扫到全部实现文件（实得 ${files.length}）`)
  for (const file of files) {
    if (file === 'contract.mjs') continue // 端口契约保留能力声明，允许出现
    const source = await readFile(new URL(file, libUrl), 'utf8')
    // 注释里提到它是允许的（契约注释就提到过）；实现代码里任何引用都不允许——
    // 包括可选链 `?.inspectActivity?.()` 这种形态，所以先剥注释再看标识符本身。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    assert.ok(
      !/inspectActivity/.test(code),
      `lib/${file} 不得引用 inspectActivity 来决定就绪/完成（unknown 不等于 idle）`,
    )
  }

  // "只认结束标记"这一半：未闭合帧（只见 start / 只见 end）都不算完成
  const frame = wrapCommand('echo hi', 'bash')
  assert.equal(extractFrame(`${frame.start}\r\nout\r\n`, frame), undefined, '只见 start 不算完成')
  assert.equal(extractFrame(`out\r\n${frame.end}0\r\n`, frame), undefined, '只见 end 不算完成')
  assert.deepEqual(extractFrame(`${frame.start}\r\nout\r\n${frame.end}0\r\n`, frame), { text: 'out', exitCode: 0 })
})

// ─────────────────────────────────────────────────────────────────────────────
// 续签（terminal_exec 的 sessionId 形态）
//
// 一个会话只签发一条命令时，换命令就只剩新开 PTY 一条路（丢 cwd、丢环境、多占容量）。
// 续签把"换一条命令"变成帧的第二次签发：退出码仍是硬事实，只是代次变了。
// ─────────────────────────────────────────────────────────────────────────────

test('T2e 续签：sessionId 把新帧签发进既有会话，不重开 PTY', async () => {
  const { tools, spawn, runtime, agentFor } = mountPlugin()
  const owner = agentFor()
  const pty = makeFakePty()
  spawn.spawnTerminal = async (spec) => {
    spawn.spawnCalls.push(spec)
    return pty.handle
  }

  const first = await callTool(tools, 'terminal_exec', { command: 'npm run build', waitMs: 100 }, owner)
  await makeReady(pty, runtime, owner)
  await until(() => pty.writeCalls().length >= 2)
  const firstWrite = pty.writeCalls()[1]
  const firstMarkers = markersOfWritten(firstWrite)
  pty.emit(`${firstWrite}`)
  pty.emit(`\r\nbuild ok\r\n${firstMarkers.end}0\r\n`)

  const record = runtime.admission.listForOwner(owner)[0]
  await until(() => snapshotSession(record).commandRunning === false)
  assert.equal(first.commandGeneration, 1, '首条命令是第 1 代')

  const spawnsBefore = spawn.spawnCalls.length
  const second = await callTool(
    tools,
    'terminal_exec',
    { sessionId: first.sessionId, command: 'npm test', waitMs: 100 },
    owner,
  )
  assert.equal(spawn.spawnCalls.length, spawnsBefore, '续签**不得**再开 PTY（这正是它存在的理由）')
  assert.equal(second.sessionId, first.sessionId, '还是同一个会话')
  assert.equal(second.status, 'running', '窗口内没结束 → 如实返回 running')
  assert.equal(second.commandGeneration, 2, '续签必须产生新代次')

  const secondWrite = pty.writeCalls()[pty.writeCalls().length - 1]
  const secondMarkers = markersOfWritten(secondWrite)
  assert.ok(secondMarkers.start && secondMarkers.end, '新命令必须带自己的帧标记')
  assert.notEqual(secondMarkers.start, firstMarkers.start, '每次签发都是新 nonce（旧帧迟到也匹配不上）')

  pty.emit(`${secondWrite}`)
  pty.emit(`\r\ntests pass\r\n${secondMarkers.end}0\r\n`)
  const closed = await until(() => snapshotSession(record).commandRunning === false)
  assert.ok(closed, '新帧闭合后命令级事实必须跟着更新')
  assert.equal(snapshotSession(record).lastCommandExitCode, 0)
})

test('T2f 续签准入：帧未闭合必须显式 reset，reset 后才签发', async () => {
  const { tools, spawn, runtime, agentFor } = mountPlugin()
  const owner = agentFor()
  const pty = makeFakePty()
  spawn.spawnTerminal = async (spec) => {
    spawn.spawnCalls.push(spec)
    return pty.handle
  }

  const first = await callTool(tools, 'terminal_exec', { command: 'sleep 60', waitMs: 100 }, owner)
  await makeReady(pty, runtime, owner)
  await until(() => pty.writeCalls().length >= 2)

  await assert.rejects(
    () => callTool(tools, 'terminal_exec', { sessionId: first.sessionId, command: 'echo hi', waitMs: 50 }, owner),
    /open command frame/,
    '帧还开着时不得静默续签：那会让上一代的事实凭空消失',
  )

  const afterReset = await callTool(
    tools,
    'terminal_exec',
    { sessionId: first.sessionId, command: 'echo hi', reset: true, waitMs: 100 },
    owner,
  )
  assert.equal(afterReset.commandGeneration, 2, 'reset 后续签出一代新帧')
  assert.equal(afterReset.status, 'running')
})

