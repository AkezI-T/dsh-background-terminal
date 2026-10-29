# 测试隔离说明（非测试文件）

文件名以 `.mjs` 结尾而非 `.test.js`，所以它**不会被 `test/*.test.js` 匹配**，不参与测试运行。

这里原本放过一个"同进程加载全部测试"的临时入口，后来发现 Node 自带的开关更好用，已废弃：

```powershell
& "F:\Program Files\nodejs\node.exe" --test --experimental-test-isolation=none "test/*.test.js"
```

## 为什么必须带这个 flag

默认的 `node --test` 会**为每个测试文件 spawn 一个子进程**，而本工作区的文件沙箱拒绝子进程管道（`spawn EPERM`，Windows 上管道即命名管道）。那不是测试失败，是环境限制：测试一个都没跑就整批报 `spawn EPERM`。

`--experimental-test-isolation=none` 让所有测试文件在**当前进程内**注册并运行，因此沙箱内也能跑。

两个附带约束：

- 该 flag 下**不能传目录**（`--test test/` 会报 `ERR_UNSUPPORTED_DIR_IMPORT`），必须显式给 glob 或文件列表。
- 沙箱**外**的常规环境不需要这个 flag，`node --test test/` 正常工作。

## 为什么这里留着这个文件

沙箱内的 shell 无法删除或移动工作区里的文件（`Remove-Item` / `Move-Item` / `Copy-Item` 均被拒绝）。与其留下一个内容过时、名字又像测试入口的文件，不如留一份准确的说明，并保留使用者自行删除的权利——`package.json` 的 `test` 脚本已经指向正确命令，这里不影响任何行为。
