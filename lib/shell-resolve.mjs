/**
 * shell 发现：在**这台机器**上找到可用的 shell。
 *
 * ## 为什么是移植而不是 import
 *
 * 解析逻辑移植自 DSH 宿主内置的 `@deepseek-ai/dsh-pwsh-local`（0.2.1-rc.3）：
 * `candidatePwshPaths` / `candidateExists` / `resolvePwshPath`（lib/index.js:23-65）
 * 与 `ENCODING_PREAMBLE`（lib/index.js:100）。
 *
 * 不能直接引用那个包：
 *   - 插件被 link 到 profile 的 node_modules 下，ESM 按**导入方路径**解析，
 *     `@deepseek-ai/*` 在那里不存在（实测 ERR_MODULE_NOT_FOUND）；
 *   - 宿主的解析没有以 ctx 服务暴露（它只是 `ShellExecutor` 的一个提供者内部实现）；
 *   - npm 公开版本是 0.0.1-rc.1，宿主内置是 0.2.1-rc.3，加依赖等于引入会漂移的副本。
 *
 * 相比宿主那份，这里补了两处它没有的：
 *   1. **用户级 PowerShell 7**（`%LOCALAPPDATA%\\Programs\\PowerShell\\7*`）。宿主只找
 *      `%ProgramFiles%`；用户级安装若不在 PATH 上，宿主会一路掉到 5.1。
 *   2. **bash 候选**（macOS/Linux 的 /bin/bash、Git Bash），供 bash 方言使用。
 *
 * ## 纪律
 *
 * - **方言不由这里决定**：framing 是两套语法，猜错会得到「会话起来了、命令永不闭合」。
 *   调用方先定方言，这里只回答「这个方言的 shell 在哪」。
 * - **存在性用 lstat**：Store 版 pwsh 是 AppExecutionAlias 重解析点，`stat` 会在目标
 *   ACL 上 EACCES；`lstat` 看条目本身，CreateProcess 两种形态都能解析。
 * - **纯函数**：文件系统访问经 `io` 注入，冷测试不需要真实磁盘。
 */

import { lstatSync, readdirSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'

/**
 * UTF-8 输出钉定前缀。Windows PowerShell 5.1 默认写控制台/OEM 代码页，
 * 而本插件的 pump 按 UTF-8 解码——不钉就会把非 ASCII 输出解成替换字符。
 * pwsh 7 默认 UTF-8，加上它也无害。
 */
export const ENCODING_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
  + '$OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

/** 默认文件系统访问；测试注入假件即可不碰磁盘。 */
export const DEFAULT_IO = Object.freeze({
  lstat: (path) => lstatSync(path),
  list: (path) => readdirSync(path),
})

/**
 * 候选是否存在且可 spawn。
 *
 * 与宿主同口径：只认普通文件或符号链接；目标不可读的重解析点（Store 别名）
 * 正好落在这个分支里，而真实目录永远不匹配。
 */
export function shellExists(path, io = DEFAULT_IO) {
  try {
    const stat = io.lstat(path)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    return false
  }
}

function splitPath(value, platform) {
  const separator = platform === 'win32' ? ';' : ':'
  return String(value ?? '')
    .split(separator)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter((entry) => entry.length > 0)
}

/** 版本目录（7.4、7.3…）按数值降序，取最高的那个。 */
function versionedPwsh(root, io) {
  let entries
  try {
    entries = io.list(root)
  } catch {
    return []
  }
  return entries
    .filter((name) => /^7(\.\d+)*$/.test(name))
    .sort((a, b) => {
      const left = a.split('.').map(Number)
      const right = b.split('.').map(Number)
      for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
        const diff = (right[i] ?? -1) - (left[i] ?? -1)
        if (diff !== 0) return diff
      }
      return 0
    })
    .map((name) => join(root, name, 'pwsh.exe'))
}

/** Windows 上的 PowerShell 家族候选：pwsh 7 优先，5.1 最后兜底。 */
function windowsPowerShellCandidates(env, io) {
  const candidates = []
  if (env.LOCALAPPDATA) {
    const userRoot = join(env.LOCALAPPDATA, 'Programs', 'PowerShell')
    candidates.push(...versionedPwsh(userRoot, io))
    candidates.push(join(userRoot, '7', 'pwsh.exe'))
  }
  candidates.push(join(env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'))
  for (const entry of splitPath(env.PATH, 'win32')) candidates.push(join(entry, 'pwsh.exe'))
  // 5.1：任何 Windows 都有，但语义与 7 有差异（不支持 && / ||，见 README 已知限制）
  candidates.push(join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  return candidates
}

function posixPowerShellCandidates(env) {
  const candidates = []
  for (const entry of splitPath(env.PATH, 'posix')) candidates.push(join(entry, 'pwsh'))
  return candidates
}

function bashCandidates(env, platform) {
  if (platform === 'win32') {
    const candidates = [join(env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')]
    for (const entry of splitPath(env.PATH, 'win32')) candidates.push(join(entry, 'bash.exe'))
    return candidates
  }
  // /bin/bash 是 macOS 的部件（3.2），永远在；Homebrew 的更新版本排在其后。
  const candidates = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']
  for (const entry of splitPath(env.PATH, 'posix')) candidates.push(join(entry, 'bash'))
  return candidates
}

/**
 * 按方言与平台给出候选路径（按优先级）。
 * @param {{dialect:'bash'|'pwsh', platform:string, env:object}} input
 * @returns {string[]}
 */
export function candidateShellPaths({ dialect, platform, env = {} }, io = DEFAULT_IO) {
  if (dialect === 'pwsh') {
    return platform === 'win32' ? windowsPowerShellCandidates(env, io) : posixPowerShellCandidates(env)
  }
  return bashCandidates(env, platform)
}

/** 从路径推断 shell 家族；调用方用它把「现在用的是 5.1」这件事如实报出来。 */
export function shellFlavorOf(path, dialect) {
  if (dialect === 'bash') return 'bash'
  const name = basename(String(path ?? '')).toLowerCase()
  if (name === 'powershell.exe') return 'windows-powershell-5.1'
  if (name === 'pwsh.exe' || name === 'pwsh') return 'pwsh-7'
  return 'unknown'
}

/**
 * 解析要 spawn 的 shell。
 *
 * @param {{dialect:string, platform:string, env?:object, explicit?:string}} input
 * @param {object} [io]
 * @returns {{path:string|undefined, source:'explicit'|'discovered'|'none', tried:string[]}}
 */
export function resolveShellPath(input, io = DEFAULT_IO) {
  const { dialect, platform, env = process.env, explicit } = input
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return { path: explicit.trim(), source: 'explicit', tried: [] }
  }
  const tried = candidateShellPaths({ dialect, platform, env }, io)
  for (const candidate of tried) {
    if (shellExists(candidate, io)) return { path: candidate, source: 'discovered', tried }
  }
  return { path: undefined, source: 'none', tried }
}

/** 方言与可执行文件是否匹配：pwsh 方言接受 pwsh/powershell，bash 方言只接受 bash。 */
export function dialectMatchesPath(shellPath, dialect) {
  const name = basename(String(shellPath ?? '')).toLowerCase()
  if (dialect === 'pwsh') return name === 'pwsh.exe' || name === 'pwsh' || name === 'powershell.exe'
  if (dialect === 'bash') return name === 'bash' || name === 'bash.exe'
  return false
}

/**
 * 校验一个外部指定的 shellPath（配置或工具参数）。返回 null 表示通过。
 * @returns {string|null} 失败原因（面向调用方的一句话）
 */
export function validateShellPath({ shellPath, dialect, io = DEFAULT_IO }) {
  if (typeof shellPath !== 'string' || shellPath.trim().length === 0) return 'shellPath must be a non-empty string'
  const path = shellPath.trim()
  if (!isAbsolute(path)) return `shellPath must be an absolute path, got "${path}"`
  if (!dialectMatchesPath(path, dialect)) {
    return `shellPath "${path}" does not match shellDialect "${dialect}" — the dialect decides the command framing, so a mismatched shell would break every command`
  }
  if (!shellExists(path, io)) return `shellPath "${path}" does not exist (or is not a file)`
  return null
}

/**
 * 找不到 shell 时的错误正文：列出试过的每一条，并给出两条可执行的修法。
 */
export function shellNotFoundMessage({ dialect, platform, tried }) {
  const lines = tried.length > 0
    ? tried.map((candidate) => `  - ${candidate}`).join('\n')
    : '  (no candidate paths for this platform/dialect)'
  const installHint = dialect === 'pwsh'
    ? 'Install PowerShell 7 (https://aka.ms/powershell) or point config shellPath at an existing pwsh.exe/powershell.exe.'
    : 'Install bash, or point config shellPath at an existing bash executable.'
  return `background-terminal: SHELL_NOT_FOUND — no usable "${dialect}" shell on ${platform}. Tried:\n${lines}\n${installHint}`
}
