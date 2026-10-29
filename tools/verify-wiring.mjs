/**
 * 接线只读校验：检查插件是否已被 profile 与预设接纳。
 *
 * 只读——不修改任何文件。用于在重启 Host 之前确认配置改动到位。
 * 用法：node tools/verify-wiring.mjs [--profile-package <path>] [--preset-patch <path>] [--pwsh <path>]
 *
 * 三个路径也可分别用环境变量给出：DSH_PROFILE_PACKAGE / DSH_PRESET_PATCH / DSH_PWSH_PATH。
 * 默认 profile 为 <DSH_HOME>/profiles/desktop/package.json（DSH_HOME 默认 ~/.dsh）。
 * 未提供预设 patch 时跳过预设挂载检查；未提供 pwsh 时按插件 patch 里的 shellPath 检查。
 *
 * 退出码：0 = 接线完整；1 = 有缺失项（逐条打印要怎么改）。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { dialectMatchesPath, resolveShellPath, shellFlavorOf } from '../lib/shell-resolve.mjs'

/** 本仓库根：本脚本位于 <repo>/tools/ 下。 */
const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** 读取 `--name value` 或 `--name=value` 形式的命令行参数。 */
function takeArg(name) {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 3)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const PROFILE_PKG =
  takeArg('profile-package') ?? process.env.DSH_PROFILE_PACKAGE ?? join(DSH_HOME, 'profiles', 'desktop', 'package.json')
const PRESET_PATCH = takeArg('preset-patch') ?? process.env.DSH_PRESET_PATCH

/** pwsh 路径：命令行 > 环境变量 > 插件 patch 里的 shellPath（见第 6 节）。 */
const PWSH_ARG = takeArg('pwsh') ?? process.env.DSH_PWSH_PATH

const problems = []
const ok = []

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    problems.push(`无法读取 ${path}：${String(error)}`)
    return undefined
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    problems.push(`无法读取 ${path}：${String(error)}`)
    return undefined
  }
}

// ── 1. 插件自身文件齐备 ─────────────────────────────────────────────────────
const required = [
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'lib/index.js',
  'lib/contract.mjs',
  'lib/config.mjs',
  'lib/records.mjs',
  'lib/fence.mjs',
  'lib/controller.mjs',
  'lib/shell-bash.mjs',
  'lib/pump.mjs',
  'lib/reader.mjs',
]
for (const rel of required) {
  if (existsSync(join(PLUGIN_DIR, rel))) ok.push(`文件存在：${rel}`)
  else problems.push(`缺少文件：${rel}`)
}

// ── 2. profile 依赖 ────────────────────────────────────────────────────────
const profile = readJson(PROFILE_PKG)
if (profile !== undefined) {
  const dep = profile.dependencies?.['dsh-background-terminal']
  if (typeof dep === 'string' && dep.startsWith('link:')) ok.push(`profile 依赖已声明：${dep}`)
  else {
    problems.push(
      `profile 缺少依赖。在 ${PROFILE_PKG} 的 dependencies 加入：\n` +
        `    "dsh-background-terminal": "link:${PLUGIN_DIR}"`,
    )
  }

  const bundles = profile.dsh?.profile?.bundles ?? []
  if (bundles.includes('dsh-background-terminal')) ok.push('profile bundles 已包含 dsh-background-terminal')
  else {
    problems.push(
      `profile bundles 缺少 "dsh-background-terminal"。在 ${PROFILE_PKG} 的 dsh.profile.bundles 数组里追加该项。`,
    )
  }
}

// ── 3. profile node_modules 里的安装（junction）──────────────────────────────
// 只改 profile 的 package.json 是不够的：loader 按名字解析 bundle，必须能在
// profile 的 node_modules 下找到这个包，否则 Host 启动时报
//   cannot resolve profile bundle "dsh-background-terminal"
// 其余 link 插件同样靠这里的 junction 生效。
const PROFILE_NODE_MODULES = join(dirname(PROFILE_PKG), 'node_modules')
const installedPath = join(PROFILE_NODE_MODULES, 'dsh-background-terminal')
if (existsSync(installedPath)) {
  const installed = readJson(join(installedPath, 'package.json'))
  if (installed?.name === 'dsh-background-terminal') {
    ok.push(`profile node_modules 已安装：${installedPath}`)
  } else if (installed !== undefined) {
    problems.push(`${installedPath} 存在，但其中的 package.json name 不是 dsh-background-terminal`)
  }
} else {
  problems.push(
    `profile node_modules 里没有本插件（Host 会报 cannot resolve profile bundle "dsh-background-terminal"）。建立链接：\n` +
      `    New-Item -ItemType Junction -Path '${installedPath}' -Target '${PLUGIN_DIR}'`,
  )
}

// ── 4. bundle patch 自己的挂载行（host 平面）────────────────────────────────
// 两处挂载都要给 config：host 行缺 config 会让插件被判「未激活」。
// shellPath 现在可省略（按方言发现），所以「有 config」的判据是 shellDialect。
const bundlePatch = readText(join(PLUGIN_DIR, 'cordis.patch.yml'))
if (bundlePatch !== undefined) {
  const hasHostRow = /id:\s*dsh-background-terminal-host\b/.test(bundlePatch)
  const hasHostConfig = /shellDialect:\s*\w+/.test(bundlePatch)
  if (hasHostRow && hasHostConfig) ok.push('cordis.patch.yml 的 host 行已带 config')
  else if (!hasHostRow) {
    problems.push(
      'cordis.patch.yml 缺少 host 挂载行（id 用 dsh-background-terminal-host，以区别于预设行的 background-terminal）。',
    )
  } else {
    problems.push('cordis.patch.yml 的 host 挂载行缺少 config.shellDialect —— 会让插件被判「未激活」。')
  }
}

// ── 5. 预设挂载行 ──────────────────────────────────────────────────────────
if (PRESET_PATCH === undefined) console.log('跳过预设挂载检查（未提供 --preset-patch / DSH_PRESET_PATCH）。')
const preset = PRESET_PATCH === undefined ? undefined : readText(PRESET_PATCH)
if (preset !== undefined) {
  const hasId = /-\s*id:\s*background-terminal\b/.test(preset)
  const hasName = /name:\s*dsh-background-terminal\b/.test(preset)
  const hasShellDialect = /shellDialect:\s*\w+/.test(preset)
  if (hasId && hasName) ok.push('预设 patch 已挂载 background-terminal')
  else {
    // 工具注册是全局的，agent 会继承——预设里不挂也能用。
    // 这里只提示「想给该预设单独配置时该写什么」，不算问题。
    console.log('预设未挂载本插件（可选；工具从全局继承，不配置也能用）。')
  }
  if (hasShellDialect) ok.push('预设里已配置 shellDialect')
  else if (hasId) problems.push('预设的 background-terminal 行缺少 config.shellDialect（缺 config 会让插件被判「未激活」）')

  const level = /logLevel:\s*(\w+)/.exec(preset)?.[1]
  if (level !== undefined) ok.push(`预设已配置 logLevel: ${level}`)
  else if (hasId) problems.push('预设未配置 logLevel（排查期建议 debug；默认 info）')

  // ── 方言与能力矩阵（审阅 R001-04）────────────────────────────────────────
  // 受限 Windows 下 Git Bash 结构性不可用（Cygwin 需要命名管道，受限令牌拿不到），
  // 配成 bash 会让每次 spawn 都以 127 结束。这里当成**接线错误**拦下，而不是留给重启后发现。
  const dialect = /shellDialect:\s*(\w+)/.exec(preset)?.[1]
  if (dialect === undefined) {
    if (hasId) problems.push('预设未配置 shellDialect（默认 bash，在本机受限模式下不可用）')
  } else if (dialect === 'bash') {
    problems.push(
      '预设的 shellDialect 是 bash —— 在 Windows 受限沙箱下结构性不可用：\n' +
        '    Git Bash 是 Cygwin/MSYS2 程序，启动时需要信号管道，受限令牌创建不了\n' +
        '    （"couldn\'t create signal pipe, Win32 error 5"），表现为每次 spawn 都以 exit 127 结束。\n' +
        `    改为：shellDialect: pwsh 且 shellPath: '${PWSH_ARG ?? '<pwsh 绝对路径>'}'`,
    )
  } else if (dialect === 'pwsh') {
    ok.push('预设的 shellDialect 为 pwsh（本机受限沙箱下唯一可行组合）')
  }

  const shellPathInPreset = /shellPath:\s*'([^']+)'/.exec(preset)?.[1]
  if (dialect === 'pwsh' && shellPathInPreset !== undefined && !dialectMatchesPath(shellPathInPreset, 'pwsh')) {
    problems.push(`shellDialect 为 pwsh，但 shellPath 指向的不是 pwsh.exe：${shellPathInPreset}`)
  }
}

// ── 6. shell 可执行文件：显式值优先，否则按方言发现 ───────────────────────
const shellPathInPatch = /shellPath:\s*'([^']+)'/.exec(bundlePatch ?? '')?.[1]
const dialectInPatch = /shellDialect:\s*(\w+)/.exec(bundlePatch ?? '')?.[1] ?? 'bash'
const shellChoice = resolveShellPath({
  dialect: dialectInPatch,
  platform: process.platform,
  env: process.env,
  explicit: PWSH_ARG ?? shellPathInPatch,
})
if (shellChoice.path === undefined) {
  problems.push(
    `找不到可用的 "${dialectInPatch}" shell（平台 ${process.platform}）。试过：\n` +
      shellChoice.tried.map((candidate) => `      - ${candidate}`).join('\n') +
      '\n    装一个，或在配置里显式写 shellPath。',
  )
} else {
  ok.push(`shell 可用：${shellChoice.path}（来源 ${shellChoice.source}，家族 ${shellFlavorOf(shellChoice.path, dialectInPatch)}）`)
}

// ── 报告 ───────────────────────────────────────────────────────────────────
console.log('=== 通过 ===')
for (const line of ok) console.log(`  ✓ ${line}`)
if (problems.length > 0) {
  console.log('\n=== 待办 ===')
  for (const line of problems) console.log(`  ✗ ${line}`)
  console.log('\n接线尚未完成。上述改动会写入你正在使用的 profile 与预设，确认后再执行。')
  process.exitCode = 1
} else {
  console.log('\n接线完整。重启 Host 后四个工具即可用（新增 bundle 行不热加载）。')
}
