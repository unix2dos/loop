# Loop 语言选型调研：TypeScript 运行时与生态

核对日期：2026-09-17。范围：官方文档、官方仓库和包定义；没有安装依赖、运行付费模型、修改应用或重启服务。下文的方案判断是基于这些事实的推论，不是性能实测。

## 结论

全 TypeScript 是可行而有竞争力的方案，尤其适合快速发展网页交互、共享协议定义、直接复用现有 JS/TS Agent 库。它并不会天然消除前后端边界，也不会自动提供安全的模型工具参数。对于 Loop 当前“作者理解和控制内核第一、自己使用第二”的目标，作者读 Go 明显更顺，是 Go 内核加 TypeScript 界面的有力理由。

两者都能实现当前轨迹实验台。不能用“Agent 都在等模型”忽略本地开销，也不能用“Go 更快”推出一次远程模型任务会明显变快。需要把模型延迟、工具 I/O、本地 CPU、前端绘制和资源占用分开测量。

## 1. 全 TypeScript 的收益是真的，但有明确边界

共享 `Run`、`TraceEvent`、工具输入、状态枚举等类型，可以让前后端修改同一个定义、在编译时发现不一致；共享运行时 Schema 还能减少重复实现校验。这是全 TS 最强的工程理由。Zod 明确提供 `.parse()`/`.safeParse()` 运行时校验和类型推导，可以以 Schema 为共同来源。[TypeScript 类型说明](https://www.typescriptlang.org/docs/handbook/2/basic-types.html#erased-types)、[Zod 基础用法](https://zod.dev/basics)

但普通 TS 类型在编译后被擦除：把网络响应写成 `as TraceEvent` 不会验证它。模型返回的工具参数、HTTP 请求、历史 JSON 和第三方插件输入仍需要运行时验证。前后端使用同一种语言也不能免去序列化、请求失败、取消、版本兼容、身份验证和权限边界。[TypeScript 类型擦除](https://www.typescriptlang.org/docs/handbook/2/basic-types.html#erased-types)、[Zod 运行时解析](https://zod.dev/basics#parsing-data)

OpenCode 是直接反例：虽以 TypeScript 实现，SDK 仍连接 HTTP 服务，SDK 类型仍由服务端 OpenAPI 生成，事件通过 SSE 订阅。共享语言减少接口维护成本，不等于浏览器和内核成为同一个执行环境。[OpenCode SDK](https://opencode.ai/docs/sdk/)

对 Loop 的推论：只有少数接口时，Go 加 TS 的类型维护成本有限；当状态类型、插件接口、编辑器交互不断变化，共享类型的回报才会明显增大。可先用少量明确的 JSON 契约与契约检查控制漂移，确有重复维护问题后再引入 OpenAPI 生成，而不是先建生成平台。

## 2. Node 的并发能力与性能边界

Node 用事件循环与异步 I/O 处理网络等等待任务；长时间占用事件循环的 JS 工作会拖慢其他请求。异步不等于 CPU 工作自动并行。同步文件 API 也会阻塞事件循环；`fs/promises` 把文件操作交给底层线程池，但并发写同一个文件仍须处理顺序和数据一致性。[Node 不阻塞事件循环](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)、[Node 文件系统](https://nodejs.org/api/fs.html#synchronous-example)

`worker_threads` 能并行执行 CPU 密集的 JavaScript；Node 官方明确指出它对 I/O 密集任务帮助不大，内置异步 I/O 通常更合适。Worker 本身有创建和通信开销，CPU 工作持续增加时才值得考虑复用 Worker 池。[Node Worker Threads](https://nodejs.org/api/worker_threads.html)

对 Loop 的推论：少量会话、等待云端模型、读小文件，Node 足够成立；大历史文件解析、压缩、全文索引、海量事件转换若放在主循环上，则会影响事件推送和取消响应。Go 更容易把这些工作组织到可并行执行的协程中，但仍需避免无界并发、锁竞争和无限增长的记录。这里没有相同工作负载的 Go/TS 基准，不能提供可靠倍数。

“TypeScript 性能”不是完整表述。TypeScript 是语言层；后端实际运行在 Node、Bun 等运行时。OpenCode 的 Bun 构建方式不能直接当作 Node 性能或兼容性的证据。Bun 自己的文档说明其使用 JavaScriptCore，Node 的 Worker/API 行为则以 Node 文档为准。[Bun 可执行文件说明](https://bun.sh/docs/bundler/executables)、[OpenCode 包定义](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/package.json)

## 3. 三个代表项目实际证明了什么

| 项目 | 本次核对到的实际设计 | Loop 可以借鉴或复用什么 | 不应据此推出什么 |
|---|---|---|---|
| Pi | TypeScript 包体系；`pi-agent-core` 提供有状态循环、工具执行和事件；`pi-ai` 提供多提供商模型接口。agent-core 包要求 Node >=22.19.0。 | 可以直接嵌入 `Agent`，订阅事件、改变上下文转换、工具前后钩子与停止条件；也可单独学习其事件契约。 | 不能把嵌入现成内核等同于独立掌握设计，也不能假设默认权限符合 Loop。 |
| OpenCode | TypeScript 项目，包脚本使用 Bun 构建/开发/测试；SDK 面向运行中的服务，类型由 OpenAPI 生成。 | 使用 SDK 创建会话、发提示、订阅 SSE；或借鉴客户端与服务端边界。 | SDK 是驱动完整服务的客户端，不等于可随意拆开的极小循环库。 |
| DeepSeek Harness | Node + TypeScript + Cordis；模型、工具、会话和循环都作为插件；SDK 通过换行分隔 JSON-RPC 驱动子进程。 | 借鉴轨迹、持久会话事件、状态投影和可观察性；可用 SDK 作为外部 Harness。 | 不能因喜欢它的轨迹界面就把其插件树全部搬进 Loop。仓库仍标为 Developer Preview，明确预告兼容性破坏。 |

来源：[Pi 总览](https://github.com/earendil-works/pi)、[Pi agent-core API](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)、[Pi agent-core 包定义](https://github.com/earendil-works/pi/blob/main/packages/agent/package.json)、[OpenCode 包定义](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/package.json)、[OpenCode SDK](https://opencode.ai/docs/sdk/)、[DeepSeek 架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)、[DeepSeek SDK](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/README.md)、[DeepSeek 预览状态](https://github.com/deepseek-ai/deepseek-harness)

Pi 的 `Agent.subscribe`、`beforeToolCall`、`afterToolCall`、`shouldStopAfterTurn` 和低层 `agentLoop` 是具体可复用点。不过低层事件流是观察性流，异步事件消费者并不阻止生产者继续；较高层 Agent 的订阅具有等待语义。这也说明“有轨迹事件”与“能单步暂停”不是同一个能力。[Pi agent-core API](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)

## 4. TS 模型 SDK、工具和 MCP 生态

Anthropic 官方 TS SDK 支持服务器端 TS/JS，并列明 Node、Bun 等运行环境。其浏览器模式默认关闭以避免泄露 API key；全 TS 并不意味着把模型凭证移到浏览器。[Anthropic TS SDK](https://github.com/anthropics/anthropic-sdk-typescript)

Vercel AI SDK 的工具定义可使用 Zod 或 JSON Schema；同一个输入 Schema 用于说明模型工具参数和验证工具调用，`execute` 参数还能获得类型推导。这种库内联动是 TS 生态的真实便利。[AI SDK 工具定义源文档](https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-core/15-tools-and-tool-calling.mdx)

MCP 官方 TS SDK 当前主分支为稳定 v2，分为 client/server 包，支持 Node、Bun、Deno，工具和提示 Schema 采用 Standard Schema。但 Go 也有官方 MCP SDK，包含 client/server 与 JSON-RPC、认证包；“支持 MCP”不是必须选择 TS 的理由。[MCP TS SDK](https://github.com/modelcontextprotocol/typescript-sdk)、[MCP Go SDK](https://github.com/modelcontextprotocol/go-sdk)

推论：如果 Loop 的产品重心转为直接复用 Pi、在进程内加载 JS/TS 插件、贡献现有 TS Agent 生态，全 TS 会减少适配。若只是通过标准协议接工具，Go 内核同样成立。选择跨进程插件还能明确故障与权限边界，不能把同进程加载插件自动视为更安全。

## 5. 单文件分发：Go 有优势，但不是独占能力

Go 的 `embed` 可在编译时把 HTML、CSS、JS 等文件放进程序。由 Go HTTP 服务交付构建后的前端，可以把后端与网页产物作为一个应用发布；前端开发阶段的工具链并未因此消失。[Go embed](https://pkg.go.dev/embed)

Node 已有官方 SEA。核对到的 v26.9.0 文档中，`--build-sea` 在 v25.5.0 引入，支持打包脚本和资源，目标机器无需安装 Node；SEA 仍标为 Active development。默认注入脚本的模块加载有约束；v26.9.0 的 VFS 又是 Early development，不能和 snapshot/code cache 同时使用，原生 `.node` 扩展需要落到真实文件后加载。跨平台构建还要关闭不兼容的 code cache/snapshot。因此应按实际采用的 Node 版本核对，不能把最新文档直接套给 Node 22/24 LTS。[Node SEA](https://nodejs.org/api/single-executable-applications.html)

Bun 的 `bun build --compile` 可以把运行时和服务端代码编进可执行文件；导入 HTML 时还能打包前端 JS/CSS 并嵌入，官方示例明确展示了全栈单文件分发。Worker 入口目前需要显式列入构建，外部工具与动态读取文件等仍应逐项验证。[Bun 可执行文件与全栈打包](https://bun.sh/docs/bundler/executables)

推论：Go 的优点是用作者熟悉的工具链建立清晰的服务与发布路径；不能用“TS 必须让用户装 Node”作为决定性理由。所有方案都仍需按目标 OS/架构发布并验证，应用调用的外部命令也不会因为宿主打成单文件就自动包含进去。

## 6. 对 Loop 的选择条件

**全 TS 更合适的条件：**作者愿意用 TS 理解内核；网页和插件协议成为主要迭代量；确实准备复用 Pi/AI SDK 等 TS 包；或未来贡献者主要来自 TS 生态。此时共享 Schema、工具和编译检查可能比 Go 语言熟悉度更值钱。Node 与 Bun 再按真实依赖、分发和测试结果选，不必同时兼容两套。

**Go 内核 + TS 界面更合适的条件：**理解和独立修改内核仍是第一目标；作者读 Go 明显更快；本机任务管理、取消、进程与文件边界是重点；目前接口数量少且稳定。界面使用 TS，并不要求内核也用 TS。代价是两套工具链和接口契约维护，需明确接受。

**暂留 Python 更合适的条件：**只想立即完成已规划的三个学习实验，暂时不投入迁移。这个选项保住已验证行为，但“已经写过”不能压过作者长期学习成本。

本次建议：优先讨论 Go 内核 + TS 界面，保留全 TS 为强备选。接受建议后，以现有只读任务、拒绝越界工具、预算停止、轨迹保存与历史读取作为迁移验收集；只迁移等价闭环，不同时重做 UI、增加插件体系或引入多 Agent。性能判断另设小型测量：无模型空循环、本地工具耗时、固定轨迹回放、峰值 RSS、事件到界面的延迟，再与真实模型耗时分开报告。
