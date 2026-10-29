/**
 * 验收执行器：在宿主进程里按目标闭环调用四个工具。
 *
 * ## 用法（宿主重启后，在项目根执行）
 *
 *   node tools/acceptance-run.mjs
 *
 * ## 它为什么存在
 *
 * `tools/probe-acceptance.mjs` 直接测 node-pty（绕过插件），用来证明"这条路可行"。
 * 本文件则通过**插件自己的工具**跑同一套闭环，用来证明"插件接线正确"。
 * 两者互补：前者验技术路线，后者验集成。
 *
 * ## 它验证的目标闭环
 *
 *   ① terminal_exec 起一个持久 shell（不再 127）
 *   ② 在 shell 里设置预设变量并读回          → "读取到预设设置的变量值"
 *   ③ 跑一次真实构建并落盘产物               → "成功构建"
 *   ④ 读回构建状态（terminal_state + 正文）   → "读取到某些状态"
 *   ⑤ 占用端口 → 释放端口（Node 侧独立反证）  → "最后结束释放端口"
 *   ⑥ terminal_signal close 释放会话          → 完整流程收尾
 *
 * ## 前置条件
 *
 * - 宿主已重启并加载新代码（返回的 shell.version 应与 package.json 的 version 一致）
 * - 宿主进程**不受限**：受限令牌无法创建 ConPTY 的命名管道。
 *   若在受限环境跑，`terminal_exec` 会返回 `startup-failed`，
 *   本脚本会明确报出这一点而不是给出误导性的结论。
 *
 * ## 怎么拿到工具
 *
 * 本脚本不直接 import 插件（那会绕过宿主）。它从 DSH profile 里读插件的
 * `apply()`，用**最小假 ctx** 挂载后调用工具——与冷测试同一套路，但
 * 跑的是真实 node-pty 后端。
 */
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)

const PLUGIN = fileURLToPath(new URL('../lib/index.js', import.meta.url))
/** 持久 shell 的可执行文件：DSH_BGTERM_SHELL 覆盖；默认用 PATH 上的 pwsh。 */
const SHELL = process.env.DSH_BGTERM_SHELL ?? 'pwsh'
const WORKDIR = join(process.cwd(), '.tmp', 'acceptance-run')
const PORT = 45873

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, actual, expected) => {
  const ok = actual === expected
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
  return ok
}

/** 最小 job 注册表：只实现插件用到的 start() 与 handle 契约。 */
function makeJobs() {
  const jobs = new Map()
  let seq = 0
  return {
    jobs,
    start(spec) {
      const id = `job-${++seq}`
      const state = { id, status: 'running', progress: undefined, appended: '', detail: undefined }
      jobs.set(id, state)
      const done = new EventEmitter()
      state.settle = (status, detail) => {
        state.status = status
        state.detail = detail
        done.emit('settled')
      }
      const handle = {
        append(text) { state.appended += text },
        updateProgress(line) { state.progress = line },
      }
      const hooks = spec.run(handle)
      Promise.resolve(hooks.done).then(
        (outcome) => state.settle(outcome?.status ?? 'completed', outcome?.detail),
        () => state.settle('failed', 'job failed'),
      )
      return id
    },
  }
}

/** 最小假 ctx：只提供插件注入的那 5 个服务，其余经 get() 返回 undefined。 */
function makeCtx() {
  const tools = new Map()
  const jobs = makeJobs()
  const owner = {
    id: 'acceptance-agent',
    session: { header: { cwd: process.cwd() } },
    ctx: { on() {} },
  }
  const ctx = {
    tools: { register(def) { tools.set(def.name, def) } },
    jobs,
    subprocess: {
      // 本验收走 node-pty 后端，宿主接缝**不应被调用**；真被调到就是接线错误
      async spawnTerminal() { throw new Error('acceptance: ctx.subprocess.spawnTerminal should not be used with ptyBackend=node-pty') },
    },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }), defaultMode: 'workspace-write' },
    sessionProjections: { stateOf: () => undefined },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on() {}, off() {}, effect(fn) { return fn() },
    get: () => undefined,
  }
  return { ctx, tools, jobs, owner }
}

const main = async () => {
  const { apply } = await import(pathToFileURL(PLUGIN).href)
  const { ctx, tools, jobs, owner } = makeCtx()
  const runtime = apply(ctx, { shellPath: SHELL, shellDialect: 'pwsh' })
  // 工具签名是 `execute(args, exec)`，owner 来自 `exec.agent`（见 index.js 的注册处）
  const call = (name, args) => {
    const def = tools.get(name)
    if (!def) throw new Error(`工具未注册: ${name}`)
    return def.execute(args, { agent: owner })
  }
  console.log('已注册工具:', [...tools.keys()].join(', '))
  console.log('后端版本:', runtime?.config?.ptyBackend, '| plugin', runtime?.config?.shellDialect)

  mkdirSync(WORKDIR, { recursive: true })

  // ① 起会话
  const exec = await call('terminal_exec', { command: 'Write-Output "__READY__"', label: 'acceptance' })
  // 累积所有增量读取的文本，供后续断言（terminal_read 契约是"不重复"）
  let allOutput = ''
  console.log('\n① terminal_exec →', JSON.stringify({ status: exec.status, version: exec.shell?.version, code: exec.code }))
  if (!check('① 会话已启动（非 127/startup-failed）', exec.status === 'running', true)) {
    console.log('   诊断:', String(exec.diagnostics ?? exec.detail ?? '').slice(0, 600))
    console.log('\n若为 startup-failed 且提示命名管道/EPERM，说明当前进程受限于 DSH 沙箱，')
    console.log('需在宿主进程（非受限）内运行本脚本。')
    process.exitCode = 1
    return
  }

  // ② 预设变量并读回
  await call('terminal_write', { sessionId: exec.sessionId, data: "$global:DSH_VERDICT = 'roundtrip-ok'", newline: true })
  await sleep(400)
  const readVar = await call('terminal_read', { sessionId: exec.sessionId })
  allOutput += String(readVar.text ?? '')
  check('② 读回预设变量值', /roundtrip-ok/.test(allOutput), true)

  // ③ 真实构建
  const script = join(WORKDIR, 'build.mjs')
  const outJson = join(WORKDIR, 'out.json')
  writeFileSync(script, [
    "import { writeFileSync } from 'node:fs'",
    "writeFileSync(process.argv[2], JSON.stringify({ built: true, port: " + PORT + " }))",
    "console.log('BUILD_DONE=yes')",
  ].join('\n'), 'utf8')
  if (existsSync(outJson)) rmSync(outJson)
  await call('terminal_write', {
    sessionId: exec.sessionId,
    data: `& node "${script}" "${outJson}"`,
    newline: true,
  })
  {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && !existsSync(outJson)) await sleep(150)
  }
  check('③ 构建产物落盘', existsSync(outJson), true)
  let built = null
  if (existsSync(outJson)) { try { built = JSON.parse(readFileSync(outJson, 'utf8')) } catch {} }
  check('③ 产物 built', built?.built, true)

  // ④ 读回状态：优先用 terminal_state（task-10 落地后才有）
  if (tools.has('terminal_state')) {
    const state = await call('terminal_state', { sessionId: exec.sessionId })
    console.log('\n④ terminal_state →', JSON.stringify(state, null, 2).slice(0, 700))
    check('④ state.enforcement 如实上报', ['confined', 'windows-pty-unconfined', 'unconfined'].includes(state.enforcement), true)
    // elapsedMs 在跑就说明快照读到了真实的发布时间锚；字节数在长任务阶段（⑥）断言，
    // 因为那里的输出是确定到达的——这里 shell 可能刚就绪，`outputBytes` 仍为 0 属正常。
    check('④ state.elapsedMs 有观测值', typeof state.elapsedMs === 'number' && state.elapsedMs > 0, true)
  } else {
    console.log('\n④ terminal_state 尚未注册（task-10 未落地），跳过结构化状态检查')
  }
  const readState = await call('terminal_read', { sessionId: exec.sessionId })
  // `terminal_read` 是**增量**契约（"不重复"）：所以必须累积所有读到的文本再找，
  // 不能只看最后一次——BUILD_DONE 很可能已被前面那次读走。
  allOutput += String(readState.text ?? '')
  check('④ 正文里能看到构建输出', /BUILD_DONE=yes/.test(allOutput), true)

  // ⑤ 端口占用与释放（Node 侧独立反证）
  await call('terminal_write', {
    sessionId: exec.sessionId,
    data: `$global:l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, ${PORT}); $global:l.Start(); Write-Output "BOUND=$($global:l.LocalEndpoint.Port)"`,
    newline: true,
  })
  await sleep(800)
  const busy = await new Promise((resolve) => {
    const s = createServer()
    s.once('error', () => resolve(true))
    s.once('listening', () => { s.close(); resolve(false) })
    s.listen(PORT, '127.0.0.1')
  })
  check('⑤ 占用期间端口确实被占（独立反证）', busy, true)

  await call('terminal_write', { sessionId: exec.sessionId, data: '$global:l.Stop(); Write-Output "RELEASED=yes"', newline: true })
  await sleep(800)
  const free = await new Promise((resolve) => {
    const s = createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => { s.close(); resolve(true) })
    s.listen(PORT, '127.0.0.1')
  })
  check('⑤ 释放后端口已归还（独立反证）', free, true)

  // ⑥ 长任务期间读取状态：插件存在的理由
  //
  // 起一个**持续往 stdout 输出、长时间不结束**的进程（模拟 vite build / 慢下载），
  // 在它运行期间读状态，确认会话仍 running、outputBytes 在增长，然后干净收尾。
  //
  // 两条踩过的坑，都写在这里免得重犯：
  //  · `Start-Job` —— 输出在**独立进程**里，必须 `Receive-Job` 才回控制台，PTY 上看不到字节；
  //  · `Start-ThreadJob` —— 输出被收集进**作业对象**，同样不落控制台（且该模块未必存在）。
  // 两者都会让 outputBytes 看起来"停止增长"，把正常的静默误判成卡死。
  // 直接跑子进程才是真实形态。
  const ticker = join(WORKDIR, 'ticker.mjs')
  writeFileSync(ticker, [
    'let i = 0',
    "const t = setInterval(() => { process.stdout.write(`TICK ${++i}\\n`) }, 250)",
    'setTimeout(() => { clearInterval(t) }, 60000)',
  ].join('\n'), 'utf8')
  await call('terminal_write', {
    sessionId: exec.sessionId,
    data: `& node "${ticker}"`,
    newline: true,
  })
  await sleep(600)
  const during = tools.has('terminal_state') ? await call('terminal_state', { sessionId: exec.sessionId }) : null
  if (during) {
    console.log('\n⑥ 长任务运行中的状态 →', JSON.stringify({
      phase: during.phase, outputBytes: during.outputBytes, lastOutputAgoMs: during.lastOutputAgoMs,
    }))
    check('⑥ 任务期间会话仍 running（未卡死）', during.phase, 'running')
    // 长任务阶段输出确定已到达：这里才是断言字节计数的正确位置
    check('⑥ outputBytes 有观测值', typeof during.outputBytes === 'number' && during.outputBytes > 0, true)
    check('⑥ lastOutputAgoMs 有观测值', typeof during.lastOutputAgoMs === 'number', true)
  }
  const before = during?.outputBytes ?? 0
  await sleep(1400)
  const after = await call('terminal_read', { sessionId: exec.sessionId })
  allOutput += String(after.text ?? '')
  check('⑥ 任务期间仍有输出可读（TICK）', /TICK/.test(allOutput), true)
  if (during) {
    // 顺序很重要：先读正文**再**取状态，否则状态里的字节数已经被更早的读取消费过
    const later = await call('terminal_state', { sessionId: exec.sessionId })
    console.log('   1.4s 后 →', JSON.stringify({ outputBytes: later.outputBytes, lastOutputAgoMs: later.lastOutputAgoMs }))
    check('⑥ outputBytes 在增长（正面活动信号）', later.outputBytes > before, true)
  }
  await call('terminal_write', { sessionId: exec.sessionId, data: '\u0003Write-Output "TICKER_STOPPED"', newline: true })
  await sleep(600)

  // ⑦ 关闭会话并确认
  await call('terminal_signal', { sessionId: exec.sessionId, close: true })
  await sleep(500)
  const finalRead = await call('terminal_read', { sessionId: exec.sessionId }).catch((e) => ({ error: String(e.message) }))
  check('⑦ 会话已收口', ['killed', 'exited'].includes(finalRead.status), true)

  rmSync(WORKDIR, { recursive: true, force: true })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n===== 验收结果：${results.length - failed.length}/${results.length} 通过 =====`)
  if (failed.length > 0) {
    console.log('未通过:', failed.map((f) => f.name).join('; '))
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('验收执行失败:', error.stack ?? error.message)
  process.exitCode = 1
})
