/**
 * 插件自带技能的清单解析与加载。
 *
 * 技能正文随包发布在 `skills/background-terminal/SKILL.md`。挂载时把它注册成
 * DSH 的 **runtime skill**（`ctx.skills.register`），这样**装插件即得技能**：
 * 不需要复制到 `~/.dsh/skills`，也不依赖任何本机绝对路径。
 *
 * 注册优先级由宿主决定：同一层里 runtime 高于 user（`~/.dsh/skills`），
 * 所以用户目录里那份旧的同名副本会被这份覆盖，而不是打架。
 *
 * frontmatter 只按本文件实际用到的三个键解析（`name` / `description` / `whenToUse`），
 * 支持 `>-` 与 `|` 两种块标量；不引入 YAML 依赖。
 */

import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** 取顶端三个键；块标量按缩进去掉公共前缀。 */
function parseKeys(frontmatter) {
  const lines = frontmatter.split(/\r?\n/)
  const result = {}
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(name|description|whenToUse):\s*(.*)$/.exec(lines[index])
    if (match === null) continue
    const [, key, rawValue] = match
    if (rawValue === '>-' || rawValue === '>' || rawValue === '|' || rawValue === '|-') {
      const collected = []
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const line = lines[cursor]
        if (line.trim().length === 0) {
          collected.push('')
          continue
        }
        if (!/^\s+/.test(line)) break
        collected.push(line.trim())
        index = cursor
      }
      const folded = rawValue.startsWith('>')
      result[key] = collected.join(folded ? ' ' : '\n').trim()
    } else {
      result[key] = rawValue.trim().replace(/^["']|["']$/g, '')
    }
  }
  return result
}

/**
 * 解析一份技能文件。
 * @param {string} raw SKILL.md 全文
 * @returns {{name:string, description:string, whenToUse?:string, content:string}}
 */
export function parseSkillManifest(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('bundled-skill: empty skill document')
  const match = FRONTMATTER.exec(raw)
  if (match === null) throw new Error('bundled-skill: missing YAML frontmatter')
  const keys = parseKeys(match[1])
  if (typeof keys.name !== 'string' || keys.name.length === 0) throw new Error('bundled-skill: frontmatter is missing "name"')
  if (typeof keys.description !== 'string' || keys.description.length === 0) {
    throw new Error('bundled-skill: frontmatter is missing "description"')
  }
  return {
    name: keys.name,
    description: keys.description,
    ...(keys.whenToUse === undefined ? {} : { whenToUse: keys.whenToUse }),
    content: raw.slice(match[0].length),
  }
}

/** 读取随包发布的技能文件（相对本模块定位，不依赖进程 cwd）。 */
export function loadBundledSkill(url = new URL('../skills/background-terminal/SKILL.md', import.meta.url)) {
  const path = fileURLToPath(url)
  const parsed = parseSkillManifest(readFileSync(path, 'utf8'))
  return { ...parsed, path, resourceBase: { kind: 'directory', path: dirname(path) } }
}
