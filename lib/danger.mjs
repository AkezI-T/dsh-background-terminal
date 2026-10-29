/**
 * 危险命令的**前置提醒与拦截**。
 *
 * ## 它是什么，不是什么
 *
 * **它不是安全边界。** 按 `docs/sandbox-design/DSH_CODEX_SANDBOX_AND_APPROVAL.md:134`
 * 的定调：分段输入、粘贴多行、别名与函数、变量展开、脚本文件、解释器代码都能绕过
 * 简单匹配——因此这里只做"**减速带**"：拦住**手滑**与**几乎无正当用途**的形态，
 * 让调用方在被拦时能明确知道自己要做什么，而不是靠正则去防住一个有意绕过的对手。
 *
 * 同文档 `:118` 要求"使用宿主共用的命令策略，**不在插件复制一套正则黑名单**"。
 * 经查宿主**没有**可供本插件复用的命令级策略：宿主的 `approval` 服务
 * （`dsh-user-approval`，`approval.request()`）服务的是**工具调用级的提权审批**
 * （`sandbox_permissions` / `justification`），而本插件的持久 shell **不走 ACL 沙箱**
 * （`enforcement: windows-pty-unconfined`），压根没有"被沙箱拒绝"这个状态可供审批。
 * 所以这一层只能由插件自己做，而且必须**说得比做得多**：命中的原因要写清楚，
 * 不能让人以为"没被拦 = 安全"。
 *
 * ## 为什么把清单收得这么窄
 *
 * 笼统拦 `rm` 会立刻毁掉可用性，而这些**都是正当的**：
 *
 * ```
 * rm -rf node_modules      # 重装依赖
 * rm -rf dist && npm run build
 * Remove-Item -Recurse -Force .\dist
 * ```
 *
 * 所以只保留"目标就是**整盘 / 家目录 / 根目录**"这类几乎没有正当用途的形态。
 * 代价是覆盖面小——这是**有意的**：宁可少拦，也不要让调用方学会无视这个警告。
 *
 * 硬约束：只用 `node:*` 与相对 import；不 import 任何 `@deepseek-ai/*`。
 */

/**
 * 单条规则。
 * @typedef {object} DangerRule
 * @property {string} id 稳定标识（出现在错误信息里，便于测试与检索）
 * @property {RegExp} pattern 触发模式
 * @property {string} reason 为什么危险（写给调用方看的人话）
 */

/** bash 删除命令名（`rm` 后面必须是空白，避免匹配到 `Remove-Item` 的开头）。 */
const BASH_DELETE_COMMAND = 'rm\\s+'

/** pwsh 删除命令名。用捕获组界定词首，避免 `rm` 之类的子串误入。 */
const PWSH_DELETE_COMMAND = '(^|[\\s|;&])(?:Remove-Item|ri|rd|rmdir|del)(?![\\w-])'

/** 命令可能出现在行首、管道/分号之后，或 `sudo` 之后。 */
const CMD_HEAD = '(?:^|[|;&]\\s*|\\bsudo\\s+)'

/** pwsh 的递归/强制旗标（`-Recurse` / `-Force` / 简写 `-r` / `-fo` / 合并写法 `-rfo`）。 */
const PWSH_RECURSIVE_FLAG = /(?:^|\s)-(?:[a-zA-Z]*(?:recurse|force|r|fo|rf|fr))(?=\s|$)/i

/**
 * 规则表。
 *
 * 每条规则 = **命令名正则** + **可选的危险旗标正则** + **危险目标正则**，三者都要命中。
 * 拆成三段而不是塞进一个复杂正则，是因为实测那样极易写出"看似命中、实则被零宽断言
 * 或贪婪匹配绕开"的模式（本文件的正则踩过两次：`\brm\b` 命中 `Remove-Item`、
 * 前瞻断言吃掉命令名导致简写旗标漏判）。
 *
 * @typedef {object} DangerRule
 * @property {string} id
 * @property {RegExp} command 命令名（须对应删除/格式化类动作）
 * @property {RegExp} [flag] 危险旗标（递归/强制）；缺省表示不需要
 * @property {RegExp} target 危险目标（整盘 / 家目录 / 根）
 * @property {string} reason
 */
export const DANGER_RULES = Object.freeze([
  {
    id: 'recursive-wipe-root',
    // rm -rf / ／ rm -rf /* ／ rm -fr ~ ／ rm -r -f $HOME ／ sudo rm -rf /c
    command: new RegExp(`${CMD_HEAD}${BASH_DELETE_COMMAND}`, 'i'),
    flag: /(?:^|\s)-[a-zA-Z]*r/i,
    target: /(?:^|\s)(?:\/|\/\*|~\/?\*?|\$HOME|\$\{HOME\}|\/c|\/mnt\/[a-z]|\/cygdrive\/[a-z])(?![\\\w.-])/i,
    reason: 'recursive delete whose target is the filesystem root, a whole drive, or the home directory',
  },
  {
    id: 'pwsh-recursive-wipe-root',
    // Remove-Item -Path ~ -Recurse -Force ／ ri -r -fo $HOME ／ del -Recurse C:\
    command: new RegExp(PWSH_DELETE_COMMAND, 'i'),
    flag: PWSH_RECURSIVE_FLAG,
    target: /(?:^|\s)(?:[a-zA-Z]:\\?|~|\$HOME|\$env:USERPROFILE)(?![\\\w.-])/i,
    reason: 'recursive delete whose target is a whole drive or the home directory',
  },
  {
    id: 'format-volume',
    command: /\bformat(?:\.com)?\s+/i,
    target: /[a-zA-Z]:/,
    reason: 'formats a volume (destroys the whole filesystem on it)',
  },
  {
    id: 'diskpart-clean',
    // diskpart 脚本化：`select disk 0` + `clean`
    command: /\bdiskpart\b/i,
    target: /\bclean\b/i,
    reason: 'diskpart clean wipes a disk partition table',
  },
])

/**
 * 检查一条命令。
 *
 * @param {string} command 原始命令行（调用方尚未包帧）
 * @returns {{id:string, reason:string, excerpt:string}|undefined} 命中则返回证据，否则 undefined
 */
export function detectDangerous(command) {
  if (typeof command !== 'string' || command.length === 0) return undefined
  for (const rule of DANGER_RULES) {
    const at = rule.command.exec(command)
    if (at === null) continue
    // 危险旗标与危险目标都从**命令名之后**找：`rm` 的参数在命令名右边，
    // 从整条命令找会让前面的无关内容误触发。
    const rest = command.slice(at.index + at[0].length)
    if (rule.flag !== undefined && !rule.flag.test(rest)) continue
    const hitTarget = rule.target.exec(rest)
    if (hitTarget === null) continue
    return {
      id: rule.id,
      reason: rule.reason,
      // 只回显命中片段，不回显整条命令：命令可能很长，而证据只需指明"拦的是哪一段"
      excerpt: `${at[0].trim()} … ${hitTarget[0].trim()}`.trim().slice(0, 120),
    }
  }
  return undefined
}

/**
 * 组装拒绝错误。措辞刻意**不声称**这是安全边界——见文件头。
 *
 * @param {string} command
 * @param {{id:string, reason:string, excerpt:string}} hit
 * @returns {Error}
 */
export function dangerousCommandError(command, hit) {
  // 只放"命中的那一段"（可能仍等于整条命令，当命令本身很短时），并截断到 120 字符；
  // 不回显完整命令是因为它可能很长（含脚本、多行），错误信息不该被它淹没。
  const error = new Error(
    `background-terminal: refused to run this command because it matched the "${hit.id}" guard `
      + `(${hit.reason}). Matched text: ${JSON.stringify(hit.excerpt)}. `
      + 'This guard is a speed bump against slips, NOT a security boundary: it matches text only, so aliases, '
      + 'variables and scripts bypass it. It is also deliberately narrow, so a command that passes it is not '
      + 'thereby safe. To run this anyway, re-issue the same call with allowDangerous: true.',
  )
  error.code = 'DANGEROUS_COMMAND_REFUSED'
  error.dangerId = hit.id
  error.excerpt = hit.excerpt
  return error
}
