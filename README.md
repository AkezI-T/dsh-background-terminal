# dsh-background-terminal

给 DSH 的 agent 一个跨工具调用、跨模型回合续用的持久 shell。

一次调用开一个交互式 shell，首条命令写进 stdin；此后可反复读增量输出、写输入、中断前台命令后继续用同一个 shell，用完再关。

> **隔离等级**：默认后端直连 `node-pty`，这条会话的读 / 写 / 网络不受 ACL 沙箱约束。每个结果里的 `enforcement` 如实上报实际等级。

## 一、本插件是什么，解决了什么问题

DSH 的一次性命令是「提交 → 等它整个结束 → 拿结果」：中间不能喂输入、不能中断，超时了也看不到进展。本插件给 agent 一个**活着的 shell**，把这三件事补上：

| 能力 | 怎么做 |
|---|---|
| 向已启动的进程写输入 | `terminal_write` |
| 中断前台命令后继续用同一个 shell | `terminal_signal`（`SIGINT`）|
| 多次续读、不重复 | `terminal_read`（增量游标）|
| 一次调用看到全部会话状态 | `terminal_state` |
| 有界等待 / 命令结束时唤醒 | `waitMs` / `notifyOnExit` |

判据只有一条：**这条命令会不会活着跨越你的下一步。**

```
秒级、要退出码        → bash / pwsh
分钟级、只要最后结果  → run_in_background
会一直活着，或要中途喂输入 / 中断后继续用 → terminal_*
```

**三个动作**：

| 阶段 | 要解决的问题 |
|---|---|
| **发现终端** | 用哪个 shell？默认插件自己找；找不到时用 `shellPath` 指定。方言由配置决定，不猜 |
| **挂起使用** | `terminal_exec` 起会话 → `terminal_read` 读 → `terminal_write` 喂 → `terminal_state` 看 |
| **退出结束** | 命令结束 ≠ 会话结束；`terminal_signal({ close: true })` 收掉，容量才释放 |

## 二、本插件怎么用

### 安装

在 DSH 里添加插件，输入本仓库地址 **`https://github.com/AkezI-T/dsh-background-terminal`**（也接受本地目录）。依赖解析、挂载、工具与技能注册都由 DSH 完成，不需要手工改 profile 或预设。

重启 Host 后生效。

### 1. 发现终端

`shellPath` 省略时按 `shellDialect` 与平台解析，命中第一个即用：

| 平台 / 方言 | 候选 |
|---|---|
| Windows / `pwsh` | 用户级 PowerShell 7 → 机器级 PowerShell 7 → PATH 上的 `pwsh.exe` → Windows PowerShell 5.1 |
| macOS / `bash` | `/bin/bash` → `/usr/local/bin/bash` → `/opt/homebrew/bin/bash` → PATH |
| Linux / `bash` | `/bin/bash` → `/usr/bin/bash` → `/usr/local/bin/bash` → PATH |

一个都不存在时**插件挂载失败**（`SHELL_NOT_FOUND`，列出试过的路径）。找不到时用别的工具查出来，传给新建会话：

```powershell
Get-Command pwsh | Select-Object -ExpandProperty Source    # 或：which bash
terminal_exec({ command: '<命令>', shellPath: '<绝对路径>' })
```

`shellPath` 只在新建会话时有效，必须绝对路径、必须存在、必须与方言匹配。

> Windows + ACL 沙箱下请用 `pwsh`，不要用 Git Bash（起不来，会在启动前被拒绝）；`danger-full-access` 除外。

### 2. 挂起使用

```js
terminal_exec({ command, waitMs?: 10000, readCount?: 1, notifyOnExit?: false })
  ├─ 窗口内跑完 → { status: 'completed'|'failed', commandSettled: true,  commandExitCode, output, … }
  ├─ 窗口到期   → { status: 'running',              commandSettled: false, waitExpired: true,  … }
  └─ 尚未就绪   → { status: 'starting'|'startup-failed', commandSettled: false, waitExpired: false, … }
```

**超时不是失败**：会话与命令都还在跑。看进展用 `terminal_state`，看输出用 `terminal_read`，换策略用 `terminal_signal`。

| 参数 | 默认 | 含义 |
|---|---|---|
| `waitMs` | 10000 | 等命令结束的上限，最大 30000 |
| `readCount` | 1 | 窗口内结束时顺带回读几次输出，最大 20 |
| `notifyOnExit` | false | 命令结束时唤醒调用方；常驻服务永远不结束，开了没用 |
| `allowDangerous` | false | 覆盖危险命令减速带 |

`waitMs` 分档：秒级 6–10 秒；已知分钟级 15–20 秒；耗时未知 15 秒；常驻服务 15–25 秒。

**五个工具**

| 工具 | 参数 |
|---|---|
| `terminal_exec` | `command`、`sessionId`、`reset`、`label`、`cwd`、`cols`、`rows`、`waitMs`、`readCount`、`notifyOnExit`、`allowDangerous`、`shellPath` |
| `terminal_read` | `sessionId`、`maxOutputChars`、`waitMs`、`peekTail` |
| `terminal_write` | `sessionId`、`data`、`newline` |
| `terminal_signal` | `sessionId`、`signal`、`close`、`reason` |
| `terminal_state` | `sessionId`（可选；省略则列出全部会话）|

**续签**：带 `sessionId` 的 `terminal_exec` 在同一个 shell 里跑下一条命令，cwd / 环境 / REPL 状态都保住。上一条命令的帧没闭合时（典型：SIGINT），必须显式 `reset: true`，代价是放弃它的退出码。

**读全的判据**：`outputFinal: true` + `lossy: false` + `unreadBytes: 0`，三者同时成立。

字段怎么读、常见坑的细节写在随包技能 `background-terminal` 里（agent 会自己加载）。

### 3. 退出结束

会话不会因为命令结束就消失：它继续占容量。任务做完：

```js
terminal_state({})                            // 列全
terminal_signal({ sessionId, close: true })   // 逐条关
terminal_state({})                            // 复核
```

关闭前先把未读输出读出来。`cleanup-failed` 表示清理没做成、进程可能还在：重试一次，仍失败就停下报告，或拿插件视野外的独立证据（进程树 / 端口 / 产物）才放行。

### 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `shellDialect` | `bash` | `bash` / `pwsh`；framing 两套语法 |
| `shellPath` | 省略则自动发现 | 显式给出则原样信任 |
| `allowShellOverride` | `true` | 是否允许 `terminal_exec` 的 `shellPath` 覆盖配置 |
| `logLevel` | `info` | `silent` / `error` / `warn` / `info` / `debug` |
| `ptyBackend` | `node-pty` | `node-pty` \| `host` |
| `maxSessionsPerAgent` | 4 | 只计活动会话 |
| `maxBufferBytes` | 262144 | ring 上限 |
| `maxOutputChars` | 16000 | 单次读取上限 |
| `cols` / `rows` | 120 / 30 | 上限 500 / 200 |
| `passElectronRunAsNode` | `false` | 是否把 `ELECTRON_RUN_AS_NODE` 继承给持久 shell |

完整配置项见 `lib/config.mjs`。

## 三、别的一些说明

### 隔离

`ptyBackend: 'node-pty'`（默认）直连派生，**不经** `ctx.sandbox.confine`：工作区外写、读任意路径、联网都不受限。需要写入隔离时用官方 `bash` / `pwsh` / 文件工具。

### 注意事项

1. **超时不是失败**，只是把控制权还回来。
2. **SIGINT 之后命令级字段会永久停在旧值**：看 `commandStateTrustworthy`，为 `false` 时不要用 `commandRunning`；要在这个 shell 里继续干活，用 `reset: true` 续签。
3. **`phase: killed` 不等于进程已死**：看进程树 / 端口 / 产物。
4. **命令结束默认没有推送**：要么 `notifyOnExit: true`，要么自己 `terminal_read` 探查；插件分不出「静默工作中」与「真卡死」。
5. **剩余量只看 `unreadBytes`**：`outputBytes` 是原始 PTY 字节，不能与游标相减；`lossy: true` 时它只是上界。
6. **`interrupt.state` 不会变成 `interrupted`**：插件没有「进程组已确认消失」的通道，真的停了没有要自己验。
7. **Windows PowerShell 5.1 没有 `&&` / `||`**，用 `;` 串联；`shellFlavor` 会报 `windows-powershell-5.1`。
8. **macOS 的 bash 是 3.2**，不支持 `${var,,}` 这类新语法；不提供 zsh 方言。
9. **不要用 `terminal_write` 换命令**：它是裸输入，不建命令帧、没有退出码。

### 测试

在仓库克隆里跑：

```powershell
npm test
```

### 文件

完整模块划分见 `lib/`；三个辅助脚本在 `tools/`（接线自检、两个需要非受限环境的验收脚本）。

### 技能

`skills/background-terminal/SKILL.md` 是给 agent 看的操作说明书，随插件注册，不需要手工安装。

---

MIT License。
