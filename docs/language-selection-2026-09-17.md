> 历史资料：本文记录全 TS 迁移前的研究或验收。所引用的旧代码保存在 Git 提交 `4cb0a3b` 及更早历史中；当前运行方式以项目 README 为准。

# Loop 技术栈选型调研

日期：2026-09-17。用户已认可 Go 内核 + TypeScript 网页路线，已记录为 [ADR-0001](adr/0001-go-runtime-typescript-ui.md)。本文保留调研时的证据与判断；后续实施已迁移入口，参见[当前启动说明](../README.md)及[Python 对照版本](python-reference.md)。调研与后续实施是不同阶段。

## 结论

建议长期方向为 **Go 运行内核 + TypeScript 网页**，全 TypeScript 为强备选，现有 Python 保留为行为对照基线。

理由按优先级排列：作者最熟悉 Go，首要目标是独立理解内核；Go 的运行控制与本机工具开发方式适合这个方向；浏览器交互继续利用 TypeScript；当前跨语言接口很小，双语言成本可控；性能值得验证，但不能先承诺端到端加速。

此前选 Python 的依据主要是复用书籍代码、尽快验证闭环。它证明了产品形式可以工作，没有证明 Python 是最适合作者长期学习与维护的语言。用户明确“Go 更顺”后，继续让短期复用成本决定长期路线不合适。

## 证据边界

- 用户事实：最熟悉 Go，希望少手写，由 AI 解释核心代码，最终自己能作设计判断。即使 AI 写多数代码，作者仍要审查、排错和作取舍。
- 当前代码：agent.py 227 行、app.py 426 行、client.py 48 行、check.py 236 行、index.html 163 个物理行。HTML 含压缩的 CSS/JS，不能用总行数估算真实复杂度或迁移工时。
- 当前状态：只读、本机、单活跃任务；基线提交 0358008。历史加载修改离线通过，浏览器验收因本机服务问题暂停；超时原因未知，不能归咎于 Python。
- 外部事实依据官方语言文档、SDK、项目源码；详细来源分别见 research-go-runtime.md 与 research-typescript-runtime.md。
- 本地实验只测一项 JSON 处理操作，不能替代端到端、并发、内存、取消或长期稳定性测试。

## 1. 先考虑作者能否掌握核心

学习目标是能解释：哪些材料进入模型、谁批准工具、结果如何进入下一轮、何时停止、失败如何定位。使用熟悉的 Go，预计能减少语法与语言惯例造成的认知负担；这是一项与当前用户目标直接相关的收益。

AI 代写减少输入代码的工作量，不减少作者理解代码和判断正确性的责任。这个前提使“前后端统一语言”需要与“后端作者最熟悉什么”一起衡量，而不能只按仓库中语言数量作决定。

## 2. 性能必须拆开衡量

| 指标 | Go 的潜在价值 | 不能由语言自动获得的结果 |
| --- | --- | --- |
| 一次任务的总等待 | 减少可优化的本地计算，改善排队或运行组织 | 不会自动缩短远端推理、网络或外部工具本身的耗时 |
| 多任务吞吐 | goroutine 与多核执行便于组织并发工作 | 仍需控制并发、限流、锁与供应商额度 |
| 内存和本地 CPU | 原生编译、类型化数据结构值得测量 | 对象表示、SDK、缓存和日志策略仍可能主导成本 |
| 网页响应 | 更及时地产生和交付事件 | 全量轮询、重复数据与长列表渲染仍会拖慢界面 |
| 取消、退出 | context 可贯穿网络和工具调用 | 取消必须被下游处理，不会撤回已经发生的副作用 |

Go goroutine 的调度与多核能力见 [Go FAQ](https://go.dev/doc/faq#goroutines)。Node 本身适合异步 I/O；CPU 密集工作与同步 API 会阻塞事件循环，必要时可使用 Worker Threads。[Node 事件循环](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)、[Worker Threads](https://nodejs.org/api/worker_threads.html)

### 现有真实轨迹

| 运行 ID 前缀 | 总运行时长 | 模型调用 span 合计 | 工具 span 合计 |
| --- | ---: | ---: | ---: |
| 3d29733c | 19.9581s | 19.9488s | 0.0016s |
| 13033aa0 | 23.5368s | 23.5259s | 0.0019s |
| 940ee4d9 | 43.9544s | 43.9368s | 0.0024s |

模型调用 span 包含 SDK、网络、供应商推理及少量记录开销，并非纯模型推理时间。这些串行样例只能说明当前主要跨度位于模型调用路径，不能证明 Go 没有价值，更不能说明未来并发容量。没有同任务、同模型条件的跨语言完整实现对照，不能报告端到端加速倍数。

### 本机 JSON 小测

用一份真实轨迹和一份合成大轨迹做解码再编码，7 批中位数如下：

| 运行时 | 34,835 字节真实输入 | 823,971 字节合成输入 |
| --- | ---: | ---: |
| Go 1.24.13 | 0.271ms | 7.456ms |
| Node 26.7.0 | 0.114ms | 2.827ms |
| Python 3.14.7 | 0.212ms | 5.905ms |

这个反例说明 Go 不会在每项工作中自动更快。Go 测的是 encoding/json v1 的通用对象，不是优化的 typed struct；标准库、版本、键排序和编码方式也不同。它不支持把上述顺序推广为语言排名。完整方法、结果和可执行脚本见 [JSON 小测](benchmarks/json-roundtrip/README.md)。本轮没有测峰值内存、HTTP 吞吐或 p95/p99，不能给这些指标下结论。

### 当前更直接的性能变量

当前每 650ms 拉取整个 run，服务端 deepcopy 后序列化；数据包含重复的上下文与源码。每条记录同步 fsync，另有单活跃任务锁。这些都是实现策略，不是 Python 的必然属性。

后续应分别测量本地处理时间、事件可见延迟、峰值内存、取消退出时间和并发吞吐。按瓶颈决定是否采用增量事件、按需加载大字段、减少重复源码。修改落盘策略必须明确崩溃时可能丢失什么，不能为了速度无条件删除 fsync。

## 3. 全 TypeScript 的最强理由

全 TS 可以让网页与后端导入同一份运行、事件、工具类型；用运行时 Schema 作为共同来源还能降低类型与校验漂移。Pi 的 agent-core、Vercel AI SDK 等可以直接作为 TS 依赖复用；如果主要工作变成网页、编辑器和同进程 JS/TS 插件，全 TS 的优势会进一步增加。[Pi agent-core](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)、[AI SDK 工具定义](https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-core/15-tools-and-tool-calling.mdx)、[Zod](https://zod.dev/basics)

但浏览器与服务仍是不同执行环境，HTTP、序列化、权限和版本兼容并不消失。TS 类型编译后被擦除，不能用类型断言代替验证模型工具参数或历史 JSON。[TypeScript 类型擦除](https://www.typescriptlang.org/docs/handbook/2/basic-types.html#erased-types)

OpenCode 虽以 TS 为主，其 SDK 仍通过 HTTP 控制服务，类型从 OpenAPI 生成，事件通过 SSE 订阅。DeepSeek SDK 则以 JSON-RPC 驱动进程。由此不能把“全 TS”理解为“没有通信与契约成本”。[OpenCode SDK](https://opencode.ai/docs/sdk/)、[DeepSeek SDK](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/README.md)

对 Loop 而言，代价是需要作者持续理解一个较不熟悉的内核语言。当前只有少量接口，还没有决定依赖 TS-only 插件/内核包，统一类型的收益不足以单独压过 Go 熟悉度。这是项目判断，不是否定 TS。

## 4. Go + TS 的工程方案

建议保持一个仓库、一个 Go 后端进程和一个网页。网页使用 TypeScript，后端保持模型调用、工具规则、预算、状态与持久化的所有权。

| 范围 | 建议 | 说明 |
| --- | --- | --- |
| 运行内核 | 小型 Go 实现 | 先等价迁移当前循环与只读工具，不同时引入大型编排框架 |
| HTTP 与运行生命周期 | Go 标准库 | Run 生命周期与网页连接分开；后续显式取消沿 context 传给模型及工具 |
| 网页 | TypeScript，保留 A 布局 | 首先保留 DOM/CSS 实现；界面复杂度确有需要时再引入 React，而非随换语言重做整站 |
| 前后端协议 | 集中 DTO + api.ts + JSON 合约样例 | 当前接口小；出现重复维护问题后再选 OpenAPI/JSON Schema 生成 |
| 轨迹 | 明确版本、顺序与阶段的事件记录 | 对外使用稳定领域字段，保留可核对的原始输入输出 |
| 存储 | 保留 JSON/JSONL | 先保持历史兼容；查询、并发写入等需求出现后再考虑 SQLite |
| 分发 | 编译网页产物后由 Go embed 提供 | 开发阶段仍需前端工具链；用户运行时可只启动对应平台二进制 |
| 源码侧栏 | 构建时嵌入学习源码及版本 | Go 反射不能代替 Python inspect 取得函数源文；历史应关联执行版本的代码 |

Go 的 context、net/http、os/exec、embed 可以覆盖这些基础职责。[context](https://pkg.go.dev/context)、[net/http](https://pkg.go.dev/net/http)、[os/exec](https://pkg.go.dev/os/exec)、[embed](https://pkg.go.dev/embed)

Go 已有官方模型 SDK、MCP SDK，以及 ADK Go、Eino 等框架选项，详见 Go 侧研究；不存在“Agent 必须用 Python/TS”的语言限制。不过 API SDK、Agent 编排 SDK和完整 Agent 产品必须区分，不能认为它们逐项等价。

单文件发布不是 Go 独占：Node 有 SEA，Bun 的 compile 支持嵌入前端。Node 新功能需按实际版本和成熟度核对，所有方案都需要按操作系统与架构发布并验证。[Node SEA](https://nodejs.org/api/single-executable-applications.html)、[Bun 可执行文件](https://bun.sh/docs/bundler/executables)

## 5. 何时改变结论

| 决策条件 | 更合理的选择 |
| --- | --- |
| 当前目标：作者最熟 Go，独立理解和控制内核优先 | Go + TS |
| 重点转为网页/JS 插件，准备直接复用 Pi/AI SDK，作者愿意深读 TS 内核 | 全 TS |
| 只想立即完成三项学习实验，暂不投入迁移 | 现有 Python |
| 关键任务依赖 Python 科学计算/训练库 | 让对应工具使用 Python，不必强制整个系统统一语言 |

学习和长期维护的预期 ROI：Go + TS 较高。当前单任务速度提升：未知，预计不能仅靠换语言获得数量级提升。统一类型与 TS 生态复用收益：全 TS 较高。立即获得外部用户或 Stars：没有可验证保证。

## 6. 建议推进顺序

1. 用户已确认长期语言方向。保留 0358008 基线及尚未提交的历史加载工作，不覆盖现有记录。
2. 固定现有工具回执、批量调用、预算停止、路径拒绝、错误回传与历史只读加载的行为契约，用同一批固定模型响应和真实文件验证。
3. 只迁移 Go 后端，先让现有网页继续工作；保留之前的模型配置与任务条件。
4. 将网页脚本转 TS，集中协议类型，保持已确认的视觉与交互。
5. 原有三个学习实验由作者先预测、再运行、再解释；判断 Go 是否降低独立判断的困难。
6. 按指标决定后续性能工作。若事件呈现延迟和重复数据成为实际问题，再加入增量 SSE/按需详情；不与首次语言迁移同时扩展插件、多 Agent 和 Shell。

调研时本机服务超时尚未诊断，不能把迁移视为它的修复。后续确认的服务状态及恢复记录见[本机运行与验收](operations.md)；语言迁移另按固定行为用例和真实调用验收。
