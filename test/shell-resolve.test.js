import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  ENCODING_PREAMBLE,
  candidateShellPaths,
  dialectMatchesPath,
  resolveShellPath,
  shellExists,
  shellFlavorOf,
  shellNotFoundMessage,
  validateShellPath,
} from '../lib/shell-resolve.mjs'

/** 假文件系统：只认列出来的路径，目录列表可单独给。 */
function makeIo({ files = [], dirs = {} } = {}) {
  return {
    lstat(path) {
      if (files.includes(path)) return { isFile: () => true, isSymbolicLink: () => false }
      throw new Error('ENOENT')
    },
    list(path) {
      if (dirs[path] === undefined) throw new Error('ENOENT')
      return dirs[path]
    },
  }
}

const LOCAL = 'C:\\Users\\me\\AppData\\Local'
const PF = 'C:\\Program Files'
const ROOT = 'C:\\Windows'

test('R1 显式路径优先，且完全不做文件系统探测', () => {
  const io = makeIo({ files: [] })
  const resolved = resolveShellPath({ dialect: 'pwsh', platform: 'win32', env: {}, explicit: 'D:\\tools\\pwsh.exe' }, io)
  assert.equal(resolved.path, 'D:\\tools\\pwsh.exe')
  assert.equal(resolved.source, 'explicit')
  assert.deepEqual(resolved.tried, [], '显式路径不需要候选表')
})

test('R2 用户级 PowerShell 7 版本目录取最高的那个', () => {
  const rootDir = join(LOCAL, 'Programs', 'PowerShell')
  const pick = join(rootDir, '7.3', 'pwsh.exe')
  const best = join(rootDir, '7.10', 'pwsh.exe')
  const io = makeIo({
    dirs: { [rootDir]: ['7.3', '7.4', '7.10', 'not-a-version'] },
    files: [pick, best],
  })
  const resolved = resolveShellPath({ dialect: 'pwsh', platform: 'win32', env: { LOCALAPPDATA: LOCAL } }, io)
  assert.equal(resolved.path, best, '7.10 按数值比较应高于 7.3（不是字典序）')
  assert.equal(resolved.source, 'discovered')
})

test('R3 没有用户级安装时退到 %ProgramFiles%，再退到 PATH，最后才是 5.1', () => {
  const programFiles = join(PF, 'PowerShell', '7', 'pwsh.exe')
  const pathEntry = join('D:\\tools', 'pwsh.exe')
  const legacy = join(ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const env = { LOCALAPPDATA: LOCAL, ProgramFiles: PF, SystemRoot: ROOT, PATH: 'D:\\tools' }

  assert.equal(
    resolveShellPath({ dialect: 'pwsh', platform: 'win32', env }, makeIo({ files: [programFiles] })).path,
    programFiles,
  )
  assert.equal(
    resolveShellPath({ dialect: 'pwsh', platform: 'win32', env }, makeIo({ files: [legacy, pathEntry] })).path,
    pathEntry,
    'PATH 上的 pwsh 应优先于 5.1 兜底',
  )
  assert.equal(
    resolveShellPath({ dialect: 'pwsh', platform: 'win32', env }, makeIo({ files: [legacy] })).path,
    legacy,
    '前三种都没有时才落到 5.1',
  )
})

test('R4 一个候选都不存在时返回 none，并保留完整尝试清单', () => {
  const env = { LOCALAPPDATA: LOCAL, ProgramFiles: PF, SystemRoot: ROOT, PATH: 'D:\\empty' }
  const resolved = resolveShellPath({ dialect: 'pwsh', platform: 'win32', env }, makeIo({ files: [] }))
  assert.equal(resolved.path, undefined)
  assert.equal(resolved.source, 'none')
  assert.ok(resolved.tried.length >= 3)
  const message = shellNotFoundMessage({ dialect: 'pwsh', platform: 'win32', tried: resolved.tried })
  assert.match(message, /SHELL_NOT_FOUND/)
  for (const candidate of resolved.tried) {
    assert.ok(message.includes(candidate), `错误正文应列出试过的路径：${candidate}`)
  }
  assert.match(message, /shellPath/, '错误正文要给出显式配置这条修法')
})

test('R5 POSIX 的 bash 候选以 /bin/bash 打头（macOS 系统自带）', () => {
  const candidates = candidateShellPaths({ dialect: 'bash', platform: 'darwin', env: { PATH: '/usr/local/bin' } }, makeIo())
  assert.equal(candidates[0], '/bin/bash')
  assert.ok(candidates.includes('/usr/local/bin/bash'))
  assert.equal(
    resolveShellPath({ dialect: 'bash', platform: 'darwin', env: {} }, makeIo({ files: ['/bin/bash'] })).path,
    '/bin/bash',
  )
})

test('R6 shellExists 只认普通文件与符号链接（Store 别名是重解析点）', () => {
  const link = makeIo({ files: ['C:\\alias\\pwsh.exe'] })
  assert.equal(shellExists('C:\\alias\\pwsh.exe', link), true)
  const directory = {
    lstat: () => ({ isFile: () => false, isSymbolicLink: () => false }),
    list: () => [],
  }
  assert.equal(shellExists('C:\\dir', directory), false, '目录不是可 spawn 的候选')
  assert.equal(shellExists('C:\\missing', makeIo()), false)
})

test('R7 方言与路径必须匹配，且路径必须存在、必须是绝对路径', () => {
  const io = makeIo({ files: ['C:\\tools\\pwsh.exe', '/bin/bash'] })
  assert.equal(dialectMatchesPath('C:\\tools\\pwsh.exe', 'pwsh'), true)
  assert.equal(dialectMatchesPath('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'pwsh'), true)
  assert.equal(dialectMatchesPath('C:\\tools\\pwsh.exe', 'bash'), false)
  assert.equal(dialectMatchesPath('/bin/bash', 'bash'), true)

  assert.match(String(validateShellPath({ shellPath: 'pwsh.exe', dialect: 'pwsh', io })), /absolute path/)
  assert.match(String(validateShellPath({ shellPath: 'C:\\tools\\pwsh.exe', dialect: 'bash', io })), /shellDialect/)
  assert.match(String(validateShellPath({ shellPath: 'C:\\nope\\pwsh.exe', dialect: 'pwsh', io })), /does not exist/)
  assert.equal(validateShellPath({ shellPath: 'C:\\tools\\pwsh.exe', dialect: 'pwsh', io }), null)
})

test('R8 shellFlavor 如实区分 pwsh 7 与 Windows PowerShell 5.1', () => {
  assert.equal(shellFlavorOf('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'pwsh'), 'pwsh-7')
  assert.equal(shellFlavorOf('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'pwsh'), 'windows-powershell-5.1')
  assert.equal(shellFlavorOf('/bin/bash', 'bash'), 'bash')
  assert.ok(ENCODING_PREAMBLE.includes('[Console]::OutputEncoding'), '5.1 兜底时靠这段把输出钉成 UTF-8')
})
