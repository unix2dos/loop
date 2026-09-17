# JSON 轨迹处理小测

日期：2026-09-17。本机 macOS arm64，Go 1.24.13、Node 26.7.0、Python 3.14.7。

目的：观察当前标准库和通用 JSON 对象表示在一项本地工作上的差异，检验“Go 必然更快”的假设。不是完整 Agent、HTTP、并发或内存基准，不能据此给语言做总体排名。

## 方法

- 输入一：已保存运行 940ee4d957f64674b483f71995a0f642，转为紧凑 JSON，34,835 字节。
- 输入二：同一记录的 events 数组重复 32 次形成的合成大输入，823,971 字节；不是一次真实运行。
- 每次操作都完整解码 JSON，再重新编码为 UTF-8。磁盘读取在计时区间之外。
- 预热 25 次；7 批次；小输入每批 200 次，大输入每批 12 次；报告各批每次操作耗时的中位数。
- Go 使用 encoding/json v1 的通用对象（map / slice），不是针对类型优化的结构体实现；Node 使用 JSON.parse / JSON.stringify；Python 使用 json 标准库。
- 分别以完整对象比较验证三种实现的输出与原输入等价。键顺序、数字文本格式和末尾换行使输出字节数略有差异，不能把字节级完全一致当成本次条件。
- 单机一次实验，未固定 CPU 频率或隔离系统其他负载；未比较最新 Go、typed struct、替代 JSON 库或 Bun。

## 结果

| 运行时 | 真实小输入，ms/次 | 合成大输入，ms/次 |
| --- | ---: | ---: |
| Go 1.24.13 | 0.271 | 7.456 |
| Node 26.7.0 | 0.114 | 2.827 |
| Python 3.14.7 | 0.212 | 5.905 |

结果只表明这项任务在这些实现下 Node 更快。标准库、数据表示、键排序、编码方式和版本均会影响结果。它不能说明 Go 内核总体更慢，也不能说明 Node 有更好的并发容量或更低内存。

原始 7 批数据见 results.json，输入散列及环境见 metadata.json。脚本中的断言检查基本往返；第三个参数可导出结果供完整对象比较。

## 复现

准备任意 run.json；要复现原输入，需要本机已保存的上述运行记录。大输入按前述方法构造。以下命令不会调用模型或启动应用：

    go build -o /tmp/levon-json-bench docs/benchmarks/json-roundtrip/bench.go
    /tmp/levon-json-bench /path/to/input.json 200 /tmp/go-roundtrip.json
    node docs/benchmarks/json-roundtrip/bench.js /path/to/input.json 200 /tmp/node-roundtrip.json
    python3 docs/benchmarks/json-roundtrip/bench.py /path/to/input.json 200 /tmp/python-roundtrip.json

合成大输入把迭代次数改为 12。输入未加入版本库，避免将个人运行材料复制进研究脚本。
