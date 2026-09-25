# Loop

**运行 Agent，看清每一步。**

A local TypeScript coding agent workbench with real execution traces and source inspection.

在网页里提交任务，查看模型实际收到的消息、提出的工具调用，以及工具返回的结果。每一步都能展开原始记录和对应源码，便于排查错误、理解执行过程。

Loop 使用 TypeScript 和 Node.js，在本机运行。模型请求发送到你配置的 API 服务，运行记录保存在本机。

![Loop 的执行轨迹、工具回执与原始记录](docs/trace.png)

## 现在能做什么

- **读取笔记**：列出指定工作区的文件、读取 Markdown，在同一段对话中继续追问。
- **修复一个 TS 程序**：在独立练习副本中修改代码，运行容器内测试，核对实际 diff、输出和退出码。
- **检查执行过程**：按对话轮次查看模型请求、工具回执、耗时、API 返回的 token 用量和停止原因。
- **回看证据**：查看保存的源码快照、导出运行 JSON，或在本地编辑器中打开记录。回看不会重新执行任务。

目前是早期版本：普通对话只读 Markdown；代码修改和命令执行限于内置 TS 练习，同一时间运行一个任务。接入任意仓库和通用 Shell 尚未实现。

## 启动

需要 Git、[Node.js 24.12+](https://nodejs.org/) 和支持工具调用的 OpenAI Chat Completions 兼容 API。普通对话不需要 Docker。

```sh
git clone https://github.com/unix2dos/loop.git
cd loop
npm ci
npm run build
```

在同一个终端配置模型并启动。以下示例适用于 macOS / Linux 的 bash 或 zsh，请替换占位值：

```sh
export OPENAI_API_KEY='your-api-key'
export OPENAI_MODEL='your-model-id'
export OPENAI_BASE_URL='https://your-provider.example/v1'
npm start
```

打开 **[http://127.0.0.1:8877/](http://127.0.0.1:8877/)**，保持启动终端运行。

| 环境变量 | 用途 |
|---|---|
| `OPENAI_API_KEY` | 模型服务商的 API Key |
| `OPENAI_MODEL` | 该接口支持的模型 ID |
| `OPENAI_BASE_URL` | API 基础地址，不带 `/chat/completions`；未设置时默认 `https://api.openai.com/v1` |

这些变量名表示接口格式，不限制厂商。当前支持 Chat Completions，不支持直接使用 Responses 或 Anthropic Messages 地址。请求使用你自己的模型服务额度；Loop 不会自动读取 `.env`。

## 跑第一个任务

点击“新任务”，使用自带的示例笔记：

> 请调用 read_file 读取 agent-loop.md，引用一句原文说明工具回执如何进入下一次模型请求。路径相对于当前工作区。只读。

打开右侧轨迹中的 `read_file`，对照工具输出和模型回答。随后在同一个输入框追问，可以检查下一轮请求如何携带已有消息。

要读取自己的笔记目录：

```sh
npm start -- --workspace '/absolute/path/to/notes'
```

要试一次代码修复，先按[TS 修复练习说明](docs/coding-exercise.md)准备 Docker 和 Node 镜像，再选择“新任务 → 修复一个 TypeScript 程序”。授权后，Loop 只能修改练习中的 `average.ts`，测试在断网容器中执行。模型可能在预算内未完成任务，页面会保留真实结果。

运行记录默认保存在 `~/.loop/ts-runs/`。循环正常结束与测试通过，都需要结合实际结果判断任务是否完成。

## 公开实例

`LOOP_PUBLIC=1` 用于经 HTTPS 反向代理提供匿名体验，默认记录目录改为 `~/.loop/public-runs/`。容器镜像使用 `/data/loop-runs/`；部署时须为它挂载持久目录或卷，并将容器端口只绑定到反向代理可访问的位置。只提供公开示例笔记，模型密钥仅放在服务端环境中。

公开模式用浏览器 Cookie 隔离访客任务和轨迹，完成的记录保留 7 天；清除 Cookie 后无法找回旧任务。新访客每轮默认最多 6 次模型请求，每名访客每天最多 12 次，全站默认每天最多 100 次，可用 `LOOP_PUBLIC_DAILY_REQUESTS` 调低或调高。达到上限时停止调用模型，不自动换用付费模型。Coding 练习和本地编辑器在公开模式下关闭。

匿名访客可输入任意文本，所以公开实例必须使用允许面向终端用户的模型 API，并向访客说明内容会发送给模型供应商。免费模型的可用性、额度和实际工具调用效果须另行验证。

## 开发与验证

```sh
npm test             # 类型、运行行为、轨迹与会话检查
npm run test:docker  # 需要已准备的 Docker 镜像；不调用真实模型
```

修改前端后运行 `npm run build`。修改源码后重启服务，使执行代码、网页资源和源码快照保持一致。

- [从 Agent 循环读起](src/agent.ts)：模型请求、工具执行和停止规则。
- [三个观察实验](docs/learning-labs.md)：请求预算、错误回执与连续对话。
- [TS 修复练习](docs/coding-exercise.md)：文件权限、容器边界与验收方式。
- [迁移验收记录](docs/migration-typescript.md)：自动检查、真实模型验证及尚未通过的部分。

[MIT License](LICENSE)
