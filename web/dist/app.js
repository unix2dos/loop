import { buildTraceGraph, object, parseJSON, relatedEvents } from "./trace-graph.js";
function $(id) {
    const element = document.getElementById(id);
    if (!element)
        throw new Error("Missing UI element: " + id);
    return element;
}
const escapes = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, char => escapes[char]);
const pretty = (value) => esc(JSON.stringify(value, null, 2));
const roles = { input: "用户", model: "模型", tool: "工具", control: "程序" };
const statuses = { running: "运行中", completed: "循环已结束", budget_exhausted: "模型额度已用完", failed: "运行失败" };
let config = null, run = null;
let activeId = null, selected = null;
let graph = { steps: [], unlinkedTools: [] };
let detailTab = "overview", pointerPart = "", query = "", busy = false, detailOpen = false;
let pollTimer;
function setHTML(id, html) {
    const element = $(id);
    if (element.innerHTML === html)
        return;
    const scroll = element.scrollTop;
    const focused = document.activeElement;
    const focusID = focused instanceof HTMLElement && element.contains(focused) ? focused.id : "";
    element.innerHTML = html;
    element.scrollTop = scroll;
    if (focusID)
        document.getElementById(focusID)?.focus({ preventScroll: true });
}
function message(error) { return error instanceof Error ? error.message : "请求失败"; }
function showError(text) { $("error").textContent = text; $("error").hidden = !text; }
async function api(path, options = {}) {
    const response = await fetch(path, { cache: "no-store", ...options });
    const result = await response.json();
    if (!response.ok)
        throw new Error(typeof object(result).error === "string" ? String(object(result).error) : "请求失败");
    // The local Go API validates persisted runs and model/tool inputs at its boundaries.
    return result;
}
function summary(event) {
    if (event.status === "running")
        return "等待实际返回";
    const output = event.output ?? {};
    if (event.kind === "model") {
        const calls = object(output.message).tool_calls;
        if (Array.isArray(calls) && calls.length)
            return "提出 " + calls.length + " 个工具调用";
        return output.finish_reason === "stop" ? "给出最终回答" : "结束原因：" + (output.finish_reason ?? output.error_type ?? "未取得响应");
    }
    if (event.kind === "tool")
        return typeof output.error === "string" ? "返回错误 · " + output.error : "返回实际结果";
    return typeof output.run_status === "string" ? statuses[output.run_status] ?? output.run_status : event.title;
}
function title(event) {
    if (event.kind === "model")
        return "第 " + event.turn + " 次模型请求";
    if (event.kind === "tool")
        return event.title === "read_file" ? "读取文件" : event.title === "list_files" ? "列出文件" : event.title;
    return event.title;
}
function node(event, related, small = false) {
    const args = object(parseJSON(event.input.arguments));
    const match = !query || (title(event) + " " + event.title + " " + summary(event) + " " + String(args.path ?? "") + " " + event.id).toLowerCase().includes(query);
    return `<button id="node-${esc(event.id)}" class="node ${event.kind} ${event.status} ${small ? "compact" : ""} ${selected === event.id ? "selected" : ""} ${related.has(event.id) ? "related" : ""} ${query && match ? "search-match" : ""}" data-event="${esc(event.id)}" aria-pressed="${selected === event.id}">
    <span class="node-meta"><span>${roles[event.kind]} <span class="mono">${esc(event.id)}</span></span><span>${event.status === "running" ? "进行中" : event.d.toFixed(2) + "s"}</span></span>
    <strong>${esc(title(event))}</strong>${event.kind === "tool" ? `<code>${esc(args.path ?? event.title)}</code>` : ""}
    <span class="node-outcome"><i aria-hidden="true"></i>${esc(summary(event))}</span></button>`;
}
function callFor(id) {
    for (const step of graph.steps)
        for (const call of step.calls)
            if (call.tool?.id === id || call.receipt?.id === id)
                return { call, model: step.model };
    return undefined;
}
function pointer(event) { return "/events/" + run.events.findIndex(item => item.id === event.id); }
function renderGraph(current) {
    const related = relatedEvents(graph, selected);
    const input = current.events.find(event => event.kind === "input");
    const terminal = [...current.events].reverse().find(event => event.kind === "control" && typeof event.output?.run_status === "string");
    let html = `<div class="graph-origin">${input ? `<button data-event="${esc(input.id)}" class="origin-button ${selected === input.id ? "active" : ""}">你的任务 <span>送入程序准备的上下文</span> ↓</button>` : "等待记录任务输入"}</div>`;
    for (const step of graph.steps) {
        html += `<section class="round" aria-label="第 ${step.model.turn} 次模型请求的调用关系"><div class="round-row">${node(step.model, related)}<div class="outgoing" aria-hidden="true">${step.calls.length ? '<span>提出调用</span><svg viewBox="0 0 56 20"><path d="M0 10H52m-6-5 6 5-6 5"/></svg>' : ""}</div><div class="tools-stack">`;
        if (step.calls.length) {
            html += `<div class="execution-label">程序处理${step.calls.length > 1 ? " · 本批依次执行 " + step.calls.length + " 个调用" : " · 校验后执行"}</div>`;
            for (const call of step.calls) {
                html += call.tool ? node(call.tool, related, true) : `<button class="node pending" data-event="${esc(step.model.id)}" data-part="/output/message/tool_calls/${call.callIndex}" data-detail="io"><span class="node-meta">模型提出的请求</span><strong>${esc(call.name)}</strong><code>${esc(object(parseJSON(call.arguments)).path ?? call.arguments)}</code><span class="node-outcome">${current.status === "running" && step.model.output?.finish_reason === "tool_calls" ? "尚无执行记录" : "未执行"}</span></button>`;
                if (call.receipt)
                    html += `<button id="receipt-${esc(call.receipt.id)}" class="receipt ${selected === call.receipt.id ? "active" : ""}" data-event="${esc(call.receipt.id)}"><span aria-hidden="true">↳</span> ${call.tool?.status === "failed" ? "错误" : "工具"}回执已记录 <code>role=tool</code></button>`;
            }
        }
        else
            html += `<div class="round-note">${step.model.status === "running" ? '<span class="waiting-dot"></span> 模型正在响应<br><small>结果返回后才知道下一步</small>' : step.model.output?.finish_reason === "stop" ? '本次没有提出工具调用<br><small>模型返回 <code>stop</code></small>' : '本次未产生可执行的工具调用<br><small>请查看模型返回的实际状态</small>'}</div>`;
        html += "</div></div>";
        const forwarded = step.calls.filter(call => call.nextModel);
        if (forwarded.length) {
            const destination = forwarded[0].nextModel;
            html += `<div class="feedback ${forwarded.some(call => call.tool?.status === "failed") ? "contains-error" : ""}"><svg viewBox="0 0 600 58" preserveAspectRatio="none" aria-hidden="true"><path d="M455 0V12Q455 27 440 27H160Q145 27 145 42V56m-5-6 5 6 5-6"/></svg><button id="feedback-${esc(step.model.id)}" data-event="${esc(destination.id)}" data-part="/input/messages" data-detail="io">${forwarded.length} 条回执已送入第 ${destination.turn} 次请求 <span>查看依据 ↗</span></button></div>`;
        }
        else if (step.calls.length) {
            const returned = step.calls.filter(call => call.receipt).length;
            html += `<div class="no-feedback">${returned ? "已记录 " + returned + " 条回执；" : ""}${current.status === "running" ? "尚未观察到携带这些回执的后续模型请求" : "没有证据表明这些结果进入了后续模型请求"}</div>`;
        }
        html += "</section>";
    }
    if (graph.unlinkedTools.length)
        html += `<section class="unlinked"><p>以下工具记录缺少唯一可核对的调用关系，单独保留。</p>${graph.unlinkedTools.map(event => node(event, related, true)).join("")}</section>`;
    if (terminal)
        html += `<div class="graph-ending">${node(terminal, related, true)}<p>${current.status === "completed" ? "循环正常结束。答案是否正确，仍需你核对。" : "保留已经发生的步骤，不补画后续动作。"}</p></div>`;
    if (!graph.steps.length && !terminal)
        html += '<div class="empty-graph"><span class="waiting-dot"></span><p>任务已提交，等待第一个模型请求。</p></div>';
    setHTML("graph", html);
    const filtered = current.events.filter(event => (event.id + " " + event.title + " " + title(event) + " " + summary(event) + " " + String(event.input.arguments ?? "")).toLowerCase().includes(query));
    $("event-count").textContent = query ? filtered.length + " / " + current.events.length + " 条匹配 · 图保留关系" : current.events.length + " 条原始事件";
    setHTML("event-list", filtered.map(event => `<button class="record-row ${selected === event.id ? "active" : ""}" data-event="${esc(event.id)}"><code>${esc(event.id)}</code><span>${roles[event.kind]}</span><strong>${esc(title(event))}</strong><small>${esc(summary(event))}</small></button>`).join("") || '<p class="muted">没有匹配事件。</p>');
}
function explanation(event) {
    if (event.kind === "model") {
        const messages = Array.isArray(event.input.messages) ? event.input.messages : [];
        const results = messages.filter(value => object(value).role === "tool").length;
        const calls = graph.steps.find(step => step.model.id === event.id)?.calls.length ?? 0;
        return `程序把当前上下文发送给模型，其中包含 ${results} 条工具回执。` + (event.status === "running" ? "这次请求尚未返回，后续动作还未知。" : calls ? `模型提出 ${calls} 个工具调用。调用参数由模型给出，是否允许以及怎样执行，由程序处理。` : event.output?.finish_reason === "stop" ? "模型返回 stop，结束了这次循环。这不证明回答中的每项内容都正确。" : "模型没有正常返回可继续的动作；查看实际输出中的错误或结束原因。");
    }
    const linked = callFor(event.id);
    if (linked) {
        const { call, model } = linked;
        if (event.kind === "tool")
            return `这是第 ${model.turn} 次模型响应提出的 ${call.name} 调用。` + (event.status === "running" ? "程序正在处理，尚无结果。" : event.status === "failed" ? "程序返回了错误，错误本身也可以成为模型的输入。" : "程序已返回实际结果。") + (call.nextModel ? ` 已核对：这条回执出现在第 ${call.nextModel.turn} 次模型请求的消息中。` : call.receipt ? "回执已记录，但尚无后续模型请求接收它的证据。" : "尚未找到与这次执行结果对应的回执记录。");
        return "程序把工具结果整理为回执，并保留原调用编号。写入回执本身不会发起模型请求。" + (call.nextModel ? ` 后续第 ${call.nextModel.turn} 次模型请求确实携带了它。` : "当前尚无后续模型请求携带它的证据。");
    }
    return event.explanation;
}
function eventLink(event, label, part = "") { return `<button class="text-link" data-event="${esc(event.id)}" data-part="${esc(part)}"${part ? ' data-detail="io"' : ""}>${esc(label)} <span aria-hidden="true">↗</span></button>`; }
function renderDetail(current) {
    const event = current.events.find(item => item.id === selected);
    if (!event)
        return;
    const tabs = [["overview", "这步发生了什么"], ["io", "原始记录"], ["code", "核心代码"]];
    document.querySelector(".trace-pane")?.classList.toggle("detail-open", detailOpen);
    setHTML("detail-heading", `<div><span class="eyebrow">${roles[event.kind]} · ${esc(event.id)}</span><h2>${esc(title(event))}</h2></div><div class="detail-tabs" role="tablist" aria-label="步骤详情">${tabs.map(([id, label]) => `<button id="detail-tab-${id}" role="tab" aria-controls="detail-content" aria-selected="${detailTab === id}" data-tab="${id}" class="${detailTab === id ? "active" : ""}">${label}</button>`).join("")}</div><button id="detail-toggle" class="detail-toggle" data-toggle-detail aria-expanded="${detailOpen}" aria-controls="detail-content">${detailOpen ? "收起 ↓" : "展开说明 ↑"}</button>`);
    const source = current.source[event.code];
    let content = "";
    if (detailTab === "overview") {
        content = `<p class="step-explanation">${esc(explanation(event))}</p>`;
        const connections = [];
        for (const step of graph.steps)
            for (const call of step.calls) {
                if (event.id === step.model.id && call.tool)
                    connections.push(eventLink(call.tool, "本次提出 → " + title(call.tool)));
                if (event.id === call.tool?.id || event.id === call.receipt?.id) {
                    connections.push(eventLink(step.model, "来自第 " + step.model.turn + " 次模型响应", "/output/message/tool_calls/" + call.callIndex));
                    if (call.receipt && event.id !== call.receipt.id)
                        connections.push(eventLink(call.receipt, "对应的工具回执"));
                    if (call.nextModel)
                        connections.push(eventLink(call.nextModel, "进入第 " + call.nextModel.turn + " 次请求的消息", "/input/messages/" + call.messageIndex));
                }
                if (event.id === call.nextModel?.id && call.tool)
                    connections.push(eventLink(call.tool, "本次收到 ← " + title(call.tool) + (call.tool.status === "failed" ? "的错误" : "的结果")));
            }
        if (connections.length)
            content += `<div class="connections">${[...new Set(connections)].join("")}</div>`;
        content += `<div class="step-facts"><span>事件开始 <b>${event.t.toFixed(3)}s</b></span><span>实际状态 <b>${event.status === "running" ? "进行中" : event.status === "failed" ? "失败或被拒绝" : "已返回"}</b></span>${source ? `<span>对应函数 <b>${esc(source.path)}:${source.line}</b></span>` : ""}</div>`;
        if (event.kind === "tool" && event.output?.error)
            content += `<div class="error-evidence"><code>${esc(event.output.error)}</code><p>${esc(event.output.message ?? "工具没有执行成功。")}</p></div>`;
    }
    else if (detailTab === "io") {
        const location = (config?.state_dir ?? ".agent_state/runs") + "/" + current.id;
        const point = pointer(event) + pointerPart;
        content = `<div class="evidence-location"><div><span class="eyebrow">${current.status === "running" ? "当前实时快照 · 结束后保存至" : "本地原始记录"}</span><code>${esc(location)}/run.json</code><code class="json-pointer">${esc(point)}</code></div><button id="copy-evidence" data-copy="${esc(location + "/run.json#" + point)}">复制定位</button></div>`;
        if (current.status === "running")
            content += '<p class="detail-note">run.json 尚未完成落盘。下面来自当前运行快照；已发生的事件同时追加在 trace.jsonl 中。</p>';
        if (pointerPart) {
            let value = event;
            for (const segment of pointerPart.split("/").slice(1))
                value = Array.isArray(value) ? value[Number(segment)] : object(value)[segment];
            content += `<div class="evidence-fragment"><h3>已定位的消息 / 字段</h3><pre>${pretty(value ?? null)}</pre></div>`;
        }
        content += `<div class="json-pair"><section><h3>实际输入 <code>${esc(pointer(event))}/input</code></h3><pre>${pretty(event.input)}</pre></section><section><h3>实际输出 <code>${esc(pointer(event))}/output</code></h3><pre>${event.status === "running" ? "尚未返回" : pretty(event.output)}</pre></section></div><p class="detail-note">过程文件：<code>${esc(location)}/trace.jsonl</code>，按事件 ID <code>${esc(event.id)}</code> 查找；消息顺序保存在同目录的 <code>session.jsonl</code>。回看和复制定位不会重新执行任务。</p>`;
    }
    else
        content = source ? `<div class="source-heading"><code>${esc(source.path)}:${source.line}</code><span>本次运行保存的函数源码</span></div><pre class="source-code">${esc(source.code)}</pre><p class="detail-note">关联到函数整体，未声称精确到执行语句。历史源码不会被当前文件覆盖。</p>` : '<p class="detail-note">这条历史记录没有对应的源码快照。</p>';
    setHTML("detail-content", content);
}
function render() {
    if (!config)
        return;
    $("submit").disabled = busy || !config.configured;
    $("submit").textContent = busy ? "正在运行…" : "运行任务 →";
    if (!run)
        return;
    const current = run;
    graph = buildTraceGraph(current);
    const previous = selected;
    if ($("follow").checked && current.status === "running")
        selected = current.events.at(-1)?.id ?? null;
    if (!current.events.some(event => event.id === selected))
        selected = graph.steps[0]?.model.id ?? current.events[0]?.id ?? null;
    if (selected !== previous)
        pointerPart = "";
    $("model-label").textContent = current.model;
    $("workspace-label").textContent = (current.workspace === config.workspace ? "只读工作区 · " : "历史工作区 · ") + current.workspace;
    $("workspace-label").title = current.workspace;
    $("run-id").textContent = "RUN " + current.id.slice(0, 8);
    $("status").textContent = statuses[current.status];
    $("status").dataset.status = current.status;
    const seconds = current.status === "running" ? Math.max(0, Date.now() / 1000 - current.created_at) : current.duration ?? 0;
    $("metrics").textContent = `${current.model_requests} 次模型请求 / ${current.tool_calls} 次工具调用 / ${seconds.toFixed(1)}s`;
    $("download").disabled = false;
    const error = current.events.find(event => event.kind === "tool" && event.status === "failed");
    setHTML("conversation", `<article class="message user-message"><div class="speaker"><span class="avatar">你</span><span>本次任务</span></div><p>${esc(current.task)}</p></article><article class="message assistant-message"><div class="speaker"><span class="avatar agent-avatar">↻</span><span>Loop</span><small>${current.status === "running" ? "执行中" : "最终回答"}</small></div>${current.answer ? `<p>${esc(current.answer)}</p>` : `<div class="answer-placeholder">${current.status === "running" ? '<span class="waiting-dot"></span> 正在处理任务，右侧展示实际发生的步骤。' : "这次没有产生最终回答。请在右侧查看停止位置。"}</div>`}${error ? `<button class="error-link" data-event="${esc(error.id)}">${current.tool_errors} 次工具错误 · 在图中查看 ↗</button>` : ""}${current.status === "completed" ? '<p class="acceptance-note">循环已结束 · 请对照工具结果核对回答</p>' : ""}</article>`);
    renderGraph(current);
    renderDetail(current);
    if ($("follow").checked && current.status === "running" && previous !== selected)
        document.getElementById("node-" + selected)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
async function refreshHistory() {
    const items = await api("/api/runs");
    busy = items.some(item => item.status === "running");
    setHTML("history", items.length ? items.map(item => `<option value="${esc(item.id)}">${esc(statuses[item.status] + " · " + item.task.slice(0, 35))}</option>`).join("") : '<option value="">尚无运行记录</option>');
    if (activeId && items.some(item => item.id === activeId))
        $("history").value = activeId;
    $("submit").disabled = busy || !config?.configured;
    return items;
}
async function poll() {
    if (!activeId)
        return;
    const id = activeId;
    try {
        const snapshot = await api("/api/runs/" + id);
        if (activeId !== id)
            return;
        if (!run)
            $("follow").checked = snapshot.status === "running";
        run = snapshot;
        if (run.status !== "running")
            await refreshHistory();
        if (activeId !== id)
            return;
        render();
        window.clearTimeout(pollTimer);
        if (run.status === "running" || busy)
            pollTimer = window.setTimeout(() => { void poll(); }, 650);
    }
    catch (error) {
        if (activeId !== id)
            return;
        showError(message(error));
        $("submit").disabled = busy || !config?.configured;
    }
}
async function chooseRun(id) {
    activeId = id;
    run = null;
    selected = null;
    pointerPart = "";
    query = "";
    detailOpen = false;
    $("search").value = "";
    window.clearTimeout(pollTimer);
    showError("");
    setHTML("graph", '<div class="empty-graph"><p>正在读取这次运行…</p></div>');
    setHTML("conversation", '<p class="muted loading-note">正在载入任务和回答…</p>');
    setHTML("detail-heading", "");
    setHTML("detail-content", "");
    setHTML("event-list", "");
    const url = new URL(location.href);
    url.searchParams.set("run", id);
    window.history.replaceState(null, "", url);
    await poll();
}
function selectEvent(id, part = "", detail) {
    if (!run?.events.some(event => event.id === id))
        return;
    selected = id;
    pointerPart = part;
    detailOpen = true;
    $("follow").checked = false;
    if (detail === "overview" || detail === "io" || detail === "code")
        detailTab = detail;
    render();
    const target = document.getElementById("node-" + id) ?? document.getElementById("receipt-" + id);
    target?.scrollIntoView({ block: "nearest", inline: "nearest" });
    target?.focus({ preventScroll: true });
}
document.addEventListener("click", event => {
    if (!(event.target instanceof Element))
        return;
    if (event.target.closest("[data-toggle-detail]")) {
        detailOpen = !detailOpen;
        render();
    }
    const node = event.target.closest("[data-event]");
    if (node?.dataset.event)
        selectEvent(node.dataset.event, node.dataset.part ?? "", node.dataset.detail);
    const tab = event.target.closest("[data-tab]")?.dataset.tab;
    if (tab === "overview" || tab === "io" || tab === "code") {
        detailTab = tab;
        render();
    }
    const copy = event.target.closest("[data-copy]");
    if (copy?.dataset.copy)
        void navigator.clipboard.writeText(copy.dataset.copy).then(() => { copy.textContent = "已复制"; }).catch(() => { copy.textContent = "请手动选择路径"; });
    const example = event.target.closest("[data-example]")?.dataset.example;
    if (example) {
        $("task").value = example;
        $("task").focus();
    }
});
$("detail-heading").addEventListener("keydown", event => {
    if (!(event.target instanceof HTMLElement) || !event.target.dataset.tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
    event.preventDefault();
    const tabs = ["overview", "io", "code"];
    const index = tabs.indexOf(detailTab);
    detailTab = event.key === "Home" ? "overview" : event.key === "End" ? "code" : tabs[(index + (event.key === "ArrowRight" ? 1 : 2)) % 3];
    render();
    document.getElementById("detail-tab-" + detailTab)?.focus();
});
$("search").addEventListener("input", () => { query = $("search").value.trim().toLowerCase(); render(); });
$("follow").onchange = () => render();
$("history").onchange = () => { if ($("history").value)
    void chooseRun($("history").value); };
$("task-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!config || busy)
        return;
    showError("");
    busy = true;
    $("submit").disabled = true;
    $("submit").textContent = "正在提交…";
    try {
        const result = await api("/api/runs", { method: "POST", headers: { "Content-Type": "application/json", "X-Lab-Token": config.token }, body: JSON.stringify({ task: $("task").value, max_requests: Number($("budget").value) }) });
        activeId = result.id;
        await refreshHistory();
        await chooseRun(result.id);
    }
    catch (error) {
        showError(message(error));
        try {
            await refreshHistory();
        }
        catch {
            busy = true;
        }
        $("submit").disabled = busy || !config.configured;
        $("submit").textContent = busy ? "请等待当前任务" : "运行任务 →";
    }
});
$("download").onclick = () => {
    if (!run)
        return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(run, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "loop-run-" + run.id + ".json";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};
async function initialize() {
    try {
        config = await api("/api/config");
        $("workspace-label").textContent = "只读工作区 · " + config.workspace;
        $("workspace-label").title = config.workspace;
        $("model-label").textContent = config.configured ? config.model : "模型未配置";
        $("task").value = config.default_task;
        $("history-note").textContent = config.history.loaded ? "已载入 " + config.history.loaded + " 次历史运行" + (config.history.skipped ? " · 跳过 " + config.history.skipped + " 条无效或未结束记录" : "") : "每次运行都会在本地保存记录";
        $("access").textContent = "新任务只读目录：" + config.workspace;
        $("submit").disabled = !config.configured;
        if (!config.configured)
            showError("在启动服务的终端配置 OPENAI_API_KEY 和 OPENAI_MODEL，然后重启服务。");
        const items = await refreshHistory();
        const requested = new URL(location.href).searchParams.get("run");
        const id = items.find(item => item.id === requested)?.id ?? items[0]?.id;
        if (id)
            await chooseRun(id);
    }
    catch (error) {
        showError("无法连接本机服务：" + message(error));
    }
}
void initialize();
