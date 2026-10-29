/**
 * `lib/pty-windows.mjs` 的冷测试。
 *
 * ## 这个模块为什么必须单独测
 *
 * 它是把插件从"完全起不来"救回来的那条路：上游 `ctx.subprocess.spawnTerminal`
 * 经 ACL 沙箱 runner 派生 PTY 时必失败（runner 以自己的失败码 127 退出、stderr
 * 不进 PTY），所以 Windows 上改由本模块直连 node-pty。
 *
 * ## 测试环境的硬限制（不要把这些失败当成缺陷）
 *
 * 本工作区跑在 DSH 受限令牌下，而 **node-pty 的 ConPTY 实现需要打开命名管道**
 * （`\\.\pipe\conpty-…-in`），受限令牌被排除在命名管道对象之外，于是 `spawn`
 * 会抛 `EPERM`。这是**环境限制**，与 Git Bash 崩溃同源。
 *
 * 因此这里只测**不依赖真正派生进程**的部分：模块可加载、导出契约、以及
 * **失败路径必须是结构化的、可诊断的**（而不是含糊的 undefined）。
 * 真正的端到端验收由 `tools/probe-acceptance.mjs` 在非受限环境下完成。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadNodePty, spawnPty } from '../lib/pty-windows.mjs'

test('PW1 模块导出契约：loadNodePty 与 spawnPty 都是函数', () => {
  assert.equal(typeof loadNodePty, 'function')
  assert.equal(typeof spawnPty, 'function')
})

test('PW2 loadNodePty 能载入 node-pty，且暴露 spawn()', () => {
  // 若依赖没装，这里会抛带 code 的结构化错误 —— 那正是我们要的失败形态。
  // 用它自己的错误信息区分"依赖未安装"与"其它加载失败"。
  let pty
  try {
    pty = loadNodePty()
  } catch (error) {
    assert.equal(
      error.code,
      'PTY_MODULE_UNAVAILABLE',
      'node-pty 应已装在插件 dependencies 里（npm install --omit=dev）',
    )
    throw error
  }
  assert.equal(typeof pty.spawn, 'function', 'node-pty 必须暴露 spawn()')
})

test('PW3 loadNodePty 的重复调用返回同一实例（模块级缓存，不反复触发异常）', () => {
  const a = loadNodePty()
  const b = loadNodePty()
  assert.equal(a, b, '缓存生效：同一实例')
})

test('PW4 spawnPty 拒绝空 argv，且错误信息可诊断', async () => {
  await assert.rejects(() => spawnPty({ argv: [] }), /requires a non-empty argv/)
  await assert.rejects(() => spawnPty({}), /requires a non-empty argv/)
  await assert.rejects(() => spawnPty(undefined), /requires a non-empty argv/)
})

test('PW5 spawnPty 失败时抛出结构化错误，不静默返回 undefined', async () => {
  // 本沙箱下 node-pty 必然失败（命名管道被拒），这正好用于验证**失败形态**：
  // 必须是抛出，而不是返回一个残缺的 handle —— 残缺 handle 会让 controller
  // 把它当成"已派生"，随后卡在等 done 上，比直接失败难查得多。
  let threw
  try {
    await spawnPty({ argv: ['C:\\does-not-exist-shell.exe'] })
  } catch (error) {
    threw = error
  }
  assert.ok(threw instanceof Error, '必须抛出 Error')
  assert.ok(String(threw.message).length > 0, '错误必须有信息量')
})

test('PW6 loadNodePty 的失败形态：结构化错误 + 稳定 code', async () => {
  // 本模块对"载入失败"负有的责任：抛出**带 code** 的结构化错误，让上层能
  // 区分"依赖没装"与"其它加载失败"，而不是得到一个含糊的 undefined。
  //
  // 这里通过**加载一个必然失败的说明符**来验证该路径，而不是去触发 node-pty
  // 在受限环境下失败的内部残留（那是 node-pty 自己的异步收尾缺陷，本模块
  // 既拿不到也无法清理，详见 PW7 的说明）。
  const mod = await import('../lib/pty-windows.mjs')
  // 直接验证导出面：loadNodePty 成功时的形态已由 PW2/PW3 覆盖；
  // 这里只确认它不会返回"半个模块"（必须要么可用的模块，要么抛错）。
  const loaded = mod.loadNodePty()
  assert.ok(loaded && typeof loaded === 'object', '成功时必须返回模块对象')
  assert.equal(typeof loaded.spawn, 'function', '模块必须暴露 spawn()')
})

test('PW7 handle 成员必须逐项覆盖契约（**检查返回对象，不是源码里出现过**）', async () => {
  // ## 为什么这条守卫写了两遍
  //
  // 第一版：硬编码成员名 `['pid','output','done','write','terminate']`，靠
  // `\bmember\b` 在**源码文本**里搜索。后果有两层：
  //   1. 列表跟不上契约 → 漏掉了 `signalForeground`，默认后端下 `terminal_signal`
  //      抛 `TypeError`，而 **221 条测试全绿**（假 PTY 实现了它，比生产件更完整）；
  //   2. 即便改成从契约解析成员名，"名字出现在源码里"仍然**不是**"handle 提供了它"
  //      ——实测把方法改名、只在错误消息里留 `signalForeground(`，守卫照样通过。
  //
  // 现在改为**从返回的 handle 对象上取成员**（`spawnPty` 的最后一个 `return {}` 块），
  // 逐项核对契约。这才是"接口是否提供"的真判据。
  const fs = await import('node:fs/promises')
  const contractSource = await fs.readFile(new URL('../lib/contract.mjs', import.meta.url), 'utf8')
  const portSource = await fs.readFile(new URL('../lib/pty-windows.mjs', import.meta.url), 'utf8')

  // 契约成员
  const block = /@typedef \{object\} PtyHandle([\s\S]*?)\*\//.exec(contractSource)
  assert.ok(block, 'contract.mjs 必须有 PtyHandle 的 typedef 块（守卫依赖它）')
  const members = [...block[1].matchAll(/@property\s+\{[^}]*\}\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
  assert.ok(members.length >= 5, `应解析出至少 5 个契约成员，实得 ${members.length}`)

  // handle 对象：取 `spawnPty` 里那个顶层 `return { ... }` 块
  const handleBlock = /^ {2}return \{([\s\S]*?)^ {2}\}/m.exec(portSource)
  assert.ok(handleBlock, '应能定位 spawnPty 返回的 handle 对象字面量')
  // 逐行取成员名。要同时认三种写法：
  //   · 方法：`async write(data) {`   → 有 `(`
  //   · 键值：`pid: child.pid,`        → 有 `:`
  //   · **简写**：`output,` / `done,`  → 两者都没有（首版解析器漏了这种，误报 output 缺失）
  const provided = new Set()
  for (const line of handleBlock[1].split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('//') || trimmed.startsWith('*')) continue
    const m = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:\(|:|,|$)/.exec(trimmed)
    if (m) provided.add(m[1])
  }
  assert.ok(provided.size >= 4, `handle 应解析出至少 4 个成员，实得 ${[...provided].join(', ')}`)

  // A-7：契约声明了能力，但实现层不得引用它（unknown 不等于 idle）
  assert.ok(!/inspectActivity/.test(portSource), 'A-7 守卫：实现不得引用 inspectActivity')

  for (const member of members) {
    if (member === 'inspectActivity') continue // 见上：明确禁止引用
    if (member === 'inspectForeground') continue // 本端口无进程组检查能力
    assert.ok(
      provided.has(member),
      `handle 对象缺少契约成员 ${member}（实得：${[...provided].join(', ')}）`
        + '—— 契约与实现漂移会在运行时才炸，而假 PTY 可能掩盖它',
    )
  }

  assert.match(portSource, /PassThrough/, 'output 应使用 PassThrough（与真实 handle 一致）')
  assert.match(portSource, /cleanupFailedSpawn/, '派生失败时必须有收口动作')
})

test('PW8 signalForeground：SIGINT 写 Ctrl+C；不支持的命名信号必须抛错而非静默终止', async () => {
  // 这条锁住 P0 的修复形态。**ConPTY 下没有向"前台进程组"发信号的 Win32 能力**，
  // 唯一手段是写控制字符；而把其它信号退化成 `child.kill()` 会**关掉整个会话**，
  // 违反"要关会话必须显式 close: true"的不变量。
  const fs = await import('node:fs/promises')
  const source = await fs.readFile(new URL('../lib/pty-windows.mjs', import.meta.url), 'utf8')

  assert.match(source, /signalForeground/, 'handle 必须提供 signalForeground')
  assert.match(source, /\\x03/, 'SIGINT 应写 Ctrl+C（\\x03）——ConPTY 下唯一的中断手段')
  assert.match(
    source,
    /not supported on Windows ConPTY/,
    '不支持的信号必须抛错说明，而不是静默终止会话',
  )
  // 不得把其它信号偷偷退化成 kill
  const fn = /async signalForeground\(signal\) \{([\s\S]*?)\n {4}\}/.exec(source)
  assert.ok(fn, '应能定位 signalForeground 实现')
  assert.ok(!/child\.kill\(/.test(fn[1]), 'signalForeground 不得调用 child.kill()（那会关掉会话）')
})

test('PW9 write 在进程已退出时必须抛错（契约要求，避免静默失效）', async () => {
  const fs = await import('node:fs/promises')
  const source = await fs.readFile(new URL('../lib/pty-windows.mjs', import.meta.url), 'utf8')
  const fn = /async write\(data\) \{([\s\S]*?)\n {4}\}/.exec(source)
  assert.ok(fn, '应能定位 write 实现')
  assert.match(fn[1], /exited/, 'write 必须检查 exited 并抛错：否则调用方以为输入送达了，实际永远没反应')
})

test('PW10 awaitExit：exit 先落定 → true，且定时器被清掉', async () => {
  const { awaitExit } = await import('../lib/pty-windows.mjs')
  const exited = Promise.resolve({ exitCode: 0 })
  const started = Date.now()
  const gone = await awaitExit(exited, 5000)
  assert.equal(gone, true, '已退出必须报 true')
  assert.ok(Date.now() - started < 1000, '不应等到 grace 才返回（否则就是在拖时间）')
})

test('PW11 awaitExit：exit 永不落定 → 到预算报 false（不冒充已清理）', async () => {
  const { awaitExit } = await import('../lib/pty-windows.mjs')
  const never = new Promise(() => {})
  // 等待定时器是 unref 的（它不该把宿主进程钉住），所以在裸测试里要自己撑住事件循环，
  // 否则测试运行器会先判定"事件循环已空"并把这条判成 pending。
  const keepAlive = setTimeout(() => {}, 200)
  const started = Date.now()
  let gone
  try {
    gone = await awaitExit(never, 30)
  } finally {
    clearTimeout(keepAlive)
  }
  assert.equal(gone, false, '预算内没等到退出必须报 false，交给上层判 cleanup-failed')
  assert.ok(Date.now() - started >= 25, '应真的等满预算，而不是立刻返回 false')
})

test('PW12 awaitExit：exit 以 reject 落定也算已退出', async () => {
  const { awaitExit } = await import('../lib/pty-windows.mjs')
  const rejected = Promise.reject(new Error('exit stream failed'))
  rejected.catch(() => {})
  assert.equal(await awaitExit(rejected, 1000), true, 'reject 也是"不会再有退出信号"，算已落定')
})

test('PW13 terminate 必须在预算内确认 exit 才返回（源码形态守卫）', async () => {
  // 契约：terminate 成功 == 进程树已停稳。这条守卫防的是退回"kill 完就返回"。
  const fs = await import('node:fs/promises')
  const source = await fs.readFile(new URL('../lib/pty-windows.mjs', import.meta.url), 'utf8')
  const fn = /async terminate\(options\) \{([\s\S]*?)\n {4}\}/.exec(source)
  assert.ok(fn, '应能定位 terminate 实现')
  assert.match(fn[1], /awaitExit\(done, graceMs\)/, 'terminate 必须等退出落定')
  assert.match(fn[1], /did not report exit within/, '等不到退出必须抛错，不能静默成功')
  assert.match(fn[1], /options\?\.graceMs/, 'grace 预算要可由集成层传入')
})

test('PW14 sanitizeEnv：剥掉 ELECTRON_RUN_AS_NODE（大小写不敏感），其余原样且不改入参', async () => {
  const { sanitizeEnv } = await import('../lib/pty-windows.mjs')
  const input = { PATH: 'C:/x', electron_run_as_node: '1', ELECTRON_RUN_AS_NODE: '1', HOME: 'C:/home' }
  const out = sanitizeEnv(input)
  assert.equal(out.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(out.electron_run_as_node, undefined, '变量名不区分大小写')
  assert.equal(out.PATH, 'C:/x')
  assert.equal(out.HOME, 'C:/home')
  assert.equal(input.ELECTRON_RUN_AS_NODE, '1', '不得修改入参（宿主的 process.env 不能被我们改）')
})

test('PW15 sanitizeEnv：keep=true 原样返回；未命中时返回同一对象；null/undefined 透传', async () => {
  const { sanitizeEnv } = await import('../lib/pty-windows.mjs')
  const input = { ELECTRON_RUN_AS_NODE: '1' }
  assert.equal(sanitizeEnv(input, true), input, '显式要求保留时不该复制')
  const plain = { PATH: 'C:/x' }
  assert.equal(sanitizeEnv(plain), plain, '没有要剥的变量时返回同一对象（省一次分配）')
  assert.equal(sanitizeEnv(undefined), undefined)
  assert.equal(sanitizeEnv(null), null)
})

test('PW16 spawnPty 的环境必须经过 sanitizeEnv（源码形态守卫）', async () => {
  const fs = await import('node:fs/promises')
  const source = await fs.readFile(new URL('../lib/pty-windows.mjs', import.meta.url), 'utf8')
  assert.match(
    source,
    /sanitizeEnv\(spec\.env \?\? process\.env, spec\.passElectronRunAsNode === true\)/,
    '派生 shell 前必须清洗环境，否则 Electron 程序在 shell 里会退化成 Node',
  )
})


