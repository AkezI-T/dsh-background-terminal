# skills/background-terminal

给 DSH agent 的技能：**用后台终端跑长期活着的任务**（dev server、HMR 观察、Electron、分钟级构建），
并把本机实测踩过的坑收在一处。

## 装法：随包注册，无需复制

插件在挂载时把这份技能注册成 **runtime skill**：`lib/bundled-skill.mjs` 读取本文件、解析 frontmatter，
再交给 `ctx.skills.register`。所以**装插件即得技能**——换机器、换用户名、换安装目录都不需要改路径，
也没有任何要手工复制的文件。

两条边界：

- **同一层里 runtime 优先于 user**（`~/.dsh/skills`）。用户目录里若有同名旧副本，会被随包这份覆盖。
- **改完仓库里的 SKILL.md 要重启 Host 才生效**（技能在挂载期注册，ESM 模块也在那时缓存）。

组合里**没有** `skills` 服务时，插件会跳过注册（日志里有一条 warn），四个终端工具照常可用；
那种情况下才需要手工副本：

```powershell
Copy-Item ".\skills\background-terminal\SKILL.md" "$env:USERPROFILE\.dsh\skills\background-terminal\SKILL.md" -Force
```

（在仓库根执行。）
## 状态：可加载（2026-10-05 复核）

改名后复核：`skill("background-terminal")` 返回 `provider: filesystem`、`resourceBase: %USERPROFILE%\.dsh\skills\background-terminal`，
内容可读出 —— **技能目录里可见、可加载**。

早期记录（现已被推翻/不再复现）：曾出现「文件就位、frontmatter 校验通过，但调用不进来」，
当时已排除目录名不一致、缓存、`disable-model-invocation` 等原因，结论停留在「用户-dsh 根下的技能没进目录」。
该现象现在不再复现；本技能确实会出现在技能目录中。

## 里面有什么

| 节 | 内容 |
|---|---|
| 一 | 什么时候用它（含一条边界：受限沙箱下真实构建只有本插件的会话跑得起来，自带 `pwsh`/`bash` 会 `spawn EPERM`）|
| 二 | **终端从哪来**：自动发现的候选顺序（Windows/macOS/Linux）、`SHELL_NOT_FOUND` 的处置、方言不可猜、`shellPath` 覆盖的三条硬性要求、`shellFlavor` 判读 |
| 三 | **标准流程 清 → 起 → 等 → 读 → 收**：§三.0「开新终端的前置清场门」（触发 / 客观判据表 / `cleanup-failed` 处置 / 复核 / 清不掉时放行或不放行）+ `waitMs` 分档 + 三段式 |
| 四 | **字段判读表**（结束了没 / 还在跑没 / 读全了没 / 丢了没 / 剩余量 / 会话还在没）|
| 五 | **12 条坑**（含 5.1 不支持 `&&`、macOS bash 3.2）|
| 六 | 收尾清场与残留判据（判据表在 §三.0，不重写）|
| 七 | 交付闸门（三项证据 + 「读全」的三条件）|
| 八 | 命令速查 |

第四节的坑：SIGINT 后立刻写输入会被吞、内联 `output` 被消费但可用 `peekTail` 找回、
命令级字段在中断后永久失真、`lossy` 的触发条件与信号位置、`phase: killed` ≠ 进程已死、
静默 ≠ 卡死、`ELECTRON_RUN_AS_NODE`、rc=0 说谎、负退出码、端口独立验证、HMR 要还原源码。


## 与插件 README 的分工

插件的 `README.md` 讲**工具契约**（参数、返回、限制）；本技能讲**怎么干活**（流程、判读、坑）。
README 给实现与使用者看，SKILL 给 agent **动手时**看。

## 与 `esp32-idf` 技能的关系

`esp32-idf` 是平台专项（路径、工具链、烧录、串口），与本技能互补：跑 ESP-IDF 时先用它拿环境，
再用本技能的方式挂着观察。本技能不重复平台细节，只把「Git Bash 下 `idf.py build` 假装成功」这类**通用**教训收进来。

## 已知边界

- 触发词决定它**何时被想起**；没被加载时，用法仍写在插件 `README.md` 里
- 第四节的坑以 **Windows** 实测为准；非 Windows 的对应行为未验证