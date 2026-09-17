# Levon

看清 Agent 的每一步。

一个面向学习与个人使用的 Agent 实验台：通过真实轨迹，把模型输入、工具结果、停止原因与核心代码对应起来，再改变条件验证理解。

当前实现为 **Go 运行内核 + TypeScript 网页**，沿用已确认的时间轴、事件列表与详情侧栏。[架构决策](docs/adr/0001-go-runtime-typescript-ui.md)

## 启动

需要 Go 1.24 或更新版本。在项目目录运行：

    go run .

打开 http://127.0.0.1:8877/。默认只读本项目 workspace/ 下的两份示例笔记。模型配置沿用环境变量 OPENAI_API_KEY、OPENAI_MODEL，以及可选的 OPENAI_BASE_URL；密钥只保留在后端。程序不会自动读取 .env 文件。

    go run . --workspace /absolute/path/to/notes

也可以编译后直接运行，运行时不需要 Python 或 Node：

    go build -o levon .
    ./levon --workspace /absolute/path/to/notes

状态目录默认是当前目录下的 .agent_state/runs，可用 --state-dir 指定。模型请求保留原有的兼容 Chat Completions 格式，以 Go 标准库 HTTP 调用；不声称覆盖厂商 SDK 的全部功能。错误会转换成明确且不含凭证的记录。

## 第一个实验

先预测：模型请求上限为 1，第一轮提出工具请求时，工具是否执行？程序还会不会请求模型继续？再运行任务，查看调用与停止位置。学习实验需要作者自己的预测和解释，程序测试通过不等于已经掌握。

每次提交创建独立运行。记录保存在 .agent_state/runs/<run-id>/，包括 run.json、trace.jsonl 与 session.jsonl，可从页面导出 JSON。重启会载入最近八次有效、已结束的运行；无效或未结束的记录会跳过并提示，原文件保留。回看不会调用模型、重新执行工具或恢复任务。

旧 Python 记录保留当时的路径和源码。新 Go 记录保存编译时嵌入的函数源码，以及嵌入源码和资源的摘要标识；重新编译才会更新这些内容，历史记录不会被当前源码覆盖。

## 代码入口

- [agent.go](agent.go)：模型请求、同批工具回执与停止条件。
- [tools.go](tools.go)：只读工具的参数与路径检查。
- [model.go](model.go)：模型 HTTP 连接、超时与错误转换。
- [trace.go](trace.go)：实际输入输出与耗时记录。
- [storage.go](storage.go)：日志、历史加载和源码快照。
- [server.go](server.go)：本机 HTTP 接口与单任务运行控制。
- [web/src/app.ts](web/src/app.ts)、[web/src/types.ts](web/src/types.ts)：界面逻辑与接口类型。
- [runtime_test.go](runtime_test.go)：离线行为、路径边界、历史及 HTTP 检查。

## 开发与检查

修改 TypeScript 时需要 Node/npm：

    npm ci
    npm run typecheck
    npm run build
    go test -race ./...

web/dist/ 中的构建产物随源码提交，Go 编译时将其嵌入，因此只运行 Go 后端不需要先安装前端工具。修改 TypeScript 后应同步构建产物，并重新编译或重启 go run。

保留的 Python 对照版本位于 python-reference 标签。若本机有 Python 3.10+，可用相同的四组固定响应和真实文件检查对照版本；无需调用模型或安装 Python SDK：

    python3 -B scripts/check_python_reference.py

完整对照说明见 [Python 参考版本](docs/python-reference.md)。

## 当前范围

本机、单人、一次一个任务，只开放指定目录内的 Markdown 列表和读取。没有 Shell、写入、实时暂停、后台恢复或多 Agent。模型 HTTP 请求超时为 60 秒，不自动重试；关闭网页不会取消已提交任务。

正常结束不等于任务验收通过。路径校验不等同于操作系统 Sandbox。历史输入与输出包含任务材料，状态目录默认不进入 Git。

对于 opencode.ai，客户端使用自己的 User-Agent 与稳定会话 ID，遵循其[公开接入协议](https://opencode.ai/docs/go/#where-can-i-use-it)。其他服务不发送该专用会话头。

项目独立于书籍仓库。本机运行问题与验证记录见 [运行说明](docs/operations.md)。尚未创建远端仓库或确定公开发行许可。
