import test from 'node:test'
import assert from 'node:assert/strict'

import { loadBundledSkill, parseSkillManifest } from '../lib/bundled-skill.mjs'

const SAMPLE = [
  '---',
  'name: demo-skill',
  'description: >-',
  '  第一行',
  '  第二行',
  'whenToUse: >-',
  '  什么时候用',
  'metadata:',
  '  version: "1.0.0"',
  '---',
  '',
  '# 标题',
  '',
  '正文。',
].join('\n')

test('K1 解析 name / description / whenToUse（折叠块标量合并为一行）', () => {
  const manifest = parseSkillManifest(SAMPLE)
  assert.equal(manifest.name, 'demo-skill')
  assert.equal(manifest.description, '第一行 第二行')
  assert.equal(manifest.whenToUse, '什么时候用')
})

test('K2 content 不包含 frontmatter', () => {
  const manifest = parseSkillManifest(SAMPLE)
  assert.ok(!manifest.content.includes('---'))
  assert.ok(manifest.content.includes('# 标题'))
  assert.ok(manifest.content.includes('正文。'))
})

test('K3 字面块标量（|）保留换行', () => {
  const raw = '---\nname: x\ndescription: |\n  一行\n  二行\n---\n正文\n'
  assert.equal(parseSkillManifest(raw).description, '一行\n二行')
})

test('K4 缺 description 或缺 name 要抛错（不能注册一个没有描述的技能）', () => {
  assert.throws(() => parseSkillManifest('---\nname: x\n---\n正文'), /description/)
  assert.throws(() => parseSkillManifest('---\ndescription: y\n---\n正文'), /name/)
})

test('K5 没有 frontmatter 要抛错', () => {
  assert.throws(() => parseSkillManifest('# 只有正文'), /frontmatter/)
  assert.throws(() => parseSkillManifest(''), /empty/)
})

test('K6 随包技能可加载：name 与目录一致、正文非空、资源目录指向技能目录', () => {
  const skill = loadBundledSkill()
  assert.equal(skill.name, 'background-terminal')
  assert.ok(skill.description.length > 20)
  assert.ok(skill.content.includes('# 后台终端'))
  assert.equal(skill.resourceBase.kind, 'directory')
  assert.ok(skill.path.endsWith('SKILL.md'))
  assert.ok(skill.path.includes('skills'), '路径应指向随包的技能文件，而不是用户目录')
})
