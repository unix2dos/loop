# Loop

**运行 Agent，看清每一步。**

A local workbench for running an agent and inspecting every model request, tool call, and receipt.

Loop 是本机学习工作台。你提交任务，它调用模型、列出文件、读取 Markdown，并把工具回执送回模型。网页里可以看到每一次请求、工具结果、耗时、停止原因，以及对应源码。

当前只读指定目录中的 Markdown，不能写文件，也不能跑 Shell。

![一次运行的时间轴、事件和原始模型请求](docs/trace.png)

## 最短启动

需要 Git 和 [Go 1.24+](https://go.dev/doc/install)。模型接口须兼容 OpenAI Chat Completions，并支持工具调用。

```sh
git clone https://github.com/unix2dos/loop.git
cd loop
export OPENAI_API_KEY='your-api-key'
export OPENAI_MODEL='your-model-id'
export OPENAI_BASE_URL='https://your-provider.example/v1'
go run .
```

浏览器打开 [http://127.0.0.1:8877/](http://127.0.0.1:8877/)。换成自己的目录时加上 `--workspace '/absolute/path/to/notes'`。

| 变量 | 填什么 |
|---|---|
| `OPENAI_API_KEY` | 模型服务商的 API Key，不是网页登录密码 |
| `OPENAI_MODEL` | 该接口的模型 ID |
| `OPENAI_BASE_URL` | API 基础地址，不要带 `/chat/completions`。未设置时默认 `https://api.openai.com/v1` |

变量名只表示接口格式，不限制厂商。当前只实现 Chat Completions，不能直接使用 Responses 或 Anthropic Messages 地址。

<details>
<summary>示例：OpenCode Go + GLM-5.3-Flash</summary>

```sh
export OPENAI_API_KEY='your-opencode-go-api-key'
export OPENAI_MODEL='glm-5.3-flash'
export OPENAI_BASE_URL='https://opencode.ai/zen/go/v1'
go run .
```

模型 ID 和地址见 [OpenCode Go](https://opencode.ai/docs/go/#endpoints)。该组合已在本项目中完成真实工具调用验证。Loop 自己跑 Agent 循环；OpenCode Go 只提供模型 API。客户端会发送 User-Agent 和稳定会话 ID，符合其[接入要求](https://opencode.ai/docs/go/#where-can-i-use-it)。

</details>

## 第一个任务

默认工作区是自带的 `workspace/`。点击「新任务」，请求上限保持为 **4**，粘贴：

> 先列出工作区文件，再读取 agent-loop.md。用两句话说明工具结果怎样返回模型，并引用一处原文作为依据。

点「开始任务」。通常会看到「请求模型 → 列出文件 → 再次请求模型 → 读取笔记 → 最终回答」。对照右侧轨迹核对引文。

## 练习

想先预测再看轨迹，用 [练习卡](docs/learning-labs.md)。

## 启动失败

| 现象 | 检查 |
|---|---|
| `go: command not found` | 安装 Go 1.24+，新开终端后运行 `go version` |
| 页面提示「模型配置未就绪」 | 在启动服务的同一终端设置三个变量。只创建 `.env` 不会自动加载 |
| `address already in use` | `go run . --port 8878`，打开对应地址 |
| 程序提示工作区不存在 | 在仓库根目录启动，或用 `--workspace` 指定已有目录 |

## 开发

修改网页 TypeScript 时需要 Node/npm；只运行 Go 服务不需要。

```sh
npm ci
npm run typecheck
npm test
go test -race ./...
```

## 许可证

欢迎在 [Issues](https://github.com/unix2dos/loop/issues) 提交可复现的问题。报告时请删除凭证和私人材料。

[MIT](LICENSE)
