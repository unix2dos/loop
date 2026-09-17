# Loop

**运行 Agent，看清每一步。**

A local Agent workbench for running tasks, inspecting real traces, and connecting behavior to source code.

Loop 是一个本地 Agent 实验台。你提交任务，它调用模型、执行工具、收集回执并继续；你可以在网页里查看真实输入输出、耗时、停止原因，以及对应的核心代码。

当前版本适合阅读 Markdown 笔记、核对书稿和学习工具调用循环。采用 **Go 内核 + TypeScript 网页**，只开放指定目录中的文件列表和 Markdown 读取。项目原名 Levon，现统一更名为 Loop。

## 第一次使用

### 1. 准备环境

- 安装 Git 和 [Go 1.24 或更新版本](https://go.dev/doc/install)，运行 `go version` 确认安装成功。
- 准备模型服务的 API Key、模型 ID 和 API 基础地址。模型需要支持兼容 OpenAI Chat Completions 格式的工具调用。
- 只运行 Loop 不需要安装 Python、Node 或 OpenCode CLI。模型调用使用你自己的服务额度。

### 2. 克隆项目

```sh
git clone https://github.com/unix2dos/loop.git
cd loop
```

### 3. 配置模型并启动

以下命令适用于 macOS / Linux 的 bash 或 zsh。替换三个占位值，并在同一个终端启动：

```sh
export OPENAI_API_KEY='your-api-key'
export OPENAI_MODEL='your-model-id'
export OPENAI_BASE_URL='https://your-provider.example/v1'
go run .
```

| 变量 | 填什么 |
|---|---|
| `OPENAI_API_KEY` | 你在模型服务商处取得的 API Key，不能用网页聊天产品的登录密码代替 |
| `OPENAI_MODEL` | 该接口支持的模型 ID |
| `OPENAI_BASE_URL` | API 基础地址；**不要包含 `/chat/completions`**，Loop 会自动追加。未设置时默认 `https://api.openai.com/v1` |

这些变量名表示兼容接口格式，不限制模型厂商。当前只实现 Chat Completions 调用，不支持直接使用 Responses 或 Anthropic Messages 地址。

<details>
<summary>示例：已有 OpenCode Go 账号，使用 GLM-5.3-Flash</summary>

```sh
export OPENAI_API_KEY='your-opencode-go-api-key'
export OPENAI_MODEL='glm-5.3-flash'
export OPENAI_BASE_URL='https://opencode.ai/zen/go/v1'
go run .
```

模型 ID 和地址见 [OpenCode Go 官方说明](https://opencode.ai/docs/go/#endpoints)。该组合已在本项目中完成真实工具调用验证；可用模型以服务商当前配置为准。Loop 自己执行 Agent 循环，OpenCode Go 在这里提供模型 API。客户端会发送自己的 User-Agent 和稳定的会话 ID，符合其[接入要求](https://opencode.ai/docs/go/#where-can-i-use-it)。

</details>

<details>
<summary>希望把配置保存在本地 .env 文件中</summary>

先执行 `cp .env.example .env`，用编辑器填入你自己的配置，然后运行：

```sh
set -a
. ./.env
set +a
go run .
```

**Loop 不会自动读取 `.env`**，上面的命令由 shell 加载配置。`.env` 已被 Git 忽略；示例只用于 bash/zsh。不要把真实密钥提交到仓库。

</details>

<details>
<summary>Windows PowerShell 的环境变量写法</summary>

在项目目录运行：

```powershell
$env:OPENAI_API_KEY = 'your-api-key'
$env:OPENAI_MODEL = 'your-model-id'
$env:OPENAI_BASE_URL = 'https://your-provider.example/v1'
go run .
```

</details>

保持终端运行，在浏览器打开 **[http://127.0.0.1:8877/](http://127.0.0.1:8877/)**。启动成功后，终端会显示网页地址和只读工作区。首页保持在任务总览，不会自动进入最新任务。左侧按对话列出全部有效历史与当前运行，支持折叠；点击一项查看对话，点击“新任务”另起对话。首次使用没有历史记录，提交后才会生成轨迹。

### 4. 提交第一个任务

默认工作区是项目自带的 `workspace/`，包含两份示例笔记，可以直接体验：

1. 点击左侧“新任务”（也可使用首页的“＋ 新任务”）。
2. 将“本轮请求上限”保持为 **4**，在任务框粘贴下面的内容。
3. 点击“开始任务”，等待模型和工具返回。

> 先列出工作区文件，再读取 agent-loop.md。用两句话说明工具结果怎样返回模型，并引用一处原文作为依据。

通常会看到“请求模型 → 列出文件 → 再次请求模型 → 读取笔记 → 最终回答”。具体调用次数由模型实际回复决定。一次模型回复可以提出多个工具调用。

在左侧对话区查看答案，并对照 [示例笔记](workspace/agent-loop.md) 核对引文。`completed` 只表示循环正常结束，任务结果仍需你验收；`budget_exhausted` 表示模型请求额度耗尽、无法继续。

第一次运行后，请核对三件事：

- 轨迹中确实有 `read_file` 读取 `agent-loop.md`，实际输出包含文件正文。
- 回答引用的句子能在这次工具输出里找到，文件名正确；不能只看“循环已结束”。
- 直接追问“刚才引用的是哪份文件？”后，同一段对话出现 Turn 2；第二轮模型请求的实际输入保留了第一轮消息。

追问会再次调用模型。需要独立体验另一个任务时，使用左侧“新任务”。

### 5. 看懂这次轨迹

任务与回答占主要宽度，右侧显示“全程分轨概览 + 完整事件流”。上方色块覆盖输入、模型、工具和程序的全部真实事件；下方按记录顺序展示输入、上下文准备、模型响应、执行器、工具、回执与停止。工具处理按模型请求成组，可折叠。任务侧栏与轨迹栏都可以折叠，并记住各自的选择；新任务不会强行展开它们。

顶部显示对话 Turn 总数、累计模型请求、工具调用、token 和执行耗时，概览覆盖所有 Turn。最多三轮时默认全部展开，更多轮次默认展开最新一轮，旧轮次保留可展开摘要。步骤条和耗时轨道同时显示：上方按顺序列出每个事件，下方按实际时间分布展示输入、模型、工具和程序操作，无需切换。每条事件也保留自己的耗时。时间轴累计各轮执行时间，不包含等待用户回复的时间。点击概览色块会展开相应工具组并定位事件，点击事件优先显示“原始记录”。桌面端可左右拖动两栏之间的分界线调整宽度，比例保存在当前浏览器；双击恢复默认，也可聚焦分界线后用左右方向键调整。折叠及手机竖排时不显示左右拖动条。展开原始记录后，事件列表与详情之间的横向分界线可上下拖动、双击恢复默认，也支持上下方向键；高度比例独立保存。

| 页面位置 | 能看到什么 |
|---|---|
| 模型事件行 → 原始记录 | 发给模型的消息和工具定义，以及它返回的回答、工具请求和 `finish_reason` |
| 工具事件行 → 原始记录 | 实际工具参数、文件内容或错误回执 |
| 回执连线 / 步骤关联 | 跳到接收结果的那次模型请求，核对输入中的 `role=tool` 消息 |
| 完整事件流 | 所有记录属于同一条流，程序动作不会被移到另一套列表；长任务的工具组可折叠 |
| 源码 | 该次运行保存的相关函数源码；新 Go 运行使用编译时嵌入的代码 |
| 自动定位最新事件 | 运行时自动选中并滚动到最新事件；手动选择其他事件会关闭，不影响 Agent 的执行 |
| 打开本地记录 | 在 Cursor 或 VS Code 中打开所选事件或字段所在的真实文件行 |
| 导出 / 导出对话 | 单轮下载 `loop-run-<id>.json`；多轮下载包含全部 Run 的 `loop-conversation-<id>.json`，不受折叠状态影响 |

完成第一条消息后，输入框会显示“继续对话”。直接追问会携带此前的用户消息、模型回复、工具调用及回执；每轮执行仍独立保存 `run.json`、`trace.jsonl` 和 `session.jsonl`，通过 `parent_run_id` 与 `conversation_id` 关联。左侧每段对话只占一项，右侧显示整段对话的轨迹，按 Turn 1、Turn 2… 分组；点击旧回答旁的“查看此轮轨迹”会展开并定位对应分组，再次发送仍接在对话末尾。左侧“新任务”从空历史开始。

模型请求上限与工具预算按每轮执行重新计数；旧轮次的停止状态不会改写。重启后可从保存的消息继续。若旧记录缺少完整消息、工具回执未配对、工作区不一致或消息文件超过 16 MiB，会提示无法继续，需开始新任务；不会默默丢弃历史或补造工具结果。当前不自动压缩上下文，对话越长，输入 token 通常越多，模型上下文上限仍由服务商决定。

界面中的 **Turn 是用户对话轮次**，取自 `conversation_turn`（旧独立运行视为 Turn 1）；模型行标出“模型轮次 N”：一次模型请求及它引发的工具处理属于同一轮；一次响应提出多个工具调用不会增加轮次。没有工具调用的最终回答仍算一次模型轮次。现有原始记录的 `turn` 字段记录模型请求计数，准备阶段为 0，页面不将它标为“第 0 轮”。一轮用户对话可能包含多次模型请求，因此不直接把 `turn` 当成对话轮次。

例如，点击工具节点的“进入第 N 次请求的消息”，会直接定位到下一次模型输入中的那条 `role: "tool"` 回执。

“导出对话”包含这段对话所有轮次的原始 Run，折叠不会减少导出内容；单轮仍导出原有 Run 格式。事件选择同时识别运行 ID 与事件 ID，因此不同轮次的 `e001` 不会串到一起；打开本地记录始终定位所选事件所属的原始文件。

模型事件行显示服务商实际返回的 token 数，轨迹摘要显示各次请求的累计用量；输入、输出及缓存输入可在原始记录详情中查看，缓存属于输入子项，不重复加到总计。缺少用量时显示“未返回”，部分已知时注明覆盖次数。短工具操作用毫秒显示；这些是请求或工具耗时，不是单独测量的“思考耗时”。

点击“打开本地记录”，本机服务会根据事件 ID 与所选字段计算磁盘文件的实际行号，再交给编辑器打开。已完成任务打开 `run.json`；运行期间打开 `trace.jsonl` 中对应事件最近一条有效记录。页面仍可直接查看输入、输出与 JSON Pointer（如 `/events/10/input/messages/5`）。

编辑器自动优先使用已安装的 Cursor，其次 VS Code；macOS 会优先检测应用自带的 CLI，其余情况从 PATH 查找 `cursor` / `code`。未找到编辑器或启动失败时会在页面提示。打开记录不会重跑任务或修改文件；该入口只允许打开本项目运行目录中的记录，不能传入任意文件路径。

轨迹和步骤说明只描述可观察的请求与结果，不重建模型内部思考。USER、CONTEXT、ASSISTANT、HARNESS、TOOL、RESULT、STOP 是界面的展示分类；例如 RESULT 是程序记录的回执，真实模型消息中的 `role=tool` 仍以原始记录为准。HARNESS 表示 Loop 运行控制中的一步，例如把模型提出的工具调用交给只读执行器；原始事件的 `kind` 是 `control`，不是一个 `role=harness` 的模型消息，也不额外增加模型调用。上下文准备（CONTEXT）、回执回填（RESULT）和停止控制（STOP）也属于 Harness 的职责，只是用更具体的标签展示。当前已支持连续任务对话、固定步骤讲解和证据定位。页面追问会继续执行 Agent；单独以轨迹为依据、且不继续执行任务的教学问答模式尚未接入。

## 换成自己的资料

先等当前任务结束，在启动终端按 `Ctrl+C`，再指定一个已经存在的目录：

```sh
go run . --workspace '/absolute/path/to/your-notes'
```

建议先选一个只含少量 `.md` 文件的目录。工具路径相对于这个工作区：列根目录使用 `.`，读取文件使用 `chapter.md`，不要把电脑上的绝对路径直接交给工具。目录列表不递归；新用户可以先把要比较的 Markdown 放在同一层。

可以尝试：

> 先列出工作区文件，比较 intro.md 与 tools.md 对 Tool Result 的定义。如果表述冲突，给出两处原文和修改建议。只读，不修改文件。

将文件名换成你自己的。当前只返回分析和建议，不会修改书稿。在当前页面点击“发送追问”会携带此前对话；左侧“新任务”用于从空历史另起对话。每次发送仍独立保存一份 Run，旧记录不会被覆盖。

## 三个学习实验

按 [练习卡](docs/learning-labs.md) 先预测、再运行、最后用轨迹解释。用 [记录表](docs/learning-checklist.md) 保存自己的答案；程序测试通过不代表学习者已经掌握。

| 实验 | 要理解的问题 | 本轮请求上限 |
|---|---|---|
| [请求额度与同批工具](docs/learning-labs.md#budget) | 一次模型响应能否执行两个工具，之后为什么停止？ | 1 |
| [错误回执与后续请求](docs/learning-labs.md#recovery) | 工具失败后，模型怎样收到错误并决定下一步？ | 6 |
| [连续对话与上下文](docs/learning-labs.md#conversation) | Turn 与模型轮次有什么区别，前文怎样进入下一次请求？ | 2 |

这些实验会真实调用模型。实际分支以记录为准；模型没有提出目标调用时，记录“未触发目标分支”，不要把预期填成运行事实。

## 保存、重启与配置

运行记录默认保存在 `.agent_state/runs/<run-id>/`，包括 `run.json`、`trace.jsonl` 与 `session.jsonl`。重启时核验所有有效、已结束的运行，列表保留轻量摘要，详情按需从原文件读取，不再限制为最近 8 条。无效或未结束的记录会跳过并提示，原文件保留。历史回看不会调用模型、重新执行工具或恢复任务。

```sh
go run . --port 8878 --workspace '/absolute/path/to/notes' --state-dir '/absolute/path/to/loop-runs'
```

| 参数 | 默认值 | 用途 |
|---|---|---|
| `--port` | `8877` | 本机网页端口 |
| `--workspace` | `workspace` | 只读资料目录 |
| `--state-dir` | `.agent_state/runs` | 运行记录目录 |

相对路径以启动命令所在目录为准。历史记录继续显示当时的工作区、模型和源码；更换模型影响后续模型请求；切换资料目录后应开始新任务，旧工作区的对话不能直接在新工作区继续。关闭网页不会取消已提交的任务，停止进程会中断仍在运行的任务。

也可以编译后运行；二进制嵌入网页，仍需单独提供资料目录和模型配置：

```sh
go build -o loop .
./loop --workspace ./workspace
```

## 常见问题

| 现象 | 检查方法 |
|---|---|
| `go: command not found` | 安装 Go，重新打开终端，确认 `go version` 可用 |
| 页面提示“模型配置未就绪” | 在启动服务的同一终端设置 Key 和模型；只创建 `.env` 文件不会自动加载。修改后重启服务 |
| 模型请求失败 | 点击失败的 `MODEL` 事件，检查错误类型和可用的 HTTP 状态；核对 Key、模型 ID、基础地址、额度及网络。当前单次请求超时 60 秒，不自动重试 |
| 工具返回 `tool_rejected` | 检查相对路径、文件是否存在、是否为普通 UTF-8 `.md` 文件，以及参数类型；该错误也可能表示权限边界拒绝 |
| 运行停在“模型请求额度耗尽” | 查看已执行步骤，可继续追问并为新一轮设置上限；旧轮次保留额度耗尽状态，不自动续跑 |
| `address already in use` | 已有服务占用端口，使用 `go run . --port 8878`，并打开对应地址 |
| 程序提示工作区不存在 | 确认在仓库根目录启动，或通过 `--workspace` 指定现有目录 |
| 改了代码但网页没变化 | TypeScript 修改后执行 `npm run build`，再重新编译或重启 `go run .`；查看旧运行仍会显示旧源码 |

## 当前范围与数据

Loop 是本机、单人、一次一个任务的早期项目。当前没有 Shell、文件写入、实时暂停、后台恢复、多 Agent 或插件系统。模型请求上限可选 1～8；每个 Run 的前 24 次工具调用尝试可以进入只读执行器，后续调用只返回额度耗尽的错误回执。工具失败不一定让整个 Run 立即结束。

密钥只用于后端模型请求，不发送到网页；工具读取的资料会作为上下文发送给你配置的模型服务。输入、输出和资料内容会保存在本地轨迹中，分享导出的 JSON 前请检查内容。状态目录默认不进入 Git，路径校验也不等同于操作系统 Sandbox。

## 开发与源码

只运行 Go 服务无需 Node；修改网页 TypeScript 时需要 Node/npm：

```sh
npm ci
npm run typecheck
npm test
go test -race ./...
```

`npm test` 会构建网页并检查批量调用、错误回执、重复调用 ID、预算停止和运行中状态的关联。`web/dist/` 的构建产物随源码提交，并由 Go 编译时嵌入。

| 文件 | 职责 |
|---|---|
| [agent.go](agent.go) | 模型请求循环、同批工具回执、停止条件 |
| [tools.go](tools.go) | 只读工具、参数及路径检查 |
| [model.go](model.go) | 模型 HTTP 请求、超时与错误转换 |
| [trace.go](trace.go) | 实际事件记录、工具额度及运行状态 |
| [storage.go](storage.go) | 日志、历史加载和源码快照 |
| [server.go](server.go) | 本机 HTTP 接口和单任务控制 |
| [conversation.go](conversation.go) | 校验上一轮完整消息，保留工具调用与回执配对 |
| [record.go](record.go) | 从真实 JSON 定位事件或字段，并在本机编辑器打开 |
| [web/src/app.ts](web/src/app.ts) | 同屏任务、关系图、步骤讲解和证据联动 |
| [web/src/trace-graph.ts](web/src/trace-graph.ts) | 从实际调用与消息构建可核对的关系 |
| [runtime_test.go](runtime_test.go) | 离线行为、路径边界、历史及 HTTP 检查 |

当前没有接入模型 API 返回的推理文本；页面的“说明”依据可观察事件生成，不冒充模型思考。

早期 Python 实现保存在 `python-reference` 标签中。有 Python 3.10+ 时可运行 `python3 -B scripts/check_python_reference.py` 做离线行为对照。详见 [Python 参考版本](docs/python-reference.md)、[架构决策](docs/adr/0001-go-runtime-typescript-ui.md)和[运行记录](docs/operations.md)。

## 参与与许可证

欢迎在 [Issues](https://github.com/unix2dos/loop/issues) 提交可复现的问题或具体学习实验，通过 Pull Request 提交改进。报告问题时请删除凭证和私人任务材料。

[MIT](LICENSE) · Copyright (c) 2026 Levon (unix2dos). Levon 为作者署名。
