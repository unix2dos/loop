# 第一次 Coding 练习

这个练习让 Loop 修复 TypeScript 的 average 函数：空数组或 null 应返回 0，非空输入保留向零取整的平均行为。代码和测试会复制到本次运行的独立目录。

## 开始

普通对话需要 Node 24.12+。Coding 练习另外需要 Docker 和固定的 Node 镜像：

```sh
docker pull node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
```

按 README 启动 Loop，在网页设置中将模型请求上限设为 6，再选择“新任务 → 修复一个 TypeScript 程序”。阅读范围后点击“授权并运行练习”。模型决定读取、修改与再次测试的顺序；一次响应可包含多个工具调用，工具调用总上限为 24。

模型可能无法在预算内完成。保留失败记录，先检查最后的回执，再决定是否继续同一对话。测试通过只代表现有用例通过。

## 执行证据

默认目录为 `~/.loop/ts-runs/<首轮运行 ID>/workspace/`，包含 average.ts、average.test.ts、package.json 和 README.md。追问沿用同一个副本，每轮记录独立保存。

- `read_file` 返回文本和 SHA-256 指纹。
- `write_file` 仅接受 average.ts，要求 expected_sha256 与当前内容一致。拒绝过期写入；成功后返回真实修改前后文本、指纹和 diff。
- 写入使用临时文件、同步落盘后替换目标。单活跃任务和独立练习目录避免本产品内的并发写入；共享仓库需要额外的写入协调。
- `run_command` 仅接受 `node --test average.test.ts`，返回 stdout、stderr、实际退出码、被测源码指纹与容器清理结果。Node 每次重新执行测试。
- 非零退出作为错误回执送回模型。无法确认进程状态或容器清理时，停止运行。

## 容器边界

文件工具由本机 Harness 执行，仅访问固定练习文件。测试容器断网、非 root、根文件系统及项目挂载只读，限制 CPU、内存和进程数；临时目录可写。容器内没有本机仓库、Docker socket 或模型 API Key。

单次执行上限为 90 秒，stdout 和 stderr 各最多保留 64 KiB。测试与 package.json 内容受保护；不安装第三方依赖。容器隔离依赖本机 Docker。

`LOOP_PUBLIC=1` 时后端拒绝 Coding 练习及续跑，网页隐藏入口。

## 开发验证

```sh
npm ci
npm test
# 需要已启动的 Docker 与上述镜像，不调用真实模型：
npm run test:docker
```

Docker 检查验证已知错误、指纹校验修复、测试通过、断网与只读隔离、输出限制、取消清理以及练习工具不影响普通对话。
