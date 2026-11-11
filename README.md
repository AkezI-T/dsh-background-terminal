# dsh-background-terminal

给 DSH Agent 一个跨工具调用、跨模型回合续用的持久交互式 shell。适合开发服务器、热更新观察、交互式程序，以及需要持续查看日志的长任务。

一次启动后，可以读取增量输出、向进程输入内容、中断前台命令，并在同一个 shell 中继续执行下一条命令。工作目录和环境变量随会话保留。

> **权限边界**：默认 `node-pty` 后端直接派生 shell，具有宿主进程可用的文件与网络权限，不受 DSH 文件沙箱隔离。会话的 `workspace-write` 模式和工作目录检查不能限制后续命令的文件影响。实际隔离等级从 `terminal_state.enforcement` 查看；受限操作应使用具备相应隔离的工具。

## 安装

在 DSH 的插件管理中添加仓库地址：

```text
https://github.com/AkezI-T/dsh-background-terminal
```

也支持本地项目目录。依赖解析与 Bundle 挂载由 DSH 完成，安装结果中的生效状态与后续操作提示决定是否需要重启 Host。

插件注册五个 `terminal_*` 工具；宿主提供 `skills` 服务时，还会注册随包技能 `background-terminal`。技能帮助 Agent 选择工具、管理会话和判读输出。

## 什么时候使用

| 任务 | 选择 |
|---|---|
| 短命令，只需要结果与退出码 | 前台 `bash` / `pwsh` |
| 一次性长任务，只需要最终结果 | 宿主提供的后台 Job 工具 |
| Electron 开发服务器、watch / HMR、调试器、交互式安装器 | `terminal_exec` |
| 本地软件或构建进程需要观察、交互或保留 shell 环境 | `terminal_exec`；启动器退出后另看应用状态 |
| 远程大文件下载需要查看进度或中断 | `terminal_exec`；只需最终文件时用后台 Job |
| 长任务需要持续观察日志、输入内容或中途中断 | `terminal_exec` |
| 保留 shell 的工作目录、环境变量，继续下一条命令 | 带 `sessionId` 的 `terminal_exec` |

## 快速上手

以下示例是 Agent 工具调用；`sessionId` 使用首次调用返回的值，`cwd` 使用项目绝对路径。开始前用 `terminal_state({})` 检查已有会话，优先复用适用的 shell，关闭已结束使用的会话。

### 启动开发服务器并观察日志

```js
terminal_exec({
  command: 'npm run dev',
  cwd: '<项目绝对路径>',
  label: '开发服务器',
  waitMs: 10000
})

terminal_read({ sessionId, waitMs: 10000 })
terminal_state({ sessionId })
```

等待窗口结束后，服务器继续运行。就绪日志与服务健康检查共同确认应用已启动；`terminal_state.ready` 只表示 shell 已就绪。执行健康检查须遵循当前任务的验证授权。

### 运行长任务，结束时通知 Agent

```js
terminal_exec({
  command: 'npm run build',
  cwd: '<项目绝对路径>',
  label: '项目构建',
  waitMs: 10000,
  notifyOnExit: true
})
```

命令在等待窗口内结束时，返回退出码和部分输出；仍在执行时，返回 `sessionId`，调用方可以推进其他工作，再按需读取进展。

`notifyOnExit` 默认关闭。开启后，命令结束会向所属 Agent 发送通知；每个会话最多发送 8 次。既有会话续用时，省略此参数会沿用原值，传 `false` 可关闭通知。长驻服务的启动状态通过日志和健康检查判断，退出通知用于观察服务结束。

### 输入、中断与继续执行

```js
// 回答交互程序的问题；newline 默认 true
terminal_write({ sessionId, data: 'y' })

// 中断前台命令，保留 shell
terminal_signal({ sessionId, signal: 'SIGINT' })

// 上一条命令正常结束后，继续使用同一个 shell
terminal_exec({ sessionId, command: 'git status --short' })
```

中断可能使上一条命令的结束标记缺失。确认前台任务已停止、shell 可接收命令后，可显式放弃旧退出码并开始下一条命令：

```js
terminal_exec({ sessionId, command: 'git status --short', reset: true })
```

`reset` 只重建命令跟踪状态。前台程序的交互输入使用 `terminal_write`；下一条 shell 命令使用 `terminal_exec`。

### 结束使用

```js
terminal_read({ sessionId })                 // 保存仍需使用的输出
terminal_signal({ sessionId, close: true })  // 关闭整个会话
terminal_state({ sessionId })               // 查看清理结果
```

每个 Agent 默认最多持有 4 个活动会话。命令结束后，shell 仍会占用容量；还有后续工作时可继续复用，任务完成后显式关闭。

已结束的会话记录默认保留 5 分钟、每个 Agent 最多保留 4 条，便于继续读取结果。清理成功按会话状态判断；对服务进程的清理，按任务需要补充独立进程或端口证据。

`cleanup-failed` 表示清理失败，进程可能仍存活，容量与模式切换围栏继续保留。可重试关闭；仍失败时报告状态与诊断信息，再决定后续操作。

## 五个工具

| 工具 | 用途 | 主要参数 |
|---|---|---|
| `terminal_exec` | 新建 shell，或在已有 shell 中执行下一条命令 | `command`、`sessionId`、`reset`、`cwd`、`label`、`waitMs`、`readCount`、`notifyOnExit`、`shellPath` |
| `terminal_read` | 增量读取、等待新输出、只读查看尾部 | `sessionId`、`maxOutputChars`、`waitMs`、`peekTail` |
| `terminal_write` | 向当前前台程序写输入 | `sessionId`、`data`、`newline` |
| `terminal_signal` | 中断前台任务或关闭会话 | `sessionId`、`signal`、`close`、`reason` |
| `terminal_state` | 查询当前 Agent 的会话快照 | `sessionId`；省略时列出活动与保留期会话 |

`terminal_exec.waitMs` 默认 10000 ms、最大 30000 ms；启动阶段另有等待预算。`readCount` 默认 1、最大 20。`terminal_read.waitMs` 默认 0，最大 30000 ms。完整参数以宿主展示的工具 Schema 为准。

## 状态与输出怎么读

### 命令状态

| 返回结果 | 含义与下一步 |
|---|---|
| `status: completed / failed`，`commandSettled: true` | 收到命令结束标记，查看 `commandExitCode` 与输出 |
| `status: running`，`waitExpired: true` | 等待窗口到期，可继续其他工作，稍后读日志或查状态 |
| `status: starting`，两个布尔值均为 `false` | shell 尚在启动，继续查询或显式关闭 |
| `status: startup-failed` | 启动失败，查看 `detail` 与 `diagnostics` |

`phase` 描述会话生命周期。命令是否仍在执行，先看 `commandStateTrustworthy`，再看 `commandRunning`。SIGINT 或会话退出后，缺失结束标记的命令字段可能失去可信度。

`commandGeneration` 标识同一会话中的命令代次；`reused: true` 表示复用了既有 shell。

### 增量读取与尾部查看

```js
terminal_read({ sessionId, maxOutputChars: 16000 })
terminal_read({ sessionId, peekTail: 2000 })
```

普通读取推进共享游标。`terminal_exec` 返回的内联输出也已经消费；后续读取从剩余部分继续。`peekTail` 查看当前保留的尾部，不推进游标；其预算在实现中按字节定位，多字节文本可能少于指定字符数。

| 字段 | 判读 |
|---|---|
| `truncated` | 本次读取达到预算，后面还有内容 |
| `lossy` / `gapBefore` | 较早输出已被有界缓冲覆盖 |
| `nextCursor` | 清洗后输出流的绝对字节偏移 |
| `unreadBytes` | 尚未消费的字节数；有覆盖时为上界 |
| `outputBytes` | 累计原始 PTY 字节数，与清洗后游标使用不同口径 |
| `outputFinal` | 会话输出已终结 |

**当前缓冲已读尽**看 `unreadBytes: 0`；**整个会话输出完整读尽**要求 `outputFinal: true`、`lossy: false`、`unreadBytes: 0` 同时成立。持久 shell 继续运行时，命令可以已经结束，`outputFinal` 仍为 `false`。

## Shell 与配置

随包的 [挂载声明](cordis.patch.yml) 配置为 `shellDialect: pwsh`、`logLevel: debug`；[配置解析器](lib/config.mjs) 的默认值分别为 `bash`、`info`。在 Linux / macOS 部署时，需要将挂载配置的方言设为 `bash`。

省略 `shellPath` 时，插件在挂载期按方言查找：

| 平台 / 方言 | 查找顺序 |
|---|---|
| Windows / `pwsh` | 用户级 PowerShell 7 → 机器级 PowerShell 7 → PATH → Windows PowerShell 5.1 |
| macOS / `bash` | `/bin/bash` → `/usr/local/bin/bash` → `/opt/homebrew/bin/bash` → PATH |
| Linux / `bash` | `/bin/bash` → `/usr/bin/bash` → `/usr/local/bin/bash` → PATH |

未找到 shell 时，插件挂载失败，错误列出尝试过的路径。应安装对应 shell 或在插件配置中指定 `shellPath`，再重新挂载。插件已经可用时，单次新建会话可通过 `shellPath` 覆盖路径；此路径必须绝对、存在且匹配已配置方言，同时要求 `allowShellOverride: true`。

| 配置 | 解析器默认值 | 含义 |
|---|---|---|
| `ptyBackend` | `node-pty` | 直连 PTY；`host` 则使用宿主终端派生服务 |
| `maxSessionsPerAgent` | 4 | 每个 Agent 的活动会话上限 |
| `maxBufferBytes` | 262144 | 清洗后输出缓冲上限，单位字节 |
| `maxOutputChars` | 16000 | 单次读取的默认字符预算 |
| `maxInputBytes` | 65536 | 单次输入字节上限 |
| `settledRetainMs` | 300000 | 已结束记录的保留时间，单位毫秒 |
| `allowShellOverride` | `true` | 允许新建会话覆盖 shell 路径 |
| `cols` / `rows` | 120 / 30 | 终端尺寸，上限 500 / 200 |
| `passElectronRunAsNode` | `false` | 默认剥离宿主的 `ELECTRON_RUN_AS_NODE` 环境变量 |

完整校验规则见 [配置解析器](lib/config.mjs)。

## 已知限制

- **隔离**：直连后端使用宿主进程权限；`host` 后端在受限模式下要求沙箱 provider。当前实现还会在 Windows 受限策略下拒绝 Bash 方言。
- **Windows 信号**：默认适配器通过 Ctrl+C 实现前台 `SIGINT`；前台 `SIGTERM` 不受支持。工具层的 `SIGKILL` 或 `close: true` 进入整个会话的关闭流程。
- **中断证据**：信号已送达只证明写入已发生，任务是否停止需要结合独立证据判断。`reset` 会放弃旧命令的退出码。
- **持久性**：shell 跨工具调用、模型回合存活；宿主重启后的会话恢复尚未实现。
- **Shell 兼容性**：Windows PowerShell 5.1 缺少 `&&` / `||`；macOS 自带 Bash 3.2 缺少部分新语法。当前提供 Bash、PowerShell 两种方言。
- **命令拦截**：危险命令检测覆盖 `terminal_exec`，`allowDangerous` 可显式覆盖；原始输入通道 `terminal_write` 直接写入。操作权限仍由任务授权决定。
- **运行状态**：退出码、shell 就绪、日志静默分别反映不同事实。完成判定需结合任务产物、日志或服务健康状态。

## 开发与验证

在仓库目录中运行冷测试：

```bash
npm test
```

测试脚本使用 Node.js 的 `--experimental-test-isolation=none`，在同一进程中加载测试文件。冷测试不能替代真实 PTY、进程树清理或应用交互验证。

| 入口 | 内容 |
|---|---|
| [Agent 操作技能](skills/background-terminal/SKILL.md) | 会话管理、输出判读与使用流程 |
| [插件入口](lib/index.js) | 工具注册与宿主接线 |
| [文档索引](docs/INDEX.md) | 设计、审查和历史验证记录 |
| [接线检查](tools/verify-wiring.mjs) | 检查指定 profile、预设与 shell 配置 |
| [PTY 探针](tools/probe-acceptance.mjs) / [插件验收](tools/acceptance-run.mjs) | 真实终端验收脚本，按独立验证授权执行 |

当前行为以源码和本说明为准；历史审查、交接文档中的版本与验证结论须结合其适用代码确认。

## 许可证

[MIT](LICENSE)
