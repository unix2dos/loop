# Loop 语言选型：Go 运行内核与 TypeScript 界面

调研日期：2026-09-17。范围：官方语言文档、厂商 SDK 与框架仓库；没有迁移业务代码、安装依赖、调用模型或重启服务。下文区分可核实事实与本项目判断，不使用跨语言微基准推导 Agent 端到端加速倍数。

## 结论与理由顺序

**对 Loop，Go 内核 + TypeScript 网页是更值得优先验证的长期方案。最强理由是作者读 Go 最顺，而核心目标是独立理解和修改 Agent；其次是运行控制与本机分发；CPU 性能排在后面。** 这是依据本次用户目标作出的判断，不是 Go 对所有 Agent 都最优。

1. 用户已经明确 Go 最熟悉。学习内核要反复阅读循环、工具边界、停止与恢复，熟悉的语言可以减少额外语法负担。继续使用 Python 的“已有实现”优势是短期迁移成本，不应成为永久选择。
2. Go 的标准库覆盖 HTTP、取消和超时、进程管理、文件及并发，足够支撑 Loop 当前小内核。无需为了改语言马上引入一个编排框架。[context](https://pkg.go.dev/context)、[net/http](https://pkg.go.dev/net/http)、[os/exec](https://pkg.go.dev/os/exec)
3. 网页仍用 TypeScript。Go 可以服务编译后的静态网页，不需要额外 Node 服务；开发阶段仍需前端构建工具。这给作者保留熟悉的后端，同时保留网页生态。[embed](https://pkg.go.dev/embed)、[http.FileServer](https://pkg.go.dev/net/http#FileServer)
4. 性能应计量，但不能因为 Go 通常适合高并发服务，就许诺模型请求更快。先分开记录模型等待、工具耗时、内核开销、网页呈现延迟，再判断瓶颈。[Go 诊断工具](https://go.dev/doc/diagnostics)
5. 保留当前 Python 基线及历史数据作为行为参考，做小范围等价迁移，再判断学习效果；这项建议尚未执行。

## Go 对运行内核的实际帮助与边界

| 能力 | 官方资料建立的事实 | 对 Loop 的判断与限制 |
| --- | --- | --- |
| 并发 | goroutine 复用操作系统线程，阻塞时可调度其他 goroutine；`GOMAXPROCS` 限制同时执行 Go 代码的线程数量。[Go FAQ](https://go.dev/doc/faq#goroutines) | 适合多个独立工具、事件订阅者、取消监听。只有任务本来独立时才能并发；文件写入等有顺序关系的工具不能见到 goroutine 就并发。 |
| 取消、超时 | `context` 传播 deadline 和取消；取消函数只发出停止信号，不等待工作结束。[context](https://pkg.go.dev/context) | 一次 Run 可拥有 context，把它传入模型调用和工具。仍须各执行函数遵守信号、等待退出并记录结果；取消无法撤回已发生的远端副作用。 |
| HTTP / SSE | `net/http` 支持 HTTP 服务；默认 HTTP/1.x、HTTP/2 ResponseWriter 支持 Flush，但包装器及代理可能影响刷新。[Flusher](https://pkg.go.dev/net/http#Flusher) | 可以用标准库输出 SSE，无须专门 WebSocket 框架。事件排序、重连位置、慢客户端与积压仍要设计；当前轮询没有被证明是瓶颈，可先保留。 |
| 子进程 | `exec.CommandContext` 默认在取消时调用当前进程的 Kill；`os/exec` 本身不会替你启动 shell 展开命令。[os/exec](https://pkg.go.dev/os/exec#CommandContext) | 后续 shell 工具可接入相同取消链，但不应宣称自动终止整棵子进程树或提供沙箱。进程组、权限和跨平台差异需要单独处理。当前工具仍应保持只读范围。 |
| 静态网页 | `//go:embed` 在编译时包含文件，可由 `http.FileServer` 服务。[embed](https://pkg.go.dev/embed) | 可以把前端构建产物嵌入二进制；用户运行时不必为网页安装 Node。嵌入是只读快照，运行日志仍应写入外部状态目录。 |
| 分发 | Go 构建支持按 `GOOS`、`GOARCH` 选择目标；cgo 交叉编译需要对应 C 编译器，且交叉编译时默认关闭 cgo。[构建环境](https://go.dev/doc/install/source#environment)、[cgo](https://pkg.go.dev/cmd/cgo) | 可以提供不同系统/架构的二进制；并非一个文件在所有系统运行。外部 git、浏览器、shell、动态库、证书与操作系统授权也不会因编译自动消失。 |

Go 不是自动可靠的 Agent 语言。共享状态仍可能有 data race；官方提供 race detector，而不是保证并发程序天然正确。[Race Detector](https://go.dev/doc/articles/race_detector) 幂等键、副作用确认、unknown 状态、持久化一致性、权限检查和任务验收都属于应用设计，不能交给 goroutine 或静态类型代替。

## SDK 与框架：Go 已有现实选项，不能把存在等同于完备

以下版本是调研日可观察的发布记录，不是给 Loop 自动升级或引入依赖的建议。

| 项目 | 可核实事实 | 对选型的意义 |
| --- | --- | --- |
| OpenAI Go SDK | OpenAI 官方 SDK 页面提供 Go Responses 示例，文档仍标记 Go helper 为 beta；同一页的 Agents SDK 列出 Python 与 TypeScript。[OpenAI Docs](https://developers.openai.com/api/docs/libraries) | Go 可以直接调用模型 API；“官方 Go API SDK”不等于“官方 Go Agents SDK”。若以官方 Agents SDK 编排能力为核心需求，TS/Python 有直接路径。 |
| Anthropic Go SDK | 官方仓库提供 `client.Messages.New(context, ...)` 示例，README 要求 Go 1.24+；最新观测发布为 v1.73.0（2026-09-15）。[固定 README](https://github.com/anthropics/anthropic-sdk-go/blob/394d2534592b686cc78470b2b0f3d5a0d3ceb86c/README.md)、[版本](https://github.com/anthropics/anthropic-sdk-go/releases/tag/v1.73.0) | 主流模型接入无需自己从零实现 HTTP 协议；具体流式、重试、工具语义仍需针对采用版本验证。 |
| Google Gen AI Go SDK | Google 官方仓库提供 Gemini Developer API 及企业平台客户端；最新观测发布 v1.71.0（2026-08-31），当前 README 明确提醒部分视频 API 的未来变更。[固定 README](https://github.com/googleapis/go-genai/blob/f11e463276f25be258f6d4c354fcd89459216f8f/README.md)、[版本](https://github.com/googleapis/go-genai/releases/tag/v1.71.0) | Go 可以接 Gemini，但厂商 SDK 仍会演进，应固定版本。不能把多模型支持简化成改一个 base URL。 |
| MCP Go SDK | MCP 官方 Go SDK，含 client/server、stdio 及协议文档；v1.8.0 于 2026-09-14 发布。当前兼容表列出支持的协议版本，并注明部分客户端 OAuth 支持仍为实验性。[固定 README](https://github.com/modelcontextprotocol/go-sdk/blob/3785c500b581ad76bc5a74e9f84d8feeb89fef27/README.md)、[版本](https://github.com/modelcontextprotocol/go-sdk/releases/tag/v1.8.0) | 接 MCP 工具没有语言阻断。MCP 是连接协议，不负责替 Loop 决定权限、预算或业务成功。 |
| Google ADK Go | 官方定位为 Go Agent 开发、部署与编排工具包，支持工具及多 Agent 组合；最新观测发布 v2.4.0（2026-09-11）。[固定 README](https://github.com/google/adk-go/blob/f7e16e0226d8a255e39543df2fdfc0e15041de51/README.md)、[版本](https://github.com/google/adk-go/releases/tag/v2.4.0) | Go 有正式框架路径，不能说 Go 无生态；没有做与 Python/TS 的逐功能对等测试，因此不声称完全一致。 |
| CloudWeGo Eino | 提供 ChatModel、Tool 等组件、图编排、流式处理、回调、中断/恢复和 ADK。观测到 v0.9.19 与 v0.10.0-alpha.29；GitHub 发布标志不一定与 tag 中的 alpha 字样一致，不能据 latest 标志称其稳定。[固定 README](https://github.com/cloudwego/eino/blob/9d983b36a5112a1c233056b1a099825298fafb8f/README.md)、[v0.9.19](https://github.com/cloudwego/eino/releases/tag/v0.9.19)、[alpha](https://github.com/cloudwego/eino/releases/tag/v0.10.0-alpha.29) | 可以作为源码学习和未来复用对象。当前学习循环是否应该被其封装，属于教学取舍；并非有框架就应该立刻采用。 |

上述事实只能证明“Go 的可用接入与框架并不缺位”。它们不能证明某语言生态第一、适合所有厂商最新能力、维护成本更低，或 Agent 结果更好。

## 性能要考虑，但要分别计算

对顺序执行的一次运行，可用 `总耗时 = 模型等待 + 工具等待 + 本地内核处理 + 排队/呈现开销` 作为近似分解。并发执行时应看关键路径，不能把重叠 span 直接相加。这是测量方法建议，不是已有基准结果。

- **CPU/吞吐**：大量事件解析、检索预处理、压缩、多个活跃运行时，本地 CPU、GC、内存、锁竞争可能变重要。Go 值得测试，但具体收益必须用同等工作负载测得。[Go profiling / execution tracing](https://go.dev/doc/diagnostics)
- **单任务等待**：如果绝大部分时间花在远端模型生成，换语言不会让远端模型自动更快。假设仅 1% 是可优化本地时间，即使把这一部分降至零，总时长也最多减少 1%；这是数学上限示例，不是 Loop 实测比例。
- **工具执行**：如果真正运行的是 git、编译器或浏览器，Go 改变的是编排与进程管理，不会自动加速外部程序内部工作。
- **交互延迟**：轨迹要等整轮响应回来才显示，可能是没有消费流式事件；网页看起来卡，也可能是长列表渲染。需要看具体路径，不能都归因于 Python。
- **容量与成本**：CPU 时间、常驻内存、任务并发、p95 首事件时间、取消退出时间，应与单任务总耗时分别记录；不能以其中一个替代全部“性能”。

本次没有运行跨语言基准，所以不报告“Go 快几倍”。现有 Python 单次轨迹也不足以证明未来高并发容量，但可以帮助确认当前主要等待发生在哪。

调研时的 Python 实现还存在与语言无关的性能变量：[`index.html:113`](python-reference.md) 每 650ms 轮询；[`app.py:342`](python-reference.md) 对运行做完整 deepcopy 后返回；数据含输入消息及源码；[`agent.py:13`](python-reference.md) 每次写日志调用 fsync；[`app.py:290`](python-reference.md) 主动限制一次一个运行。这些策略不因改成 Go 自动改变。当前规模可以接受的实现，扩大规模后再按测量改为增量事件、避免重复传源码或调整持久化策略；修改 fsync 尤其涉及耐久性取舍，不能只为速度直接删掉。

### 源码讲解能力必须保留

当前 [`app.py:75`](python-reference.md) 通过 Python `inspect.getsourcelines` 在运行开始时保存函数源码，网页展示该次运行的快照。迁移不能假定 Go 反射能取得函数源码。建议把少量用于学习的 Go 源文件随构建一起 `embed`，通过固定的源码区域标记或 Go 标准库 AST 定位函数；每次运行保存对应代码文本、构建版本和内容 hash，历史记录继续显示当时的代码。`embed` 官方说明它读取编译时的文件，因此可用作这份构建所带的学习源码，而非运行时任意工作区里的最新文件。[embed](https://pkg.go.dev/embed)、[go/parser](https://pkg.go.dev/go/parser)

## Go + TypeScript 的接口成本怎样控制

以下是按 Loop 当前规模提出的最少措施，并非已实现设计：

1. 保持单个仓库、一个后端服务、一个网页构建。前后端同源服务，先不引入微服务或另一个 Node 后端。
2. 只在边界交换稳定的小型 JSON：提交任务、运行摘要、轨迹事件。运行内核、消息裁剪、工具授权、持久化始终由 Go 决定；界面只负责展示和用户操作。
3. 当前接口很少，先在一个地方集中 Go DTO 和一个 `api.ts` 中的对应类型，用一组真实 JSON 合约样例覆盖序列化/读取，避免上来就建设代码生成平台。若字段增长或多客户端造成重复错误，再选单一 JSON Schema/OpenAPI 生成类型。
4. 即使用统一 TypeScript，网络传入数据仍必须在运行时校验：TS 类型会在编译时擦除，类型声明不改变运行时行为。[TypeScript 官方说明](https://www.typescriptlang.org/docs/handbook/2/basic-types.html#erased-types)
5. 给历史轨迹一个格式版本，把 Go 错误转换为明确的事件状态和可读说明；不要向界面直接暴露厂商 SDK 的全部对象。是否需要精确的单调序号与事件增量订阅，应由复盘、重连等需求确定。

全栈 TypeScript 确实可以让前后端导入同一份类型和纯逻辑模块，减少重复定义；Go + TS 接受了这一额外接口成本。因此选择 Go 的理由应是核心理解、维护与运行目标更重要，不能假装双语言没有代价。

## 反对 Go + TS 的最强论证

1. 如果未来大部分工作是网页交互、演示编辑器和 JS 插件，运行内核很薄，那么 Go 可能只是增加一种工具链和一次接口映射。全栈 TS 更直接。
2. 如果必须深度复用某个 TS-only Agent SDK/插件生态，把它放在 Go 进程外会产生额外 IPC、部署和调试成本；这可能超过 Go 带来的熟悉度优势。
3. 若核心研究转向训练、科学计算或特定 Python-only 库，Python 更值得留在对应模块。为了语言纯洁性重写成熟工具通常不划算。
4. 现有 Python 原型已能工作。一次大重写会引入回归、打断学习，而且“换语言后页面能开”不足以证明工具安全、历史记录、停止原因都等价。
5. Go 的静态类型与错误处理也会增加样板代码；不能仅以少量示例更好读，推断整个多厂商适配系统永远更简单。

**会改变结论的条件**：用户实际更愿意理解 TS；产品转为主要由浏览器/JS 插件驱动；关键能力只有 TS/Python SDK 可用；实测双语言接口维护持续超过收益；或已有 Python 学习循环已经充分有效、迁移收益未能显示。

## 建议的验证方式

先得到语言方向确认，再把同一只读任务和三种停止/失败场景作为验收标准，迁移一次小闭环；前端、任务、模型、工具权限和日志内容尽量保持一致。逐一对照模型输入、工具回执、预算停止、路径拒绝、历史读取、异常与取消。让作者用 Go 代码解释一次真实轨迹，再判断是否比 Python 更容易独立修改。

预期 ROI：对当前作者的长期理解与维护为高；对当前单任务速度为未知或小；对未来本机发布为中高；对立即获得 Stars 没有可验证保证。ROI 是条件判断，不是实测回报。调研本身不授权迁移。
