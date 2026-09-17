"""Run the same loop fixtures against the preserved Python reference, without model calls."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
fixtures = root / "testdata/loop-cases.json"
with tempfile.TemporaryDirectory(prefix="levon-python-reference-") as temporary:
    target = Path(temporary)
    for name in ("agent.py", "app.py", "client.py", "check.py"):
        target.joinpath(name).write_bytes(subprocess.check_output(
            ["git", "show", "python-reference:" + name], cwd=root
        ))
    program = r'''
import json
from pathlib import Path
import sys
import threading
import app
from check import FakeClient, fake_response, fake_tool_call
workspace = Path("workspace")
workspace.mkdir()
(workspace / "note.md").write_text("ACTUAL_CONTENT_73")
examples = json.loads(Path(sys.argv[1]).read_text())
for example in examples:
    responses = []
    for wire in example["responses"]:
        choice = wire["choices"][0]
        message = choice["message"]
        calls = [fake_tool_call(c["id"], c["function"]["name"], json.loads(c["function"]["arguments"]))
                 for c in message.get("tool_calls", [])]
        responses.append(fake_response(choice["finish_reason"], content=message.get("content", ""), tool_calls=calls))
    run = app.new_run("读取 note.md 并报告原文", example["budget"], "scripted", workspace)
    app.run_task(run, FakeClient(responses), workspace, Path("runs") / run["id"], threading.Lock())
    actual = (run["status"], run["model_requests"], run["tool_calls"], run["tool_errors"], run["answer"])
    expected = tuple(example[k] for k in ("status", "requests", "tools", "tool_errors", "answer"))
    assert actual == expected, (example["name"], actual, expected)
print(f"{len(examples)} shared behavior contracts passed against python-reference")
'''
    subprocess.run([sys.executable, "-c", program, str(fixtures)], cwd=target, check=True)
