/**
 * 验收探针：直连 node-pty 的目标闭环
 *   起终端 → 设变量 → 读回变量值 → 跑真实构建 → 读回构建状态 → 占端口 → 释放端口 → 关闭
 *
 * 用法（**必须在非受限环境下跑**：受限令牌无法创建 ConPTY 的命名管道，
 * 也无法派生子进程，两者都会让本探针失败——那是环境限制，不是插件缺陷）：
 *
 *   node tools/probe-acceptance.mjs
 *
 * 当前结果：10/10 通过（Windows + pwsh 7.4 + node-pty 1.2.0-beta.15）。
 *
 * ## 为什么用「文件传结果」而不是解析 PTY 文本
 *
 * 早期版本解析 PTY 输出来取结果，反复失败——而终端本身是好的。原因是 PTY 会把
 * **被截断的命令回显**与终端里发生过的其它操作残留一起投递，「命令回显」与
 * 「命令结果」难以可靠区分（实测：构建其实成功，`BUILD_DONE=yes` 与 `EXIT=0`
 * 都在，是取区间取错了）。
 *
 * 本版让命令把结果**写进文件**，再由 Node 直接读文件；端口那两条还用 Node 侧
 * 独立 bind 试探来反证"占用是真的/释放是真的"。这样验收判定不依赖脆弱的文本解析。
 *
 * 唯一仍走文本解析的是「读回 shell 变量」——那正是被验收的能力本身。
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const pty = require('node-pty')

const SHELL = process.env.DSH_BGTERM_SHELL ?? 'pwsh'
const WORKDIR = join(process.cwd(), '.tmp', 'pty-acceptance')
const RESULT = join(WORKDIR, 'result.txt')

const shell = pty.spawn(SHELL, ['-NoLogo', '-NoProfile'], {
  name: 'xterm-256color', cols: 200, rows: 40, cwd: process.cwd(),
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const strip = (t) => t
  .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
  .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\r/g, '')

let latest = ''
shell.onData((c) => { latest += c })

/**
 * 在**被测的持久 shell 里**执行一段 PowerShell，并等它结束。
 *
 * 直接写入主 shell（不另起 pwsh——那会绕过被测对象），用一条独特的结束标记
 * 判断完成。结果不在文本里取，而是由脚本自己写进 `RESULT` 文件，绕开
 * 「命令回显 vs 命令结果」难以区分的整类问题。
 */
async function exec(file, source, timeoutMs = 40000) {
  writeFileSync(file, source, 'utf8')
  latest = ''
  shell.write(`& '${file}' *> '${RESULT}' ; Write-Output '__DONE__'\r`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (strip(latest).includes('__DONE__')) break
    await sleep(100)
  }
  return { raw: strip(latest) }
}

const results = []
const check = (name, actual, expected) => {
  const ok = actual === expected
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

async function readResult() {
  try { return readFileSync(RESULT, 'utf8').trim() } catch { return '' }
}

async function main() {
  mkdirSync(WORKDIR, { recursive: true })
  await sleep(1500)
  await exec(join(WORKDIR, 'init.ps1'), 'Remove-Module PSReadLine -ErrorAction SilentlyContinue')

  // ① 预设变量并读回（唯一走文本解析的一项：这本身就是被验收的能力）
  latest = ''
  shell.write("$global:DSH_VERDICT = 'acceptance-passed'; Write-Output \"VALUE=$global:DSH_VERDICT\"\r")
  {
    const deadline = Date.now() + 15000
    let val
    while (Date.now() < deadline && val === undefined) {
      // 取标记之前、回显之后的第一处结果：从后往前找第一个不含命令本身的 VALUE=
      const lines = strip(latest).split('\n').map((l) => l.trim())
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const m = /^VALUE=(.+)$/.exec(lines[i])
        if (m) { val = m[1].trim(); break }
      }
      if (val === undefined) await sleep(200)
    }
    check('① 读回预设变量值', val, 'acceptance-passed')
  }

  // ② 真实构建：写构建脚本 → 在 PTY 里执行 → 产出工件
  writeFileSync(join(WORKDIR, 'build.mjs'), [
    "import { writeFileSync } from 'node:fs'",
    "writeFileSync(process.argv[2], JSON.stringify({ built: true, port: 45871 }))",
    "console.log('BUILD_DONE=yes')",
  ].join('\n'), 'utf8')
  const outJson = join(WORKDIR, 'out.json')
  if (existsSync(outJson)) rmSync(outJson)
  // 构建结果由 Node 直接检查文件，不依赖终端文本
  await exec(join(WORKDIR, 'build.ps1'), `& node '${join(WORKDIR, 'build.mjs')}' '${outJson}'`)
  // 构建脚本由 PTY 里的 node 子进程写出产物；`__DONE__` 到达时该写入可能尚未
  // 对本进程可见（跨进程/杀毒扫描延迟）。这里重试等待，而不是把竞态判成失败。
  {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !existsSync(outJson)) await sleep(100)
  }
  check('② 构建产物落盘', existsSync(outJson), true)
  let built = null
  if (existsSync(outJson)) { try { built = JSON.parse(readFileSync(outJson, 'utf8')) } catch {} }
  check('② 产物内容 built', built?.built, true)
  check('② 产物内容 port', built?.port, 45871)

  // ③ 在 PTY 里读回构建产物（证明 shell 能读到状态）
  await exec(join(WORKDIR, 'state.ps1'),
    `$s = Get-Content '${outJson}' -Raw | ConvertFrom-Json; "BUILT=$($s.built)"; "PORT=$($s.port)"`)
  const stateText = await readResult()
  check('③ shell 读回 built', /BUILT=True/.test(stateText), true)
  check('③ shell 读回 port', /PORT=45871/.test(stateText), true)

  // ④ 占端口 → 释放（用 Node 侧独立验证端口真的归还了）
  const { createServer } = await import('node:net')
  await exec(join(WORKDIR, 'bind.ps1'),
    `$global:l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 45871); $global:l.Start(); "BOUND=$($global:l.LocalEndpoint.Port)"`)
  check('④ shell 绑定端口', /BOUND=45871/.test(await readResult()), true)

  // 端口被 shell 占用时，Node 侧应 bind 失败 —— 反证占用是真的
  const busyBefore = await new Promise((resolve) => {
    const s = createServer()
    s.once('error', () => resolve(true))
    s.once('listening', () => { s.close(); resolve(false) })
    s.listen(45871, '127.0.0.1')
  })
  check('④ 占用期间端口确实被占（Node 侧 bind 失败）', busyBefore, true)

  await exec(join(WORKDIR, 'release.ps1'), '$global:l.Stop(); "RELEASED=yes"')
  check('④ shell 释放端口', /RELEASED=yes/.test(await readResult()), true)

  // 端口归还后，Node 侧应能 bind —— 这是"真的释放了"的独立证据
  const freeAfter = await new Promise((resolve) => {
    const s = createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => { s.close(); resolve(true) })
    s.listen(45871, '127.0.0.1')
  })
  check('④ 释放后 Node 侧可绑定（端口已归还）', freeAfter, true)

  // ⑤ 关闭会话
  shell.kill()
  await sleep(500)
  rmSync(WORKDIR, { recursive: true, force: true })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n===== 结果：${results.length - failed.length}/${results.length} 通过 =====`)
  if (failed.length > 0) { console.log('未通过:', failed.map((f) => f.name).join('; ')); process.exitCode = 1 }
}

main().catch((e) => { console.error('PROBE FAILED:', e.stack ?? e.message); try { shell.kill() } catch {}; process.exitCode = 1 })
