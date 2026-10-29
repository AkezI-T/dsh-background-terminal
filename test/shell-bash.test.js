/**
 * shell-bash.mjs 的冷测试：只调用纯函数，不创建进程、不碰工作区文件
 * （唯一一次读文件是校验源码的硬约束：只 import `node:*` 与相对路径）。
 *
 * 编号对齐 FINAL.md §16.1：SH1/SH2（framing 语义）、SH4（伪造 marker）、
 * SH6（readiness）、SH8（方言与配置期拒绝）。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { MARKER_PREFIX } from '../lib/contract.mjs'
import {
  READY_BEACON,
  detectReadiness,
  extractFrame,
  resolveShellArgv,
  startupPreamble,
  wrapCommand,
} from '../lib/shell-bash.mjs'

const BASH = 'C:/Program Files/Git/bin/bash.exe'

// ─────────────────────────────────────────────────────────────────────────────
// resolveShellArgv：范围闸门与 argv 校验
// ─────────────────────────────────────────────────────────────────────────────

test('SH8 shellArgs 含一次性执行参数 → 配置期拒绝', () => {
  const oneShot = [
    ['-c'],
    ['-c', 'whoami'],
    ['--noprofile', '--norc', '-i', '-c', 'whoami'],
    ['--command', 'whoami'],
    ['--command=whoami'],
    ['-Command', 'Get-Date'],
    ['-command', 'Get-Date'],
    ['-Command:Get-Date'],
    ['-lc', 'whoami'],
    ['-ic'],
  ]
  for (const args of oneShot) {
    assert.throws(
      () => resolveShellArgv({ shellPath: BASH, shellArgs: args }),
      /one-shot/,
      `shellArgs ${JSON.stringify(args)} 必须被拒绝`,
    )
  }
})

test('SH8 未知方言被拒绝；pwsh 现在受支持（R7-06 已实现）', () => {
  for (const dialect of ['powershell', 'zsh', 'sh', 'cmd']) {
    assert.throws(
      () => resolveShellArgv({ shellPath: BASH, shellDialect: dialect }),
      (error) => {
        assert.match(error.message, /is not supported/)
        assert.match(error.message, new RegExp(dialect))
        return true
      },
      `shellDialect "${dialect}" 必须被拒绝`,
    )
  }
  assert.doesNotThrow(() => resolveShellArgv({ shellPath: BASH, shellDialect: 'bash' }))
  // pwsh 是受支持方言：默认交互参数与 bash 不同
  const pwsh = resolveShellArgv({ shellPath: 'C:\\pwsh.exe', shellDialect: 'pwsh' })
  assert.equal(pwsh.dialect, 'pwsh')
  assert.deepEqual(pwsh.args, ['-NoLogo', '-NoProfile'])
})

test('SH8b pwsh 与 bash 的 wrapper 是两套语法，不共用', () => {
  const bash = wrapCommand('echo hi', 'bash')
  const pwsh = wrapCommand('echo hi', 'pwsh')
  assert.notEqual(bash.text, pwsh.text)
  // bash 用 printf + $?；pwsh 用 [Console]::WriteLine + $LASTEXITCODE
  assert.match(bash.text, /printf/)
  assert.match(bash.text, /\$\?/, 'bash 退出码取自 $?')
  assert.match(pwsh.text, /\[Console\]::WriteLine/)
  assert.match(pwsh.text, /\$LASTEXITCODE/)
  assert.ok(!/printf/.test(pwsh.text), 'pwsh wrapper 不得使用 printf（它不存在）')
  // 两者都带同一 nonce 的 start/end
  assert.ok(bash.start.endsWith('_S__') && bash.end.endsWith('_E__'))
  assert.ok(pwsh.start.endsWith('_S__') && pwsh.end.endsWith('_E__'))
})

test('SH8c pwsh 退出码：原生命令取 $LASTEXITCODE，cmdlet 退回 $? 的布尔', () => {
  const m = wrapCommand('echo hi', 'pwsh')
  const native = extractFrame(`${m.start}\r\nhi\r\n${m.end}0\r\n`, m)
  assert.deepEqual(native, { text: 'hi', exitCode: 0 })
  const nativeFail = extractFrame(`${m.start}\r\nboom\r\n${m.end}1\r\n`, m)
  assert.equal(nativeFail.exitCode, 1)
  // cmdlet 没有数字退出码：`cmdlet:ok` → 0，`cmdlet:fail` → 1
  const cmdletOk = extractFrame(`${m.start}\r\nx\r\n${m.end}cmdlet:ok\r\n`, m)
  assert.equal(cmdletOk.exitCode, 0)
  const cmdletFail = extractFrame(`${m.start}\r\nx\r\n${m.end}cmdlet:fail\r\n`, m)
  assert.equal(cmdletFail.exitCode, 1)
})

test('SH8e 负退出码必须能闭合帧（Ctrl+C 在 Windows 上就是负值）', () => {
  // 真机实测：Ctrl+C 中断 `node` 后帧尾是 `__DSH_BGTERM_…_E__-1073741510`
  // （`-1073741510` = `0xC000013A` = STATUS_CONTROL_C_EXIT）。
  // 只认 `\d+` 会让这类帧**永远闭不上**：`extractFrame` 返回 undefined、
  // 命令级退出码拿不到、`commandRunning` 卡在 true。这是正常路径，不是边角情况。
  const m = wrapCommand('echo hi', 'pwsh')
  const ctrlC = extractFrame(`${m.start}\r\n__DSH_BGTERM_READY__\r\n${m.end}-1073741510\r\n`, m)
  assert.notEqual(ctrlC, undefined, '负退出码的帧必须能闭合')
  assert.equal(ctrlC.exitCode, -1073741510, '负退出码必须原样上报（不取绝对值、不归零）')

  // 正数路径不得被负号支持改变
  const positive = extractFrame(`${m.start}\r\nhi\r\n${m.end}42\r\n`, m)
  assert.equal(positive.exitCode, 42)
})

test('SH8d readiness 只认启动信标，不猜提示符', () => {
  const beacon = startupPreamble('bash')
  assert.ok(beacon.includes(READY_BEACON), '启动序列必须打印信标')
  assert.ok(beacon.startsWith('stty -echo'), 'bash 启动序列要先关回显')
  assert.ok(startupPreamble('pwsh').includes(READY_BEACON))
  assert.equal(detectReadiness('PS C:\\Users\\x> '), false, '不得把 PowerShell 提示符当就绪证据')
  assert.equal(detectReadiness('$ '), false, '不得把 bash 提示符当就绪证据')
  assert.equal(detectReadiness(`noise\r\n${READY_BEACON}\r\n`), true)
  assert.equal(detectReadiness(''), false)
})

test('resolveShellArgv shellPath 缺失或为空 → 抛可操作错误', () => {
  for (const config of [{}, { shellPath: '' }, { shellPath: '   ' }, { shellPath: 42 }]) {
    assert.throws(() => resolveShellArgv(config), /shellPath is required/)
  }
})

test('resolveShellArgv 默认 argv 与返回形状', () => {
  const resolved = resolveShellArgv({ shellPath: BASH })
  assert.deepEqual(resolved, {
    path: BASH,
    dialect: 'bash',
    args: ['--noprofile', '--norc', '-i'],
  })
})

test('resolveShellArgv 透传自定义 shellArgs 且不改写调用方数组', () => {
  const shellArgs = ['--noprofile', '--rcfile', 'C:/rc.sh']
  const config = { shellPath: BASH, shellArgs }
  const resolved = resolveShellArgv(config)
  assert.deepEqual(resolved.args, shellArgs)
  assert.notEqual(resolved.args, shellArgs)
  assert.deepEqual(shellArgs, ['--noprofile', '--rcfile', 'C:/rc.sh'])
})

test('resolveShellArgv 拒绝非字符串数组的 shellArgs', () => {
  assert.throws(() => resolveShellArgv({ shellPath: BASH, shellArgs: '-i' }), /array of strings/)
  assert.throws(() => resolveShellArgv({ shellPath: BASH, shellArgs: ['-i', 7] }), /array of strings/)
})

// ─────────────────────────────────────────────────────────────────────────────
// wrapCommand：framing 形状与 nonce
// ─────────────────────────────────────────────────────────────────────────────

test('SH1/SH2 wrapCommand 生成单物理行的完整 wrapper，退出码取自 $?', () => {
  const frame = wrapCommand('echo hi')
  assert.equal(frame.text, `printf '%s\\n' "${frame.start}"; echo hi; printf '%s%s\\n' "${frame.end}" "$?"`)
  assert.ok(!/[\r\n]/.test(frame.text), 'text 必须不含换行')
  assert.ok(frame.text.includes(frame.start))
  assert.ok(frame.text.includes(frame.end))
  assert.ok(frame.text.endsWith('"$?"'), '结束帧必须携带 $?')
})

test('SH1/SH2 marker 形状与 nonce 每次不同', () => {
  const seen = new Set()
  for (let i = 0; i < 64; i += 1) {
    const frame = wrapCommand('true')
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    assert.match(frame.start, new RegExp(`^${MARKER_PREFIX}${uuid}_S__$`))
    assert.match(frame.end, new RegExp(`^${MARKER_PREFIX}${uuid}_E__$`))
    assert.ok(!seen.has(frame.start), 'nonce 不得重复')
    seen.add(frame.start)
  }
})

test('SH1/SH2 命令正文原样嵌入，不做转义', () => {
  const command = `echo "$HOME" && printf '%s' 'a b' | tr a-z A-Z; exit $?`
  const frame = wrapCommand(command)
  assert.ok(frame.text.includes(command), '正文必须逐字出现，否则语义被改写')
})

test('wrapCommand 剥离尾部换行（命令行终止符），正文里的换行则拒绝', () => {
  const frame = wrapCommand('echo hi\r\n')
  assert.equal(frame.text, `printf '%s\\n' "${frame.start}"; echo hi; printf '%s%s\\n' "${frame.end}" "$?"`)
  assert.equal(wrapCommand('echo hi\n').text.includes('\n'), false)

  assert.throws(() => wrapCommand('echo a\necho b'), /one physical line/)
  assert.throws(() => wrapCommand('echo a\recho b'), /one physical line/)
  assert.throws(() => wrapCommand(''), /must not be empty/)
  assert.throws(() => wrapCommand('  \n'), /must not be empty/)
  assert.throws(() => wrapCommand(undefined), /must be a string/)
})

// ─────────────────────────────────────────────────────────────────────────────
// extractFrame：取最后一次出现、未闭合、跨 chunk
// ─────────────────────────────────────────────────────────────────────────────

test('SH4 命令输出伪造 end+退出码 不能提前结束 framing', () => {
  const frame = wrapCommand('cat payload.txt')
  const firstName = `${frame.end}999`
  const buffer = [
    `$ ${frame.text}`, // PTY 回显整条 wrapper（含 start/end 字面量）
    `payload: ${firstName}`, // 伪造结束帧：naive 的"首次出现"解析会拿它当结果
    frame.start, // 真正的帧
    'real body',
    `${frame.end}0`,
    '',
  ].join('\r\n')

  // 先证明 fixture 里确实埋着这个陷阱：任何"首次出现 end 后跟数字"的解析都会拿到伪造的 999。
  assert.equal(new RegExp(`${frame.end}(\\d+)`).exec(buffer)?.[1], '999')

  const got = extractFrame(buffer, frame)
  assert.ok(got !== undefined)
  assert.equal(got.exitCode, 0)
  assert.equal(got.text, 'real body')
})

test('extractFrame 剥掉 wrapper 回显行与前后空白（PTY 回显场景）', () => {
  const frame = wrapCommand('ls')
  const buffer = [
    `user@host:/w$ ${frame.text}`,
    frame.start,
    'file-a',
    'file-b',
    '',
    frame.end + '0',
    '',
  ].join('\r\n')

  assert.deepEqual(extractFrame(buffer, frame), { text: 'file-a\r\nfile-b', exitCode: 0 })
})

test('extractFrame 未闭合 → undefined（只见 start / 只见 end / 无退出码 / 空）', () => {
  const frame = wrapCommand('true')
  assert.equal(extractFrame('', frame), undefined)
  assert.equal(extractFrame('banner only\r\n', frame), undefined)
  assert.equal(extractFrame(`${frame.start}\r\nout\r\n`, frame), undefined)
  assert.equal(extractFrame(`out\r\n${frame.end}`, frame), undefined)
  assert.equal(extractFrame(`out\r\n${frame.end}\r\n`, frame), undefined)
  assert.equal(extractFrame(`${frame.end}7\r\n`, frame), undefined)
  assert.equal(extractFrame('some text', undefined), undefined)
})

test('extractFrame 非零退出码与无尾随换行的正文', () => {
  const frame = wrapCommand('kill -INT $$')
  assert.deepEqual(extractFrame(`${frame.start}\r\ninterrupted\r\n${frame.end}130\r\n`, frame), {
    text: 'interrupted',
    exitCode: 130,
  })
  assert.deepEqual(extractFrame(`${frame.start}\r\nno trailing newline${frame.end}1`, frame), {
    text: 'no trailing newline',
    exitCode: 1,
  })
})

test('SH4 marker 跨 chunk：切在 marker 中间也不误判，累积后仍能提取', () => {
  const frame = wrapCommand('echo hi')
  const full = `$ ${frame.text}\r\n${frame.start}\r\necho hi\r\n${frame.end}3\r\n`
  const cutA = full.lastIndexOf(frame.start) + 5 // 切在真正的 start marker 内部
  const cutB = full.lastIndexOf(frame.end) + 3 // 切在真正的 end marker 内部
  const chunks = [full.slice(0, cutA), full.slice(cutA, cutB), full.slice(cutB)]

  let acc = ''
  assert.equal(extractFrame(acc, frame), undefined)
  acc += chunks[0]
  assert.equal(extractFrame(acc, frame), undefined)
  acc += chunks[1]
  assert.equal(extractFrame(acc, frame), undefined)
  acc += chunks[2]
  assert.deepEqual(extractFrame(acc, frame), { text: 'echo hi', exitCode: 3 })
})

test('extractFrame 按 nonce 匹配，同一缓冲里的两帧互不串台', () => {
  const first = wrapCommand('echo a')
  const second = wrapCommand('echo b')
  const buffer = `${first.start}\r\nA\r\n${first.end}0\r\n${second.start}\r\nB\r\n${second.end}7\r\n`
  assert.deepEqual(extractFrame(buffer, first), { text: 'A', exitCode: 0 })
  assert.deepEqual(extractFrame(buffer, second), { text: 'B', exitCode: 7 })
})

// ─────────────────────────────────────────────────────────────────────────────
// detectReadiness：只看提示符证据，静默不算就绪
// ─────────────────────────────────────────────────────────────────────────────

test('SH6 readiness 不因 banner/静默而误报', () => {
  assert.equal(detectReadiness(''), false)
  assert.equal(detectReadiness('\r\n'), false)
  assert.equal(detectReadiness('Welcome to Git Bash\r\n'), false)
  assert.equal(detectReadiness('banner: loading modules...\r\nstill loading'), false)
  assert.equal(detectReadiness('run `dsh --help` for options\r\n'), false)
  assert.equal(detectReadiness('motd #\r\n'), false, '行尾 # 后没有提示符空格，不算就绪')
  assert.equal(detectReadiness('\x07'), false, '裸 BEL 不是提示符证据')
  assert.equal(detectReadiness('banner\r\n\x1b]133;A\x07\r\nmore output\r\n'), false, '过期的 prompt-start 不算')
})

test('SH6 readiness 只认启动信标，绝不猜提示符', () => {
  // 真机教训：PowerShell 的 `PS C:\…>` 与 bash 的 `$ ` 都可能是**命令输出**里的文本，
  // 拿它们当就绪证据会误判。改为 shell 自己打印信标（命令无法预期）。
  for (const promptLike of [
    'bash-5.2$ ',
    'root@host:~# ',
    '\x1b[32muser@host MINGW64 /f/w\x1b[0m$ ',
    'user@host$ \x1b[?25h',
    '\x1b]133;A\x07',
    'PS C:\\Users\\x> ',
  ]) {
    assert.equal(detectReadiness(promptLike), false, `不得把 ${JSON.stringify(promptLike)} 当就绪证据`)
  }
  assert.equal(detectReadiness(`bash-5.2$ \r\n${READY_BEACON}\r\n`), true, '信标出现即就绪')
  assert.equal(detectReadiness(`\r\n${READY_BEACON}`), true, '信标不依赖前后换行')
})

// ─────────────────────────────────────────────────────────────────────────────
// 硬约束
// ─────────────────────────────────────────────────────────────────────────────

test('硬约束：shell-bash.mjs 只 import node:* 与相对路径', async () => {
  const source = await readFile(new URL('../lib/shell-bash.mjs', import.meta.url), 'utf8')
  const specifiers = [...source.matchAll(/^\s*import\s[^\n]*?from\s+'([^']+)'/gm)].map((match) => match[1])
  assert.ok(specifiers.length > 0, '至少要有一个 import 才说明扫描有效')
  for (const specifier of specifiers) {
    assert.match(specifier, /^(?:node:|\.{1,2}\/)/, `非法 import 目标：${specifier}`)
  }
})
