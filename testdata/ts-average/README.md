# TypeScript 平均值修复练习

修复 average 对空数组和 null 输入的处理：这两种情况返回 0，非空输入保留向零取整的平均行为。
先运行 `node --test average.test.ts` 观察失败，读取代码和测试，修改 `average.ts` 后重新运行测试。
只有 average.ts 可以修改。测试与 package.json 是受保护的验收依据。
测试在断网、非 root、项目只读挂载的 Node 容器中执行；没有第三方依赖。
