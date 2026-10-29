/**
 * Shell 层：argv 校验、readiness 信标、命令 framing 与帧提取。
 *
 * 支持两个方言，**它们的 wrapper 语法完全不同**（FINAL.md §7.6 / R7-01）：
 *  - bash：`printf '%s\n' …; body; printf '%s%s\n' … "$?"`，退出码取自 `$?`（数字）
 *  - pwsh：`[Console]::WriteLine(…)`，退出码取自 `$LASTEXITCODE`（原生命令），
 *          cmdlet 没有数字退出码，退回 `$?` 的布尔
 *
 * 硬约束：只用 `node:*` 与相对 import；不 import 任何 `@deepseek-ai/*`。
 */

import { randomUUID } from 'node:crypto'

import { MARKER_PREFIX } from './contract.mjs'
import { ENCODING_PREAMBLE } from './shell-resolve.mjs'

/** 各方言的持久交互 shell 启动参数。 */
const SHELL_ARGS = Object.freeze({
  bash: Object.freeze(['--noprofile', '--norc', '-i']),
  pwsh: Object.freeze(['-NoLogo', '-NoProfile']),
})

const DIALECTS = Object.freeze(['bash', 'pwsh'])

/**
 * 一次性执行参数：任一个出现在 shellArgs 里，持久交互 shell 就退化成一次性进程
 * （SH8）。`-c` 与 `-lc`/`-ic` 这类短选项簇同义；长选项按惯例大小写不敏感，
 * 且可能带 `=值` 或 `:值`。
 */
const ONE_SHOT_LONG = /^-{1,2}command(?:[=:].*)?$/i
const ONE_SHOT_SHORT = /^-[a-zA-Z]*c[a-zA-Z]*$/

function isOneShotArg(arg) {
  return ONE_SHOT_LONG.test(arg) || ONE_SHOT_SHORT.test(arg)
}

/**
 * 解析并校验 shell argv。非法配置在这里抛错，让插件**挂载期失败**，而不是等到第一次工具调用。
 *
 * @param {{shellPath?:string, shellDialect?:string, shellArgs?:string[]}} [config]
 * @returns {{path:string, dialect:'bash'|'pwsh', args:string[]}}
 */
export function resolveShellArgv(config = {}) {
  const shellPath = config.shellPath
  if (typeof shellPath !== 'string' || shellPath.trim().length === 0) {
    throw new Error('background-terminal: shellPath is required (absolute path to the shell executable)')
  }

  const dialect = config.shellDialect ?? 'bash'
  if (!DIALECTS.includes(dialect)) {
    throw new Error(
      `background-terminal: shellDialect "${dialect}" is not supported; use one of ${DIALECTS.join(', ')}`,
    )
  }

  const args = config.shellArgs ?? SHELL_ARGS[dialect]
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('background-terminal: shellArgs must be an array of strings')
  }
  for (const arg of args) {
    if (isOneShotArg(arg)) {
      throw new Error(
        `background-terminal: shellArgs must not contain the one-shot execution argument "${arg}"; ` +
          'it would turn the persistent interactive shell into a one-shot process',
      )
    }
  }

  return { path: shellPath, dialect, args: [...args] }
}

/** 启动信标：shell 起来后自己打印这一行，作为"可以收命令了"的正面证据。 */
export const READY_BEACON = `${MARKER_PREFIX}READY__`

/**
 * 就绪前必须做的一次性抑制，按方言不同：
 *  - bash：`stty -echo` 关掉回显（否则每次写入都会被回显一份）
 *  - pwsh：PowerShell 在执行前会回显整条命令行，无法关闭；改为把每个命令的
 *    回显行重定向掉（见 wrapCommand），所以这里只留空
 * 两者都以打印 READY_BEACON 收尾。
 *
 * @param {'bash'|'pwsh'} dialect
 * @returns {string} 单物理行的 shell 代码
 */
export function startupPreamble(dialect) {
  if (dialect === 'bash') {
    return `stty -echo 2>/dev/null; printf '%s\\n' "${READY_BEACON}"`
  }
  // 先钉 UTF-8 输出：Windows PowerShell 5.1 默认写控制台/OEM 代码页，而 pump 按 UTF-8
  // 解码；不钉会把中文变成替换字符。与 DSH 宿主的 ENCODING_PREAMBLE 同一做法。
  return `${ENCODING_PREAMBLE}[Console]::WriteLine("${READY_BEACON}")`
}

/**
 * 就绪判定：只要看见启动信标即为就绪。
 *
 * 刻意**不**去猜提示符：PowerShell 的 `PS C:\…>` 与命令输出里的文本无法可靠区分，
 * 而信标是自己打印的、命令无法预期。信标缺失时由调用方的初始化上限兜底（§7.2）。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function detectReadiness(text) {
  return typeof text === 'string' && text.includes(READY_BEACON)
}

/**
 * 帧尾的退出码。
 *
 * bash wrapper 里是数字；pwsh 里 cmdlet 没有数字退出码，用 `cmdlet:ok|fail` 兜底。
 *
 * **必须接受负号**：Windows 上被 Ctrl+C（或其它控制台事件）终止的进程，
 * `$LASTEXITCODE` 是一个**负**值（`-1073741510` = `0xC000013A` = `STATUS_CONTROL_C_EXIT`）。
 * 只认 `\d+` 会让这类帧永远闭不上——`extractFrame` 返回 undefined、命令级退出码永远
 * 拿不到、`commandRunning` 卡在 true。这是正常路径，不是边角情况。
 */
const EXIT_CODE = /^(?:(-?\d+)|(?:cmdlet:)?(ok|fail))/i

function normalizeExitCode(match) {
  if (match[1] !== undefined) return Number(match[1])
  return match[2] !== undefined && match[2].toLowerCase() === 'ok' ? 0 : 1
}

/**
 * 把一条命令包成可写入 PTY 的单个物理行（§7.3）。
 *
 * 每次调用生成新的随机 nonce：命令输出无法预知 nonce，因此无法伪造结束帧（SH4）。
 * 正文按调用方给的命令行**原样**嵌入——它本来就要交给 shell 解析，转义会改变语义。
 * 写入时由调用方追加唯一的换行字节（§7.5）。
 *
 * @param {string} command
 * @param {'bash'|'pwsh'} [dialect]
 * @returns {{text:string, start:string, end:string}}
 */
export function wrapCommand(command, dialect = 'bash') {
  if (typeof command !== 'string') {
    throw new Error(`background-terminal: command must be a string, got ${typeof command}`)
  }
  // 末尾换行只是命令行的终止符：留着它会让结尾的分隔符变成语法错误。
  const body = command.replace(/[\r\n]+$/, '')
  if (body.trim().length === 0) {
    throw new Error('background-terminal: command must not be empty')
  }
  if (/[\r\n]/.test(body)) {
    throw new Error(
      'background-terminal: command must fit on one physical line (no embedded newline); ' +
        'join statements with ";" or send the script through the terminal input path (FINAL.md §7.5)',
    )
  }
  if (!DIALECTS.includes(dialect)) {
    throw new Error(`background-terminal: unknown shell dialect ${JSON.stringify(dialect)}`)
  }

  const nonce = randomUUID()
  const start = `${MARKER_PREFIX}${nonce}_S__`
  const end = `${MARKER_PREFIX}${nonce}_E__`

  if (dialect === 'bash') {
    return { text: `printf '%s\\n' "${start}"; ${body}; printf '%s%s\\n' "${end}" "$?"`, start, end }
  }

  // pwsh：
  //  1. 开头 `2>$null;` 把 PowerShell 回显的**本行命令行**重定向掉——声明式赋值
  //     没有输出，所以这既抑制了回显，又保证宿主命令自身的失败不被 `$?` 记账。
  //  2. `$LASTEXITCODE` 只对原生命令有意义（cmdlet 不设置它），所以原生命令报数字、
  //     cmdlet 报 `cmdlet:ok|fail`；调用方据此得到可判断的退出码。
  return {
    text: `2>$null; [Console]::WriteLine("${start}"); ${body}; [Console]::WriteLine("${end}" + $(if ($LASTEXITCODE -ne $null) { "$LASTEXITCODE" } else { "cmdlet:" + $(if ($?) { "ok" } else { "fail" }) }))`,
    start,
    end,
  }
}

/** 帧正文：剥掉 marker 行自身留下的换行，以及尾部空白；正文内部不改动。 */
function stripFrameBody(body) {
  return body.replace(/^[\r\n]+/, '').replace(/[ \t\r\n]+$/, '')
}

/**
 * 从累积输出里提取一帧命令结果（§7.3）。取 start/end 的**最后一次**出现：
 * PTY 回显会先打印一份 wrapper，真正的帧在其后，所以命令输出里伪造的 end+退出码
 * 不可能提前结束 framing（SH4）。只见 start 或只见 end 都算未闭合 → undefined。
 * 调用方把累积文本反复传进来即可，跨 chunk 由"未闭合"表达，函数不要求 marker 一次到齐。
 *
 * @param {string} text
 * @param {{start:string, end:string}} marker
 * @returns {{text:string, exitCode:number}|undefined}
 */
export function extractFrame(text, marker) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  if (marker === null || typeof marker !== 'object') return undefined
  const { start, end } = marker
  if (typeof start !== 'string' || typeof end !== 'string' || start.length === 0 || end.length === 0) return undefined

  const endAt = text.lastIndexOf(end)
  if (endAt < 0) return undefined
  const code = EXIT_CODE.exec(text.slice(endAt + end.length))
  if (code === null) return undefined

  const startAt = text.lastIndexOf(start, endAt)
  if (startAt < 0) return undefined

  return { text: stripFrameBody(text.slice(startAt + start.length, endAt)), exitCode: normalizeExitCode(code) }
}
