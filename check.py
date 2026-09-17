"""One offline check for actual trace capture, stop conditions, and local HTTP boundaries."""

import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace

import agent as core
import app as lab
import copy


class FakeCompletions:
    def __init__(self, responses: list[object]):
        self.responses = list(responses)
        self.requests: list[dict] = []

    def create(self, **request: object) -> object:
        self.requests.append(copy.deepcopy(request))
        if not self.responses:
            raise AssertionError("模型请求次数超过测试准备的响应数量")
        return self.responses.pop(0)


class FakeClient:
    def __init__(self, responses: list[object]):
        self.completions = FakeCompletions(responses)
        self.chat = SimpleNamespace(completions=self.completions)


def fake_tool_call(call_id: str, name: str, arguments: dict) -> object:
    return SimpleNamespace(
        id=call_id,
        function=SimpleNamespace(
            name=name,
            arguments=json.dumps(arguments, ensure_ascii=False),
        ),
    )


def fake_response(
    finish_reason: str,
    *,
    content: str = "",
    tool_calls: list[object] | None = None,
) -> object:
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                finish_reason=finish_reason,
                message=SimpleNamespace(
                    content=content,
                    tool_calls=tool_calls or [],
                ),
            )
        ]
    )


def main():
    options = []
    configured = SimpleNamespace(base_url="https://opencode.ai/zen/go/v1", with_options=lambda **kw: options.append(kw))
    lab.prepare_client(configured, "actual-session-1")
    assert options[-1]["default_headers"]["x-opencode-session"] == "actual-session-1"
    assert options[-1]["default_headers"]["User-Agent"] == "levon/0.1"
    configured.base_url = "https://another-provider.example/v1"
    lab.prepare_client(configured, "actual-session-2")
    assert "default_headers" not in options[-1]
    with tempfile.TemporaryDirectory(prefix="agent-lab-check-") as temporary:
        root = Path(temporary)
        workspace = root / "workspace"
        workspace.mkdir()
        (workspace / "note.md").write_text("ACTUAL_CONTENT_73", encoding="utf-8")
        outside = root / "outside.md"
        outside.write_text("DO_NOT_READ", encoding="utf-8")
        (workspace / "escape.md").symlink_to(outside)
        (workspace / "secret.txt").write_text("DO_NOT_READ", encoding="utf-8")
        calls = [
            fake_tool_call("list-1", "list_files", {"path": "."}),
            fake_tool_call("read-1", "read_file", {"path": "note.md"}),
        ]

        def run(responses, budget=4):
            client = FakeClient(responses)
            state = lab.new_run("读取 note.md 并报告原文", budget, "offline-test", workspace)
            output = root / state["id"]
            lab.run_task(state, client, workspace, output, threading.Lock())
            assert json.loads((output / "run.json").read_text()) == state
            saved = [e for e in core.load_entries(output / "trace.jsonl") if e["phase"] == "finish"]
            assert len(saved) == len(state["events"])
            return state, client

        responses = [
            fake_response("tool_calls", tool_calls=calls),
            fake_response("stop", content="ACTUAL_CONTENT_73"),
        ]
        state, client = run(responses)
        assert state["status"] == "completed" and state["task_result"] == "not_evaluated"
        assert state["answer"] == "ACTUAL_CONTENT_73"
        models = [e for e in state["events"] if e["kind"] == "model"]
        assert models[0]["input"] == client.completions.requests[0]
        receipts = [m for m in models[1]["input"]["messages"] if m["role"] == "tool"]
        assert [m["tool_call_id"] for m in receipts] == ["list-1", "read-1"]
        assert json.loads(receipts[1]["content"])["content"] == "ACTUAL_CONTENT_73"
        assert models[0]["output"]["finish_reason"] == "tool_calls"
        assert models[1]["output"]["finish_reason"] == "stop"
        assert all(e["d"] >= 0 for e in state["events"])

        budget, client = run(responses, budget=1)
        assert budget["status"] == "budget_exhausted" and budget["model_requests"] == 1
        assert budget["tool_calls"] == 2 and len(client.completions.requests) == 1
        assert core.MAX_MODEL_REQUESTS == 4

        truncated, _ = run([fake_response("length", tool_calls=calls)])
        assert truncated["status"] == "failed" and truncated["tool_calls"] == 0
        assert [e for e in truncated["events"] if e["kind"] == "model"][0]["output"]["finish_reason"] == "length"

        missing = fake_tool_call("missing", "read_file", {"path": "missing.md"})
        failed_tool, _ = run([
            fake_response("tool_calls", tool_calls=[missing]),
            fake_response("stop", content="证据不足"),
        ])
        assert failed_tool["status"] == "completed" and failed_tool["tool_errors"] == 1
        assert failed_tool["task_result"] == "not_evaluated"

        for name, args in [
            ("read_file", {"path": "../outside.md"}),
            ("read_file", {"path": str(outside)}),
            ("read_file", {"path": "escape.md"}),
            ("read_file", {"path": "secret.txt"}),
            ("read_file", {"path": "note.md", "offset": True}),
            ("read_file", {"path": "note.md", "extra": "ignored?"}),
            ("list_files", {"path": ".", "limit": True}),
            ("run_bash", {"path": ".", "command": "touch should-not-exist"}),
            ("write_file", {"path": "note.md", "content": "changed"}),
        ]:
            result = lab.execute_readonly(workspace, fake_tool_call("blocked", name, args))
            assert json.loads(result)["error"] == "tool_rejected", (name, args)
            assert "DO_NOT_READ" not in result
        assert (workspace / "note.md").read_text() == "ACTUAL_CONTENT_73"

        def factory():
            return FakeClient(responses), "offline-http-check"
        server = lab.make_server(workspace, 0, factory, root / "http-runs")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        token = ""

        def request(method, path, body=None, headers=None):
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            outgoing = {"Content-Type": "application/json", "X-Lab-Token": token}
            outgoing.update(headers or {})
            connection.request(method, path, None if body is None else json.dumps(body), outgoing)
            response = connection.getresponse()
            raw = response.read()
            status = response.status
            connection.close()
            return status, json.loads(raw) if raw else None

        try:
            status, config = request("GET", "/api/config")
            assert status == 200 and "api_key" not in config
            token = config["token"]
            assert request("GET", "/api/config", headers={"Host": "attacker.example"})[0] == 403
            assert request("GET", "/api/config", headers={"Origin": "https://attacker.example"})[0] == 403
            assert request("POST", "/api/runs", {"task": "test"}, {"X-Lab-Token": "wrong"})[0] == 403
            assert request("POST", "/api/runs", {"task": "test", "max_requests": True})[0] == 400
            assert request("GET", "/api/runs/../../outside.md")[0] == 404
            status, result = request("POST", "/api/runs", {"task": "读取 note.md", "max_requests": 4})
            assert status == 202
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                status, result = request("GET", "/api/runs/" + result["id"])
                if result["status"] != "running":
                    break
                time.sleep(.02)
            assert result["status"] == "completed" and result["answer"] == "ACTUAL_CONTENT_73"
            assert request("GET", "/api/runs")[1][0]["id"] == result["id"]
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

        # Restart against saved files. Browsing must not construct a model client or replay tools.
        saved = copy.deepcopy(result)
        history_dir = root / "http-runs"
        for i in range(1, 10):
            older = {**saved, "id": f"{i:032x}", "created_at": i}
            path = history_dir / older["id"] / "run.json"
            path.parent.mkdir()
            path.write_text(json.dumps(older))
        corrupt = history_dir / ("a" * 32) / "run.json"
        corrupt.parent.mkdir()
        corrupt.write_text('{"incomplete":')
        unfinished = {**saved, "id": "b" * 32, "status": "running"}
        path = history_dir / unfinished["id"] / "run.json"
        path.parent.mkdir()
        path.write_text(json.dumps(unfinished))
        linked = history_dir / ("c" * 32) / "run.json"
        linked.parent.mkdir()
        linked.symlink_to(outside)
        invalid = copy.deepcopy(saved)
        invalid["id"] = "d" * 32
        invalid["events"][0]["id"] = '<img src=x onerror="alert(1)">'
        path = history_dir / invalid["id"] / "run.json"
        path.parent.mkdir()
        path.write_text(json.dumps(invalid))
        history_before = {p: p.read_bytes() for p in history_dir.glob("*/run.json")}

        def forbidden_factory():
            raise AssertionError("Reading history must not call the model factory")

        server = lab.make_server(workspace, 0, forbidden_factory, history_dir)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            status, config = request("GET", "/api/config")
            assert config["history"] == {"loaded": 8, "skipped": 4}
            status, items = request("GET", "/api/runs")
            assert [r["id"] for r in items] == [saved["id"]] + [f"{i:032x}" for i in range(9, 2, -1)]
            status, restored = request("GET", "/api/runs/" + saved["id"])
            assert status == 200 and restored == saved
            assert request("GET", "/api/runs/" + f"{1:032x}")[0] == 404
            assert {p: p.read_bytes() for p in history_dir.glob("*/run.json")} == history_before
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
    print("lab checks passed: trace evidence, batch receipts, budget, truncation, read-only scope, same-origin HTTP, history restart")


if __name__ == "__main__":
    main()
