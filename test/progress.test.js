/**
 * 长任务可观测性测试（lib/progress.mjs + lib/index.js 的接线）。
 *
 * 全冷：假 PTY、假 jobs handle、假 ctx —— 不创建真实进程、不联网、不碰文件系统。
 * 定时器一律走注入（P6/P7）或很短的间隔 + 引用型等待（P8/P9），不靠 sleep 猜时序。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_PROGRESS_INTERVAL_MS,
  PROGRESS_MAX_CHARS,
  createProgressTracker,
  formatBytes,
  formatDuration,
  renderProgress,
} from '../lib/progress.mjs'
import { apply } from '../lib/index.js'
import { makeFakePty, makeOwnerCtx } from './helpers/fake-ctx.mjs'

const SHELL = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const TERMINAL_PHASES = new Set(['exited', 'killed', 'failed', 'cleanup-failed'])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** 引用型轮询：不会让事件循环提前空掉（unref 定时器的坑）。 */
async function until(predicate, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return true
    await sleep(5)
  }
  return predicate()
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯渲染：形状 / 有界 / 永不抛 / 语义纪律
// ─────────────────────────────────────────────────────────────────────────────

test('P1 renderProgress 单行形状与字段（phase/elapsed/outputBytes/lastOutputAgoMs/exited）', () => {
  assert.equal(
    renderProgress({ phase: 'running', elapsedMs: 12_300, outputBytes: 46_285, lastOutputAgoMs: 400, exited: false }),
    'phase running · elapsed 12.3s · out 45.2KB · last 0.4s ago · alive',
  )
  assert.equal(
    renderProgress({ phase: 'stopping', elapsedMs: 65_000, outputBytes: 2_097_152, lastOutputAgoMs: 3_000, exited: true }),
    'phase stopping · elapsed 1m05s · out 2.0MB · last 3.0s ago · exited',
  )
  // 字段缺失 = 没观测到：写 unknown / no output yet，不补默认值假装知道
  assert.equal(renderProgress({}), 'phase unknown · elapsed unknown · out unknown · no output yet · alive')
  // 0 字节是**有效观测**（确实什么都没产出），不能渲染成 unknown
  assert.equal(renderProgress({ phase: 'running', elapsedMs: 0, outputBytes: 0 }), 'phase running · elapsed 0.0s · out 0B · no output yet · alive')
})

test('P2 进度行必须有界且单行（含超长/多行 phase 字段）', () => {
  const line = renderProgress({
    phase: `${'x'.repeat(5_000)}\n\nsecond line\ttabbed`,
    elapsedMs: 1,
    outputBytes: 1,
    lastOutputAgoMs: 1,
  })
  assert.ok(line.length <= PROGRESS_MAX_CHARS, `长度必须 ≤ ${PROGRESS_MAX_CHARS}，实得 ${line.length}`)
  assert.doesNotMatch(line, /[\r\n]/, '进度行必须单行')
})

test('P3 renderProgress 对任何输入都不抛，且始终返回有界单行', () => {
  const hostile = {
    get phase() {
      throw new Error('hostile getter')
    },
    get elapsedMs() {
      throw new Error('hostile getter')
    },
  }
  const cases = [
    undefined,
    null,
    0,
    'running',
    Symbol('phase'),
    hostile,
    { phase: {}, elapsedMs: NaN, outputBytes: Infinity, lastOutputAgoMs: -5 },
    { phase: 123n, elapsedMs: 10n, outputBytes: 10n, exited: 'yes' },
    { phase: 'running', elapsedMs: Number.MAX_SAFE_INTEGER, outputBytes: 1e15, lastOutputAgoMs: 86_400_000 },
  ]
  for (const state of cases) {
    let line
    assert.doesNotThrow(() => {
      line = renderProgress(state)
    }, `renderProgress 不得抛：${String(state)}`)
    assert.equal(typeof line, 'string')
    assert.ok(line.length > 0 && line.length <= PROGRESS_MAX_CHARS, `有界单行，实得 ${line.length}`)
    assert.doesNotMatch(line, /[\r\n]/)
  }
})

test('P5 语义纪律：进度行只汇报观测值，静默再久也不得判断"卡死"', () => {
  // npm install 可以静默工作数分钟："没有输出"不等于"卡死"。判定留给调用方。
  const quiet = renderProgress({
    phase: 'running',
    elapsedMs: 600_000,
    outputBytes: 0,
    lastOutputAgoMs: 599_000,
    exited: false,
  })
  assert.equal(quiet, 'phase running · elapsed 10m00s · out 0B · last 9m59s ago · alive')
  assert.doesNotMatch(quiet, /stuck|hung|idle|stall|no activity|卡死|停滞|空闲|无响应/i)

  const never = renderProgress({ phase: 'running', elapsedMs: 1_000, outputBytes: 0 })
  assert.match(never, /no output yet/)
  assert.doesNotMatch(never, /stuck|hung|idle|stall|卡死/i)
})

// ─────────────────────────────────────────────────────────────────────────────
// 观察器：注入时钟 / 定时器生命周期 / 终态即停
// ─────────────────────────────────────────────────────────────────────────────

test('P4 lastOutputAgoMs 与 elapsedMs 随注入时钟变化（只用观测值）', () => {
  let clock = 1_000
  const ticks = []
  const tracker = createProgressTracker({
    now: () => clock,
    intervalMs: 50,
    setTimer: () => 1,
    clearTimer: () => {},
    describe: () => ({ phase: 'running', exited: false }),
    onTick: (state) => ticks.push(state),
  })

  assert.equal(tracker.start(), true)
  clock = 3_000
  assert.equal(tracker.noteOutput(100), 100)

  clock = 3_400
  tracker.tick()
  assert.deepEqual(ticks[0], {
    phase: 'running',
    exited: false,
    elapsedMs: 2_400,
    outputBytes: 100,
    lastOutputAgoMs: 400,
  })

  clock = 9_400
  tracker.tick()
  assert.equal(ticks[1].elapsedMs, 8_400, 'elapsedMs 必须随时钟增长')
  assert.equal(ticks[1].lastOutputAgoMs, 6_400, 'lastOutputAgoMs 必须随静默时长增长')
  assert.equal(ticks[1].outputBytes, 100, '没有新输出时字节数不得变化')

  clock = 9_500
  tracker.noteOutput(60)
  clock = 9_600
  tracker.tick()
  assert.equal(ticks[2].outputBytes, 160, '字节数必须累加')
  assert.equal(ticks[2].lastOutputAgoMs, 100, 'noteOutput 必须重置"距上次输出"')
  tracker.stop()
})

test('P6 定时器：start 幂等、stop 清定时器、停止后不再推送', () => {
  const timers = []
  const cleared = []
  const ticks = []
  const tracker = createProgressTracker({
    now: () => 0,
    intervalMs: 250,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimer: (id) => cleared.push(id),
    onTick: (state) => ticks.push(state),
  })

  assert.equal(tracker.start(), true)
  assert.equal(tracker.start(), false, 'start 必须幂等：不得产生第二个定时器')
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 250, '定时器间隔必须来自 intervalMs')
  assert.equal(tracker.intervalMs, 250)

  timers[0].fn() // 模拟定时器触发
  assert.equal(ticks.length, 1, '定时器触发必须推送一次快照')

  assert.equal(tracker.stop(), true)
  assert.deepEqual(cleared, [1], 'stop 必须清掉该定时器')
  assert.equal(tracker.stop(), false, 'stop 必须幂等')
  assert.equal(tracker.isRunning(), false)
  assert.equal(tracker.tick(), false, '停止之后不得再推送')
  assert.equal(ticks.length, 1)
})

test('P6b 非法间隔退回默认值，不抛', () => {
  for (const bad of [0, -1, 1.5, NaN, '1000', undefined, null]) {
    const tracker = createProgressTracker({ intervalMs: bad, setTimer: () => 1, clearTimer: () => {} })
    assert.equal(tracker.intervalMs, DEFAULT_PROGRESS_INTERVAL_MS, `intervalMs=${String(bad)} 必须退回默认`)
    tracker.stop()
  }
})

test('P7 进入终态后：清掉定时器，且不再推送任何进度行', () => {
  const cleared = []
  const ticks = []
  let phase = 'running'
  const tracker = createProgressTracker({
    now: () => 0,
    intervalMs: 100,
    setTimer: () => 7,
    clearTimer: (id) => cleared.push(id),
    describe: () => ({ phase, exited: phase !== 'running' }),
    onTick: (state) => ticks.push(state),
  })

  tracker.start()
  assert.equal(tracker.tick(), true)
  assert.equal(ticks.length, 1)

  phase = 'killed'
  assert.equal(tracker.tick(), false, '终态 tick 不得推送')
  assert.equal(ticks.length, 1, '终态后不得再更新进度行')
  assert.deepEqual(cleared, [7], '终态必须清掉定时器')
  assert.equal(tracker.isRunning(), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// 集成：pump 清洗后的文本进 job 输出环 + 进度行接线 + 清理
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 装一个够真的假 ctx：jobs.start 提供一个**记录型** handle（append/updateProgress 都留痕），
 * 并捕获 ctx.effect 注册的 teardown，供"清理路径"用例调用。
 */
function mountPlugin(rawConfig = { ptyBackend: 'host' }) {
  const tools = new Map()
  let pty = makeFakePty()
  let effectFactory
  let jobSeq = 0
  const jobs = new Map()
  const jobCalls = []

  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    subprocess: { spawnTerminal: async () => pty.handle },
    sandboxPolicy: {
      defaultMode: 'workspace-write',
      resolve: () => ({ mode: 'workspace-write', workspaceRoot: 'F:/ws' }),
    },
    sessionProjections: { stateOf: () => 'workspace-write' },
    jobs: {
      start(spec) {
        jobSeq += 1
        const id = `terminal-${jobSeq}`
        const handle = {
          appended: [],
          progress: [],
          append(text, opts) {
            handle.appended.push(text)
            jobCalls.push({ id, kind: 'append', text, opts })
          },
          updateProgress(line) {
            // 契约：单行字符串。实现若推了别的类型，这里会留下证据
            handle.progress.push(line)
            jobCalls.push({ id, kind: 'progress', line })
          },
        }
        jobs.set(id, { status: 'running', handle })
        const hooks = spec.run(handle)
        assert.equal(typeof hooks?.done?.then, 'function', 'hooks.done 必须是 Promise')
        hooks.done.then(
          (outcome) => {
            jobs.get(id).status = outcome?.status
            jobs.get(id).detail = outcome?.detail
          },
          (error) => {
            jobs.get(id).status = 'failed'
            jobs.get(id).detail = `producer rejected: ${String(error)}`
          },
        )
        return id
      },
    },
    get: (name) => {
      if (name === 'sandbox') return { confine: async (argv) => ({ argv: ['runner', '--', ...argv] }) }
      if (name === 'logger') return { info() {}, warn() {}, error() {}, debug() {} }
      return undefined
    },
    effect(factory) {
      effectFactory = factory
    },
  }

  const runtime = apply(ctx, { shellPath: SHELL, shellDialect: 'pwsh', ...rawConfig })
  const ownerCtxs = new Map()

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
    jobs,
    jobCalls,
    agentFor,
    pty: () => pty,
    setPty: (next) => {
      pty = next
    },
    handleFor: (jobId) => jobs.get(jobId)?.handle,
    record: (owner) => runtime.admission.listForOwner(owner)[0],
    call(name, args, owner) {
      const definition = tools.get(name)
      assert.ok(definition, `工具 ${name} 未注册`)
      // 测试统一注入极短 `waitMs`（产品默认是有界等待 10s；假 PTY 的帧永不闭合）
      const effective = name === 'terminal_exec' ? { waitMs: 1, ...args } : args
      return definition.execute(effective, { agent: owner, signal: undefined })
    },
    /** 走插件自己的 `ctx.effect` 清理路径（不 await：可能被挂住的 terminate 卡住）。 */
    teardown() {
      assert.ok(effectFactory, 'ctx.effect 必须已注册')
      return Promise.resolve(effectFactory()())
    },
  }
}

test('P8 集成：job 输出环收到**清洗后**文本（与 terminal_read 一致），进度行经 updateProgress 推送，终态即停', async () => {
  const h = mountPlugin({ progressIntervalMs: 15, ptyBackend: 'host' })
  const owner = h.agentFor()
  const pty = h.pty()

  const exec = await h.call('terminal_exec', { command: 'npm run build' }, owner)
  assert.equal(typeof exec.jobId, 'string')

  // 带 ANSI 颜色的输出：模型读到的是清洗后的文本，jobs 必须拿到**同一份**
  pty.emit('\x1b[32mbuilding 1/3\x1b[0m\r\n')
  const gotOutput = await until(() => h.handleFor(exec.jobId).appended.join('').includes('building 1/3'))
  assert.ok(gotOutput, 'job 输出环必须收到 PTY 输出（append 从未被调用 = /jobs 面板零输出的老缺陷）')

  const appended = h.handleFor(exec.jobId).appended.join('')
  assert.doesNotMatch(appended, /\x1b\[/, 'job 输出环必须收到清洗后的文本，不能带 ANSI 转义')
  const read = await h.call('terminal_read', { sessionId: exec.sessionId }, owner)
  assert.match(read.text, /building 1\/3/)
  assert.equal(appended, read.text, 'job 输出环的内容必须与模型读到的完全一致')

  // 实时进度行
  //
  // 注意：`progress.length >= 1` 在**第一帧**就满足，而第一帧可能早于输出到达——
  // 那时 `out 0B · no output yet` 是**正确**的观测。所以这里必须等到进度行**反映出
  // 真实产出**再断言，否则会把"时序"误判成"接线缺陷"（我最初就是这么误判的）。
  const gotProgress = await until(() => h.handleFor(exec.jobId).progress.length >= 1)
  assert.ok(gotProgress, '必须有实时进度行推给 /jobs（等待期间要能看见"还在干活"）')
  const reflected = await until(() => {
    const latest = h.handleFor(exec.jobId).progress.at(-1)
    return typeof latest === 'string' && !/no output yet/.test(latest)
  })
  assert.ok(
    reflected,
    `进度行始终没有反映真实输出（最后一条：${JSON.stringify(h.handleFor(exec.jobId).progress.at(-1))}）——`
      + '说明 data 回调没有把字节喂给 tracker.noteOutput',
  )
  const line = h.handleFor(exec.jobId).progress.at(-1)
  assert.equal(typeof line, 'string')
  assert.ok(line.length <= PROGRESS_MAX_CHARS, `进度行必须有界，实得 ${line.length}`)
  assert.match(
    line,
    /^phase \S+ · elapsed \S+ · out \S+ · (?:last \S+ ago|no output yet) · (?:alive|exited)$/,
    `进度行形状不符：${line}`,
  )
  assert.match(line, /· alive$/, '会话仍在运行时必须报 alive（观测，不是判断）')
  assert.doesNotMatch(line, /stuck|hung|idle|stall|卡死/i)

  // ── 值断言（不是形状断言）────────────────────────────────────────────────
  //
  // 上面那条正则只要求 `out \S+`，而 **`0B` 也满足它** —— 于是"进度行永远显示
  // `out 0B · no output yet`"这个缺陷在 221 条测试下静默存活了很久：
  // tracker 的 `noteOutput()` 没有被喂过，字节数恒为初值。
  // 这条用例存在的意义就是"长任务能看出在干活"，所以必须断言**真实值**。
  assert.doesNotMatch(
    line,
    /no output yet/,
    `已经产出过输出，进度行却报 "no output yet"：${line}\n`
      + '（说明 data 回调没有把字节喂给 tracker.noteOutput）',
  )
  const outField = /· out (\S+) ·/.exec(line)?.[1]
  assert.ok(outField && outField !== '0B', `进度行的输出字节必须反映真实产出，实得 ${outField}：${line}`)
  assert.match(line, /· last \S+ ago ·/, '有输出之后应报"距上次输出"而非 no output yet')

  // 终态即停
  pty.exit(0)
  const settled = await until(() => TERMINAL_PHASES.has(h.record(owner)?.phase))
  assert.ok(settled, 'shell 退出必须被收口')
  const atSettle = h.handleFor(exec.jobId).progress.length
  await sleep(90) // > 5 × intervalMs
  assert.equal(h.handleFor(exec.jobId).progress.length, atSettle, '终态后不得再更新进度行')
  assert.equal(h.record(owner).progressTracker, undefined, '终态必须释放进度定时器')
})

test('P9 清理路径：会话不落定时 teardown 必须停掉进度定时器（不泄漏）', async () => {
  const h = mountPlugin({ progressIntervalMs: 15, ptyBackend: 'host' })
  const owner = h.agentFor()
  const pty = makeFakePty()
  // done 永不落定 + terminate 挂住：会话永远不会结算，唯一能停掉定时器的就是 teardown
  pty.handle.done = new Promise(() => {})
  pty.handle.terminate = () => new Promise(() => {})
  h.setPty(pty)

  const exec = await h.call('terminal_exec', { command: 'npm install' }, owner)
  pty.emit('added 1 package\r\n')
  const gotProgress = await until(() => h.handleFor(exec.jobId).progress.length >= 1)
  assert.ok(gotProgress, '活动会话必须有进度行')
  assert.notEqual(h.record(owner).progressTracker, undefined)

  void h.teardown() // 不 await：收口会被挂住的 terminate 卡住，但定时器清理是同步先做的
  const atTeardown = h.handleFor(exec.jobId).progress.length
  await sleep(90)
  assert.equal(
    h.handleFor(exec.jobId).progress.length,
    atTeardown,
    'teardown 之后不得再推送进度行（否则就是定时器泄漏）',
  )
})

test('P10 尺寸/时长格式化的边界（含极大值与未知值）', () => {
  assert.equal(formatDuration(0), '0.0s')
  assert.equal(formatDuration(999), '1.0s')
  assert.equal(formatDuration(59_999), '60.0s')
  assert.equal(formatDuration(60_000), '1m00s')
  assert.equal(formatDuration(3_599_000), '59m59s')
  assert.equal(formatDuration(3_600_000), '1h00m')
  assert.equal(formatDuration(undefined), '0.0s')
  assert.equal(formatBytes(0), '0B')
  assert.equal(formatBytes(1_023), '1023B')
  assert.equal(formatBytes(1_024), '1.0KB')
  assert.equal(formatBytes(1_048_576), '1.0MB')
  assert.equal(formatBytes(undefined), 'unknown')
})
