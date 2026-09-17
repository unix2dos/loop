# Python 行为对照版本

Python 实现及已验收的历史加载功能保存在标签 python-reference（432c6c2）。最早基线为 0358008。当前入口已经迁移到 Go 与 TypeScript，不在当前分支同时维护第二套 Python 后端。

查看旧实现：

    git show python-reference:agent.py
    git show python-reference:app.py
    git show python-reference:check.py

旧研究记录引用的 app.py、agent.py 等文件和行号均指当时的 Python 版本。它们不再对应当前 Go 文件的行号。

共享用例位于 testdata/loop-cases.json，包含正常批量调用、一次请求额度、截断响应和文件读取失败。两套实现使用相同响应和真实临时文件，验证状态、模型次数、工具次数、错误数及最终回答。

    python3 -B scripts/check_python_reference.py
    go test -race ./...

Python 检查会在临时目录读取 Git 标签内的代码，结束后清理；不会调用模型、重放历史业务动作或修改当前工作区。
