/**
 * 危险命令前置提醒/拦截的测试（`lib/danger.mjs`）。
 *
 * 这层的定位是**减速带，不是安全边界**（见该模块文件头与
 * `docs/sandbox-design/DSH_CODEX_SANDBOX_AND_APPROVAL.md` :118 / :134）。
 * 因此测试分三组：
 *   1. **必须拦**：目标就是整盘/家目录/根的递归删除等几乎无正当用途的形态；
 *   2. **必须放**：真实开发里天天用的清理命令——拦了它们会毁掉可用性；
 *   3. **集成**：`terminal_exec` 在**预留之前**拒绝，且不留任何痕迹；
 *      `terminal_write` 不受限（交互输入通道）。
 *
 * 冷测试：不创建真实进程、不碰文件系统、不联网。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DANGER_RULES, dangerousCommandError, detectDangerous } from '../lib/danger.mjs'

/** 必须被拦下的形态。 */
const MUST_BLOCK = [
  ['rm -rf /', 'recursive-wipe-root'],
  ['rm -rf /*', 'recursive-wipe-root'],
  ['rm -rf ~', 'recursive-wipe-root'],
  ['rm -rf $HOME', 'recursive-wipe-root'],
  ['rm -fr ${HOME}', 'recursive-wipe-root'],
  ['sudo rm -r -f /', 'recursive-wipe-root'],
  ['rm -rf /c', 'recursive-wipe-root'],
  ['Remove-Item -Recurse -Force C:\\', 'pwsh-recursive-wipe-root'],
  ['Remove-Item -Path ~ -Recurse -Force', 'pwsh-recursive-wipe-root'],
  ['ri -r -fo $HOME', 'pwsh-recursive-wipe-root'],
  ['del -Recurse -Force C:\\', 'pwsh-recursive-wipe-root'],
  ['format C:', 'format-volume'],
  ['format.com D:', 'format-volume'],
  ['diskpart /s wipe.txt\nselect disk 0\nclean', 'diskpart-clean'],
]

/** 真实开发里天天用的命令——**一条都不许拦**。 */
const MUST_PASS = [
  'rm -rf node_modules',
  'rm -rf dist && npm run build',
  'rm -rf .next out coverage',
  'rm file.txt',
  'rm -f /tmp/build.log',
  'Remove-Item -Recurse -Force .\\dist',
  'Remove-Item -Recurse -Force .\\node_modules',
  'ri -r -fo .\\out',
  'npm run build',
  'npm ci',
  'git clean -fdx',
  'format --check src/app.js',
  'npx prettier --write .',
  'node -e "console.log(1)"',
  'mkdir -p dist && cp -r src/* dist/',
]

test('DG1 必须拦下的形态全部命中（含方言与旗标变体）', () => {
  for (const [command, expectedId] of MUST_BLOCK) {
    const hit = detectDangerous(command)
    assert.notEqual(hit, undefined, `必须拦下：${command}`)
    assert.equal(hit.id, expectedId, `${command} 应命中 ${expectedId}`)
    assert.ok(hit.reason.length > 0, '必须给出命中原因')
    assert.ok(hit.excerpt.length > 0, '必须回显命中片段，便于调用方定位')
  }
})

test('DG2 常见清理命令一条都不许拦（误伤会毁掉可用性）', () => {
  for (const command of MUST_PASS) {
    const hit = detectDangerous(command)
    assert.equal(hit, undefined, `不得拦下正当命令：${command}（命中 ${hit?.id}）`)
  }
})

test('DG3 错误信息必须写清"这是减速带、不是安全边界"，并给出覆盖方式', () => {
  // 用一条**较长**的命令，才能验证"不回显整条命令"
  const command = 'cd /tmp && echo preparing && sudo rm -rf /'
  const hit = detectDangerous(command)
  assert.notEqual(hit, undefined, '前置条件：这条命令行必须命中')
  const error = dangerousCommandError(command, hit)

  assert.equal(error.code, 'DANGEROUS_COMMAND_REFUSED', '必须有稳定错误码')
  assert.equal(error.dangerId, hit.id)
  assert.match(error.message, /NOT a security boundary/, '不得声称这是安全边界')
  assert.match(error.message, /allowDangerous: true/, '必须告诉调用方怎么覆盖')
  assert.match(error.message, new RegExp(hit.id), '必须给出命中的规则 id')
  assert.ok(!error.message.includes(command), '不得回显整条命令（可能很长），只回显命中片段')
  assert.ok(error.message.includes(hit.excerpt), '必须回显命中片段，便于调用方定位')
})

test('DG4 空输入与非字符串不抛、不误判', () => {
  for (const value of ['', undefined, null, 42, {}, []]) {
    assert.doesNotThrow(() => detectDangerous(value))
    assert.equal(detectDangerous(value), undefined)
  }
})

test('DG5 规则表结构完整（三段式：命令名 + 可选旗标 + 目标）', () => {
  const ids = DANGER_RULES.map((r) => r.id)
  assert.equal(new Set(ids).size, ids.length, 'rule id 必须唯一（错误信息靠它定位）')
  for (const rule of DANGER_RULES) {
    assert.equal(typeof rule.id, 'string')
    assert.ok(rule.command instanceof RegExp, `${rule.id}: command 必须是正则`)
    assert.ok(rule.target instanceof RegExp, `${rule.id}: target 必须是正则`)
    if (rule.flag !== undefined) assert.ok(rule.flag instanceof RegExp, `${rule.id}: flag 必须是正则`)
    assert.ok(rule.reason.length > 10, `${rule.id}: reason 必须是给人看的说明`)
  }
  // 每条规则都必须**同时**要求命令名与目标：只有命令名会误伤（笼统拦 rm），
  // 只有目标会拦下无害文本。
  assert.ok(DANGER_RULES.every((r) => r.command instanceof RegExp && r.target instanceof RegExp))
})
