/**
 * 配置层测试：能力矩阵与配置校验。
 *
 * 依审阅 R001-04：受限 Windows 下必须**在启动前**拒绝 Git Bash 并给出可操作原因，
 * 而不是让调用方对着 `exit code 127` 猜。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assertShellSupported, resolveConfig, resolveCwd, shellCapability } from '../lib/config.mjs'

const PWsh = 'C:\\pwsh.exe'
const BASH = 'F:\\Program Files\\Git\\bin\\bash.exe'

test('CFG1 能力矩阵：Windows + 受限模式 + bash → 不支持，且给出替代方案', () => {
  for (const policyMode of ['read-only', 'workspace-write']) {
    const verdict = shellCapability({ platform: 'win32', policyMode, dialect: 'bash' })
    assert.equal(verdict.supported, false, `${policyMode} 下 bash 必须被拒`)
    assert.equal(verdict.code, 'SHELL_UNSUPPORTED_IN_CONFINED_WINDOWS')
    // 原因要具体：调用方应能据此知道"不是我的命令有问题"
    assert.match(verdict.detail, /signal pipe/)
    assert.match(verdict.detail, /restricted token/)
    // 必须给可操作出路，否则错误信息等于没说
    assert.ok(verdict.alternatives.some((line) => /pwsh/.test(line)), '必须建议 pwsh')
    assert.ok(verdict.alternatives.some((line) => /danger-full-access/.test(line)), '必须点明不受限路径')
  }
})

test('CFG2 能力矩阵：danger-full-access 下 bash 可用（不经 ACL runner）', () => {
  const verdict = shellCapability({ platform: 'win32', policyMode: 'danger-full-access', dialect: 'bash' })
  assert.equal(verdict.supported, true)
})

test('CFG3 能力矩阵：POSIX 平台 + bash 可用；POSIX + pwsh 被拒', () => {
  assert.equal(shellCapability({ platform: 'linux', policyMode: 'workspace-write', dialect: 'bash' }).supported, true)
  assert.equal(shellCapability({ platform: 'darwin', policyMode: 'workspace-write', dialect: 'bash' }).supported, true)
  const pwshOnPosix = shellCapability({ platform: 'linux', policyMode: 'workspace-write', dialect: 'pwsh' })
  assert.equal(pwshOnPosix.supported, false)
  assert.equal(pwshOnPosix.code, 'SHELL_UNSUPPORTED_ON_PLATFORM')
})

test('CFG4 能力矩阵：Windows + 受限模式 + pwsh 可用（本机唯一可行组合）', () => {
  assert.equal(shellCapability({ platform: 'win32', policyMode: 'workspace-write', dialect: 'pwsh' }).supported, true)
})

test('CFG5 assertShellSupported：不支持时抛错并**带上替代方案**', () => {
  assert.throws(
    () => assertShellSupported({ platform: 'win32', policyMode: 'workspace-write', dialect: 'bash' }),
    (error) => {
      assert.match(error.message, /SHELL_UNSUPPORTED_IN_CONFINED_WINDOWS/)
      assert.match(error.message, /pwsh/, '错误里必须有可操作建议')
      assert.match(error.message, /danger-full-access/)
      return true
    },
  )
  assert.doesNotThrow(() =>
    assertShellSupported({ platform: 'win32', policyMode: 'workspace-write', dialect: 'pwsh' }),
  )
})

test('CFG6 无自动降级：不支持时只抛错，不返回替代 dialect', () => {
  // 审阅明确禁止插件自行降级到别的执行路径（那会把沙箱故障变成提权路径）。
  let thrown
  try {
    assertShellSupported({ platform: 'win32', policyMode: 'workspace-write', dialect: 'bash' })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, '必须抛错')
  // 返回值里不得出现"已替你改用 xxx"这类暗示
  assert.ok(!/falling back|switched to|using .* instead/i.test(thrown.message))
  const verdict = shellCapability({ platform: 'win32', policyMode: 'workspace-write', dialect: 'bash' })
  assert.equal(verdict.dialect, undefined, '判定结果不得携带替代 dialect 字段')
})

test('CFG7 resolveConfig：合法配置解析成功，非法项在挂载期抛错', () => {
  const ok = resolveConfig({ shellPath: PWsh, shellDialect: 'pwsh' })
  assert.equal(ok.shellDialect, 'pwsh')
  assert.deepEqual(ok.shellArgs, ['-NoLogo', '-NoProfile'])
  assert.equal(ok.logLevel, 'info', 'logLevel 默认应为 info')

  assert.throws(() => resolveConfig({}), /shellPath is required/)
  assert.throws(() => resolveConfig({ shellPath: PWsh, shellDialect: 'zsh' }), /is not supported/)
  assert.throws(() => resolveConfig({ shellPath: PWsh, logLevel: 'verbose' }), /logLevel must be one of/)
  assert.throws(
    () => resolveConfig({ shellPath: PWsh, shellArgs: ['-NoLogo', '-Command', 'x'] }),
    /one-shot execution argument/,
  )
})

test('CFG8 logLevel 拼错即挂载失败，不静默退回默认', () => {
  // 静默退回会让"我开了 debug 怎么没日志"变成极难查的问题
  assert.throws(() => resolveConfig({ shellPath: PWsh, logLevel: 'DEBUG' }), /logLevel must be one of/)
  assert.doesNotThrow(() => resolveConfig({ shellPath: PWsh, logLevel: 'debug' }))
  assert.doesNotThrow(() => resolveConfig({ shellPath: PWsh, logLevel: 'silent' }))
})

test('CFG9 resolveCwd：受限模式下工作区外的 cwd 被拒绝，而非静默夹取', () => {
  const policy = { mode: 'workspace-write', workspaceRoot: 'F:/ws' }
  assert.equal(resolveCwd(undefined, policy, 'F:/ws/sub'), 'F:/ws/sub')
  assert.equal(resolveCwd('F:/ws/sub', policy, undefined), 'F:/ws/sub')
  assert.throws(() => resolveCwd('C:/outside', policy, undefined), /outside the sandbox workspace/)
  // full-access 不受 workspace 限制
  assert.equal(resolveCwd('C:/outside', { mode: 'danger-full-access' }, undefined), 'C:/outside')
})

test('CFG10 两个方言的默认 shellArgs 不同（两套 framing 的前提）', () => {
  const bash = resolveConfig({ shellPath: BASH, shellDialect: 'bash' })
  assert.deepEqual(bash.shellArgs, ['--noprofile', '--norc', '-i'])
  const pwsh = resolveConfig({ shellPath: PWsh, shellDialect: 'pwsh' })
  assert.deepEqual(pwsh.shellArgs, ['-NoLogo', '-NoProfile'])
})

test('CFG11 ELECTRON_RUN_AS_NODE：默认不继承给持久 shell，可显式打开', () => {
  // DSH 宿主可能跑在 Electron-as-Node 模式，那个变量会被所有子进程继承——
  // shell 里启动的任何 Electron 程序都会静默退化成纯 Node（不报错、不开窗）。
  const base = resolveConfig({ shellPath: PWsh, shellDialect: 'pwsh' })
  assert.equal(base.passElectronRunAsNode, false, '默认必须剥掉')
  assert.equal(
    resolveConfig({ shellPath: PWsh, shellDialect: 'pwsh', passElectronRunAsNode: true }).passElectronRunAsNode,
    true,
    '需要该模式时必须能显式打开',
  )
  assert.throws(
    () => resolveConfig({ shellPath: PWsh, shellDialect: 'pwsh', passElectronRunAsNode: 'false' }),
    /must be a boolean/,
    '拼错的字符串不能被读成真',
  )
})

