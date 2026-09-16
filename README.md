# Levon

看清 Agent 的每一步。

一个面向学习与个人使用的 Agent 实验台：查看真实运行轨迹，把模型输入、工具结果、停止原因和核心代码对应起来，再通过改变条件理解行为。

## 启动

需要 Python 3.10 或更新版本。在项目目录运行：

    python3 -m venv .venv
    .venv/bin/python -m pip install -r requirements.txt

在启动服务的终端设置 OPENAI_API_KEY、OPENAI_MODEL，以及可选的 OPENAI_BASE_URL。本机已有这些环境变量时可直接沿用。不要把真实密钥写进版本库或浏览器。程序不会自动读取 .env 文件。

    .venv/bin/python -B app.py

打开 http://127.0.0.1:8877/。默认只读本项目 workspace/ 下的两份示例笔记。

    .venv/bin/python -B app.py --workspace /absolute/path/to/notes

## 第一个实验

先用默认四次请求运行一项读取任务，再将请求上限设为一次，观察工具是否已经执行、程序在哪里停止。点击事件查看实际输入输出和核心代码。

每次提交建立一个新会话。最近八次运行保留在当前服务的界面中；完整记录保存到 .agent_state/runs/<run-id>/，可以从页面导出 JSON。重启后不会自动加载旧记录列表。历史轨迹的查看不会重新执行工具。

## 代码入口

- agent.py：工具循环、会话消息和受限文件工具。
- client.py：模型连接和只读工具定义。
- app.py：本机 HTTP 服务、运行记录和工具执行边界。
- index.html：时间轴、事件列表与详情侧栏。
- check.py：离线检查，使用预设模型响应和真实临时文件。
- docs/discovery.md：目标、设计取舍和验证记录。

    .venv/bin/python -B check.py

修改 Python 代码后先重启服务，再发起新任务。网页刷新不会重载 Python 内核。

## 当前范围

仅在本机使用，一次运行一个任务；开放列目录和读取 Markdown，没有 Shell、写入、实时暂停、后台恢复或多 Agent。模型请求设置 60 秒 SDK 超时，不自动重试。关闭页面不会取消已发出的请求。

正常结束只说明循环结束，任务结果需要核对。路径校验不等同于操作系统 Sandbox。

当模型服务地址是 opencode.ai 时，使用本项目自己的 User-Agent 和每次运行的稳定会话 ID，遵循 https://opencode.ai/docs/go/#where-can-i-use-it 的公开客户端协议。其他服务不发送该专用请求头。

## 项目关系

实现起点来自作者的 Agent Engineering Book 配套实验，现已独立维护。运行时、依赖、默认示例和状态目录均在本项目内，不需要书籍仓库。

当前尚未发布到远端仓库，也未决定公开发行许可。
