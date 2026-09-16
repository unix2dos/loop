"""Levon runtime: bounded tool loop, transcript, and read-only filesystem helpers."""

import json
import os
from pathlib import Path
from typing import Callable


MAX_MODEL_REQUESTS = 4
MAX_READ_BYTES = 50 * 1024


def append_entry(path: Path, entry: dict) -> None:
    """Append one durable transcript entry."""
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n"
    with path.open("a", encoding="utf-8") as file:
        file.write(line)
        file.flush()
        os.fsync(file.fileno())


def load_entries(path: Path) -> list[dict]:
    """Append one durable transcript entry."""
    if not path.exists():
        return []

    entries = []
    with path.open("r", encoding="utf-8") as file:
        for line_number, line in enumerate(file, start=1):
            if not line.strip():
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError as error:
                raise ValueError(f"第 {line_number} 行损坏") from error
    return entries


def persist_message(path: Path, message: dict) -> None:
    append_entry(path, {"type": "message", "message": message})


def build_prompt_view(entries: list[dict]) -> list[dict]:
    """Rebuild the prompt view from recorded messages and an optional summary."""
    latest_compaction = None
    for index in range(len(entries) - 1, -1, -1):
        if entries[index].get("type") == "compaction":
            latest_compaction = index
            break

    if latest_compaction is None:
        messages = []
        for entry in entries:
            if entry.get("type") == "message":
                messages.append(entry["message"])
        return messages

    checkpoint = entries[latest_compaction]
    messages = [
        {
            "role": "assistant",
            "content": "Conversation summary:\n" + checkpoint["summary"],
        }
    ]
    messages.extend(checkpoint["retained_tail"])

    for entry in entries[latest_compaction + 1 :]:
        if entry.get("type") == "message":
            messages.append(entry["message"])
    return messages


def assistant_message_from_api(message: object) -> dict:
    result = {"role": "assistant", "content": message.content or ""}
    if message.tool_calls:
        result["tool_calls"] = [
            {
                "id": call.id,
                "type": "function",
                "function": {
                    "name": call.function.name,
                    "arguments": call.function.arguments,
                },
            }
            for call in message.tool_calls
        ]
    return result


def run_agent_loop(
    client: object,
    model: str,
    tools: list[dict],
    user_text: str | None,
    execute_tool: Callable[[object], str],
    session_file: Path | None = None,
    compact_before_request: Callable[[], bool] | None = None,
    *,
    max_requests: int = MAX_MODEL_REQUESTS,
) -> str:
    """Run bounded model requests and return every matching tool receipt."""
    if type(max_requests) is not int or max_requests < 1:
        raise ValueError("max_requests 必须是正整数")

    def add_message(messages: list[dict], message: dict) -> None:
        messages.append(message)
        if session_file is not None:
            persist_message(session_file, message)

    messages = (
        build_prompt_view(load_entries(session_file))
        if session_file is not None
        else []
    )
    # 第五关 D。user_text=None 时继续以 Tool Result 结尾的旧 Turn。
    if user_text is None:
        if session_file is None:
            raise ValueError("session_file 不能为 None")
        if not messages:
            raise ValueError("没有可以继续的旧 Turn")
        if messages[-1].get("role") != "tool":
            raise ValueError("恢复旧 Turn 时，最后一条必须是 Tool Result")
    else:
        add_message(messages, {"role": "user", "content": user_text})
    for i in range(max_requests):
        # 第三关 G 在这里执行压缩，并在成功后刷新 messages。
        if compact_before_request is not None:
            if session_file is None:
                raise ValueError("session_file 不能为 None")
            if compact_before_request():
                messages = build_prompt_view(load_entries(session_file))

        response = client.chat.completions.create(
            model=model,
            messages=messages,
            tools=tools,
        )
        choice = response.choices[0]
        api_message = choice.message
        history_message = assistant_message_from_api(api_message)
        add_message(messages, history_message)
        if api_message.tool_calls:
            if choice.finish_reason != "tool_calls":
                raise RuntimeError(
                    "响应同时包含 Tool Call 和不一致的 finish_reason"
                )
            for tool_call in api_message.tool_calls:
                result = execute_tool(tool_call)
                add_message(
                    messages,
                    {"role": "tool", "content": result, "tool_call_id": tool_call.id}
                )
            continue

        if choice.finish_reason == "stop":
            return api_message.content or ""

        raise RuntimeError("模型没有正常结束")

    raise RuntimeError("模型请求次数超过最大次数")


def resolve_workspace_file(workspace: Path, path: str) -> Path:
    """Resolve a relative path and require it to stay inside Workspace."""
    workspace_root = workspace.resolve()
    requested = Path(path)
    if requested.is_absolute():
        raise ValueError("路径必须是相对路径")

    target = (workspace_root / requested).resolve()
    try:
        target.relative_to(workspace_root)
    except ValueError as error:
        raise ValueError("路径必须位于 Workspace 内") from error
    return target


def read_file(workspace: Path, path: str, offset: int = 0) -> dict:
    """Read a bounded byte range within the workspace."""
    if offset < 0:
        raise ValueError("offset 不能为负数")

    file_path = resolve_workspace_file(workspace, path)
    if not file_path.is_file():
        raise ValueError("路径必须指向普通文件")

    with open(file_path, "rb") as file:
        file.seek(offset)
        raw = file.read(MAX_READ_BYTES + 1)
        content = raw[:MAX_READ_BYTES]
        truncated = len(raw) > MAX_READ_BYTES
        return {
            "path": path,
            "content": content.decode("utf-8"),
            "truncated": truncated,
            "next_offset": offset + len(content) if truncated else None,
        }


def list_files(workspace: Path, path: str = ".", offset: int = 0, limit: int = 20) -> dict:
    """分页列出当前目录的普通文件名，跳过软链接并拒绝越界。"""
    if not isinstance(path, str):
        raise ValueError("path 必须是字符串")
    if path == "":
        raise ValueError("path 不能为空")
    if type(offset) is not int or offset < 0:
        raise ValueError("offset 必须是非负整数")
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("limit 必须是 1～100 的整数")

    directory = resolve_workspace_file(workspace, path)
    if not directory.is_dir():
        raise ValueError("path 必须指向一个存在的目录")

    files = []
    for file in directory.iterdir():
        if not file.is_symlink() and file.is_file():
            files.append(file.name)

    # ponytail: 每次仍扫描并排序整个目录；这里只限制返回量，不提供跨页快照。
    files = sorted(files)
    page = files[offset : offset + limit]
    next_offset = offset + len(page)
    if next_offset >= len(files):
        next_offset = None
    return {"path": path, "files": page, "next_offset": next_offset}
