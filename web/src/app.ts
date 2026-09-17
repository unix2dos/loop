import type { Config, EventKind, Run, RunStatus, RunSummary, TraceEvent } from "./types.js";
import { buildTraceGraph, object, relatedEvents, tokenUsage, runUsage, formatDuration, executionSections, timelineLayout } from "./trace-graph.js";
import type { CallLink, TraceGraph } from "./trace-graph.js";

interface FormElements {
  task: HTMLTextAreaElement; budget: HTMLSelectElement;
  follow: HTMLInputElement; submit: HTMLButtonElement;
  download: HTMLButtonElement; "task-form": HTMLFormElement;
}
function $<K extends keyof FormElements>(id: K): FormElements[K];
function $(id: string): HTMLElement;
function $(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error("Missing UI element: " + id);
  return element;
}
const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, char => escapes[char]);
const pretty = (value: unknown): string => esc(JSON.stringify(value, null, 2));
const roles: Record<EventKind, string> = { input: "用户", model: "模型", tool: "工具", control: "程序" };
const statuses: Record<RunStatus, string> = { running: "运行中", completed: "循环已结束", budget_exhausted: "模型额度已用完", failed: "运行失败" };
type DetailTab = "overview" | "io" | "code";
let config: Config | null = null, run: Run | null = null;
let activeId: string | null = null, selected: string | null = null;
let graph: TraceGraph = { steps: [], unlinkedTools: [] };
let detailTab: DetailTab = "io", pointerPart = "", busy = false, detailOpen = false;
let pollTimer: number | undefined;
let traceFocused = false, openingRecord = false, recordFeedback = "";
const batchStates = new Map<string, boolean>();
let items: RunSummary[] = [], page: "home" | "new" | "run" = "home";
function readPreference(key: string, fallback = false): boolean { try { const value = localStorage.getItem(key); return value === null ? fallback : value === "true"; } catch { return fallback; } }
let sidebarCollapsed = readPreference("loop.sidebarCollapsed", innerWidth < 900), traceCollapsed = readPreference("loop.traceCollapsed");
function savePreference(key: string, value: boolean | number): void { try { localStorage.setItem(key, String(value)); } catch { /* Browser storage is optional. */ } }
let conversationShare = .65;
try {
 const saved = Number(localStorage.getItem("loop.conversationShare"));
 if (Number.isFinite(saved) && saved > 0 && saved < 1) conversationShare = saved;
} catch { /* Browser storage is optional. */ }
const splitter = $("trace-resize"), workbench = $("workbench");
function updateSplitWidth(share?: number): void {
 if (!splitter.offsetWidth) return; // Hidden in collapsed, focused and phone layouts.
 const available = workbench.clientWidth - splitter.offsetWidth;
 if (available <= 0) return;
 const minimum = Math.min(280, available / 2);
 const left = Math.max(minimum, Math.min(available - minimum, available * (share ?? conversationShare)));
 if (share !== undefined) conversationShare = left / available;
 workbench.style.setProperty("--conversation-size", left + "px");
 const percent = Math.round(left / available * 100);
 splitter.setAttribute("aria-valuenow", String(percent));
 splitter.setAttribute("aria-valuemin", String(Math.ceil(minimum / available * 100)));
 splitter.setAttribute("aria-valuemax", String(Math.floor((available - minimum) / available * 100)));
 splitter.setAttribute("aria-valuetext", `对话 ${percent}%，执行轨迹 ${100-percent}%`);
}
let dragOffset = 0;
splitter.onpointerdown = event => {
 if (event.button !== 0 || !event.isPrimary) return;
 event.preventDefault(); splitter.focus();
 dragOffset = event.clientX - splitter.getBoundingClientRect().left;
 splitter.setPointerCapture(event.pointerId);
 document.body.classList.add("resizing-trace");
};
splitter.onpointermove = event => {
 if (!splitter.hasPointerCapture(event.pointerId)) return;
 const available = workbench.clientWidth - splitter.offsetWidth;
 if (available > 0) updateSplitWidth((event.clientX - workbench.getBoundingClientRect().left - dragOffset) / available);
};
splitter.onpointerup = event => { if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId); };
splitter.onlostpointercapture = () => {
 document.body.classList.remove("resizing-trace");
 savePreference("loop.conversationShare", conversationShare);
};
splitter.ondblclick = () => { updateSplitWidth(.65); savePreference("loop.conversationShare", conversationShare); };
splitter.onkeydown = event => {
 if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
 event.preventDefault();
 const current = Number(splitter.getAttribute("aria-valuenow")) / 100;
 updateSplitWidth(event.key === "Home" ? 0 : event.key === "End" ? 1 : current + (event.key === "ArrowLeft" ? -.02 : .02));
 savePreference("loop.conversationShare", conversationShare);
};
new ResizeObserver(() => updateSplitWidth()).observe(workbench);
const number = (value: number | undefined): string => value === undefined ? "未返回" : value.toLocaleString("zh-CN");
function totalTokens(current: Run): string {
 const usage = runUsage(current);
 return usage.total.total === undefined ? "Token 未返回" : number(usage.total.total) + " tokens" + (usage.total.count < usage.models ? `（${usage.total.count}/${usage.models} 次已知）` : "");
}
function applyLayout(): void {
 $("app-shell").classList.toggle("sidebar-collapsed", sidebarCollapsed);
 $("workbench").classList.toggle("trace-collapsed", traceCollapsed);
 $("workbench").classList.toggle("trace-focused", traceFocused && !traceCollapsed);
 $("trace-focus").textContent = traceFocused ? "恢复对话" : "放大轨迹";
 $("trace-focus").setAttribute("aria-pressed", String(traceFocused));
 $("sidebar-toggle").setAttribute("aria-expanded", String(!sidebarCollapsed));
 $("sidebar-toggle").setAttribute("aria-label", sidebarCollapsed ? "展开任务侧栏" : "收起任务侧栏");
 $("sidebar-toggle").textContent = sidebarCollapsed ? "☰" : "‹";
 $("trace-toggle").setAttribute("aria-expanded", String(!traceCollapsed));
 $("trace-summary").setAttribute("aria-expanded", String(!traceCollapsed));
 $("task-home").hidden = page !== "home";
 $("workbench").hidden = page === "home";
 updateSplitWidth();
}
function updateURL(id: string | null, fresh = false): void {
 const url = new URL(location.href); url.search = ""; url.hash = "";
 if (id) url.searchParams.set("run", id); else if (fresh) url.searchParams.set("new", "1");
 if (url.href !== location.href) window.history.pushState(null, "", url);
}
function resetRunView(): void {
 run = null; activeId = null; selected = null; pointerPart = ""; traceFocused = false; batchStates.clear(); recordFeedback = ""; detailOpen = false; graph = { steps: [], unlinkedTools: [] };
 $("download").disabled = true; window.clearTimeout(pollTimer);
 document.querySelector(".trace-pane")?.classList.remove("detail-open");
 setHTML("detail-heading", '<h2>选择一个步骤查看原始记录</h2>'); setHTML("detail-content", ""); setHTML("timeline", "");
 $("event-count").textContent = "尚无记录"; $("run-id").textContent = "";
 $("status").textContent = "等待任务"; $("status").dataset.status = "";
 $("metrics").textContent = "提交任务后显示实际用量与耗时";
 $("trace-summary").textContent = "执行过程 · 尚未运行";
 if (config) { $("model-label").textContent = config.configured ? config.model : "模型未配置"; $("workspace-label").textContent = "只读工作区 · " + config.workspace; }
}
function renderTaskLists(): void {
 const date = (item: RunSummary): string => new Date(item.created_at * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
 setHTML("task-list", items.map(item => `<button id="task-${esc(item.id)}" class="task-item ${activeId === item.id ? "active" : ""}" data-run="${esc(item.id)}" aria-current="${activeId === item.id}" title="${esc(item.task)}"><strong>${esc(item.task.slice(0, 100))}</strong><span><i class="task-dot ${esc(item.status)}"></i>${esc(statuses[item.status])}<time>${date(item)}</time></span></button>`).join("") || '<p class="list-empty">尚无任务记录</p>');
 setHTML("home-task-list", items.map(item => `<button id="home-task-${esc(item.id)}" class="home-task" data-run="${esc(item.id)}"><span><strong>${esc(item.task.slice(0, 140))}</strong><small>${esc(item.model)} · ${esc(item.id.slice(0, 8))}</small></span><span class="task-state ${esc(item.status)}">${esc(statuses[item.status])}</span><time>${date(item)}</time><span aria-hidden="true">↗</span></button>`).join("") || '<div class="home-empty"><h2>从一个小任务开始</h2><p>提交一个只读任务，模型请求和工具回执会一起保存在本地。</p><button class="primary" data-new-task>创建第一个任务 →</button></div>');
 $("task-count").textContent = `${items.length} 个任务`;
 $("home-count").textContent = `${items.length} 个已记录任务`;
}
async function showHome(changeURL = true): Promise<void> {
 page = "home"; resetRunView(); showError(""); if (changeURL) updateURL(null); applyLayout(); renderTaskLists();
 await pollTaskList();
}
function showNewTask(changeURL = true): void {
 page = "new"; resetRunView(); showError(""); if (changeURL) updateURL(null, true); applyLayout(); renderTaskLists();
 $("conversation-title").textContent = "新任务";
 setHTML("conversation", '<div class="welcome"><span class="eyebrow">运行与观察</span><h3>从一个问题开始。</h3><p>输入任务，阅读回答。需要观察过程时，在右侧查看模型请求、工具与回执。</p><button class="example-button" data-example="先列出工作区文件，再读取 agent-loop.md。用两句话说明工具结果怎样返回模型，并引用一处原文作为依据。">使用示例笔记 →</button></div>');
 setHTML("graph", '<div class="empty-graph"><p>还没有执行记录。<br>提交任务后，过程会在这里出现。</p></div>');
 if (!config?.configured) showError("请先在服务端配置模型，然后重启。");
 $("task").focus(); render(); void pollTaskList();
}
async function pollTaskList(): Promise<void> {
 try {
  await refreshHistory();
  if (page !== "run") {
   render();
   window.clearTimeout(pollTimer);
   if (busy) pollTimer = window.setTimeout(() => { void pollTaskList(); }, 1200);
  }
 } catch (error) { $("home-note").textContent = message(error); if (page === "new") showError(message(error)); }
}
async function routeFromLocation(): Promise<void> {
 const params = new URL(location.href).searchParams;
 if (params.has("run")) await chooseRun(params.get("run") ?? "", false);
 else if (params.get("new") === "1") showNewTask(false);
 else await showHome(false);
}


function setHTML(id: string, html: string): void {
  const element = $(id);
  if (element.innerHTML === html) return;
  const scroll = element.scrollTop;
  const focused = document.activeElement;
  const focusID = focused instanceof HTMLElement && element.contains(focused) ? focused.id : "";
  element.innerHTML = html;
  element.scrollTop = scroll;
  if (focusID) document.getElementById(focusID)?.focus({ preventScroll: true });
}
function message(error: unknown): string { return error instanceof Error ? error.message : "请求失败"; }
function showError(text: string): void { $("error").textContent = text; $("error").hidden = !text; }
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...options });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(typeof object(result).error === "string" ? String(object(result).error) : "请求失败");
  // The local Go API validates persisted runs and model/tool inputs at its boundaries.
  return result as T;
}
function summary(event: TraceEvent): string {
  if (event.status === "running") return "等待实际返回";
  const output = event.output ?? {};
  if (event.kind === "model") {
    const calls = object(output.message).tool_calls;
    if (Array.isArray(calls) && calls.length) return "提出 " + calls.length + " 个工具调用";
    return output.finish_reason === "stop" ? "给出最终回答" : "结束原因：" + (output.finish_reason ?? output.error_type ?? "未取得响应");
  }
  if (event.kind === "tool") return typeof output.error === "string" ? "返回错误 · " + output.error : "返回实际结果";
  return typeof output.run_status === "string" ? statuses[output.run_status as RunStatus] ?? output.run_status : event.title;
}
function title(event: TraceEvent): string {
  if (event.kind === "model") return "第 " + event.turn + " 次模型请求";
  if (event.kind === "tool") return event.title === "read_file" ? "读取文件" : event.title === "list_files" ? "列出文件" : event.title;
  return event.title;
}
function rowRole(event: TraceEvent): string {
 if (event.kind === "input") return "USER";
 if (event.kind === "model") return object(event.output?.message).role === "assistant" ? "ASSISTANT" : "MODEL";
 if (event.kind === "tool") return "TOOL";
 if (typeof event.input.system === "string") return "CONTEXT";
 if (typeof event.output?.tool_call_id === "string" && typeof event.output.content === "string") return "RESULT";
 if (typeof event.output?.run_status === "string") return "STOP";
 return "PROGRAM";
}
function rowText(event: TraceEvent): string {
 if (event.status === "running") return event.kind === "model" ? "模型请求中，等待响应" : event.title + " · 进行中";
 if (event.kind === "input") return typeof event.input.task === "string" ? event.input.task : event.title;
 if (event.kind === "model") {
  const content = object(event.output?.message).content;
  return typeof content === "string" && content.trim() ? content : summary(event);
 }
 if (event.kind === "tool") {
  const args = typeof event.input.arguments === "string" ? event.input.arguments : JSON.stringify(event.input.arguments);
  const result = event.output?.error ?? (event.output?.content ? String(event.output.content) : event.output?.files ? JSON.stringify(event.output.files) : summary(event));
  return event.title + " " + args + " → " + String(result);
 }
 if (typeof event.input.system === "string") return "准备上下文 · 模型请求额度 " + String(event.input.max_requests ?? "—") + " · " + event.input.system;
 if (rowRole(event) === "RESULT") return "交回工具回执 · " + String(event.output?.content ?? "");
 return event.title;
}
function eventRow(event: TraceEvent, related: Set<string>): string {
 const usage = tokenUsage(event), text = rowText(event);
 const modelTokens = event.kind === "model" ? `<small>${usage.total === undefined ? event.status === "running" ? "等待用量" : "Token 未返回" : number(usage.total) + " tokens"}</small>` : "";
 return `<button id="node-${esc(event.id)}" class="trace-row kind-${event.kind} ${event.status} ${selected === event.id ? "selected" : ""} ${related.has(event.id) ? "related" : ""}" data-event="${esc(event.id)}" aria-pressed="${selected === event.id}" title="${esc(event.id + " · " + event.title + " · " + text.slice(0, 500))}"><span class="row-index">${esc(event.id.replace(/^e0*/, "") || "0")}</span><span class="role-tag role-${rowRole(event).toLowerCase()}"${rowRole(event) === "PROGRAM" ? ' title="程序控制：Loop 自身的调度步骤，例如选择工具执行器；不是模型消息角色。"' : ""}>${rowRole(event)}</span><span class="row-content">${event.kind === "model" ? `<span class="request-mark">请求 ${event.turn}</span>` : ""}${esc(text.replace(/\s+/g, " ").slice(0, 700))}</span><span class="row-metric">${event.status === "running" ? "进行中" : formatDuration(event.d)}${modelTokens}</span></button>`;
}
function callFor(id: string): { call: CallLink; model: TraceEvent } | undefined {
  for (const step of graph.steps) for (const call of step.calls) if (call.tool?.id === id || call.receipt?.id === id) return { call, model: step.model };
  return undefined;
}
function pointer(event: TraceEvent): string { return "/events/" + run!.events.findIndex(item => item.id === event.id); }
function renderGraph(current: Run): void {
 const related = relatedEvents(graph, selected);
 const elapsed = current.status === "running" ? Math.max(0, Date.now() / 1000 - current.created_at) : current.duration ?? 0;
 const timeline = timelineLayout(current, "time", elapsed), steps = timelineLayout(current, "steps");
 const lanes: [EventKind, string][] = [["input", "输入"], ["model", "模型"], ["tool", "工具"], ["control", "程序"]];
 const marker = (event: TraceEvent, left: number, width: number, step = false): string => `<button class="timeline-bar kind-${event.kind} ${event.status} ${selected===event.id?"selected":""} ${related.has(event.id)?"related":""}" data-event="${esc(event.id)}" style="left:${left*100}%;width:${width*100}%" aria-pressed="${selected===event.id}" aria-label="${step?"步骤":"耗时"} ${esc(event.id + " " + title(event))}" title="${esc(event.id + " · " + title(event) + " · " + (event.status==="running"?"进行中":formatDuration(event.d)))}">${step ? esc(event.id.replace(/^e0*/, "")) : ""}</button>`;
 setHTML("timeline", `<div class="timeline-lane step-lane"><span>步骤</span><div class="step-track">${steps.bars.map(({event,left,width})=>marker(event,left,width,true)).join("")}</div></div><div class="timeline-axis"><span>耗时</span><div>${[0,.5,1].map(n => `<span>${(timeline.extent*n).toFixed(2)}s</span>`).join("")}</div></div>${lanes.map(([kind,label]) => `<div class="timeline-lane"><span>${label}</span><div class="lane-track">${timeline.bars.filter(bar=>bar.event.kind===kind).map(({event,left,width})=>marker(event,left,width)).join("")}</div></div>`).join("")}`);
 let html = graph.unlinkedTools.length ? `<p class="stream-note">${graph.unlinkedTools.length} 条工具记录的调用来源尚未核对，以下按原始顺序保留。</p>` : "";
 const sections = executionSections(current);
 for (const section of sections) {
  const step = graph.steps.find(item => item.model.id === section.anchor.id);
  const rest = section.kind === "request" ? section.events.slice(1) : [];
  if (section.kind !== "request") {
   html += `<section class="stream-section phase-${section.kind}" aria-label="${section.kind==="start"?"任务与上下文":"运行结束"}">${section.events.map(event=>eventRow(event,related)).join("")}</section>`;
   continue;
  }
  html += `<section class="stream-section phase-request" aria-label="模型请求 ${section.anchor.turn}">${eventRow(section.anchor,related)}`;
  if (rest.length) {
   const open = batchStates.get(section.anchor.id) ?? current.events.length <= 12;
   const names = rest.filter(event=>event.kind==="tool").map(event=>event.title);
   const errors = rest.filter(event=>event.kind==="tool" && event.status==="failed").length;
   html += `<button id="batch-${esc(section.anchor.id)}" class="batch-summary ${errors ? "has-error" : ""}" data-batch="${esc(section.anchor.id)}" aria-expanded="${open}" aria-controls="batch-events-${esc(section.anchor.id)}"><span class="disclosure-arrow">${open?"▾":"▸"}</span><span>${names.length ? names.length + " 个工具调用 · " + [...new Set(names)].map(esc).join("、") : "程序处理记录"}</span><small>${rest.length} 条事件${errors ? ` · ${errors} 次错误` : ""}</small></button><div id="batch-events-${esc(section.anchor.id)}" class="batch-events" ${open?"":"hidden"}>${rest.map(event=>eventRow(event,related)).join("")}</div>`;
   const forwarded = step?.calls.filter(call=>call.nextModel) ?? [];
   if (forwarded.length) html += `<button class="stream-receipt-link" data-event="${esc(forwarded[0].nextModel!.id)}" data-part="/input/messages">↳ ${forwarded.length} 条回执已进入请求 ${forwarded[0].nextModel!.turn} · 查看消息依据</button>`;
   else if (step?.calls.some(call=>call.receipt)) html += `<p class="stream-note">${current.status==="budget_exhausted" ? "回执已记录；模型额度耗尽，没有下一次请求。" : "回执已记录，尚未观察到携带它的后续请求。"}</p>`;
  }
  html += "</section>";
 }
 if (!current.events.length) html = `<div class="empty-graph"><p>${current.status === "running" ? "等待第一个执行事件…" : "本次没有可用的执行事件，请查看运行状态。"}</p></div>`;
 setHTML("graph", html);
 $("event-count").textContent = `完整事件流 · ${current.events.length} 条`;
}
function explanation(event: TraceEvent): string {
  if (event.kind === "model") {
    const messages = Array.isArray(event.input.messages) ? event.input.messages : [];
    const results = messages.filter(value => object(value).role === "tool").length;
    const calls = graph.steps.find(step => step.model.id === event.id)?.calls.length ?? 0;
    return `程序把当前上下文发送给模型，其中包含 ${results} 条工具回执。` + (event.status === "running" ? "这次请求尚未返回，后续动作还未知。" : calls ? `模型提出 ${calls} 个工具调用。调用参数由模型给出，是否允许以及怎样执行，由程序处理。` : event.output?.finish_reason === "stop" ? "模型返回 stop，结束了这次循环。这不证明回答中的每项内容都正确。" : "模型没有正常返回可继续的动作；查看实际输出中的错误或结束原因。" );
  }
  const linked = callFor(event.id);
  if (linked) {
    const { call, model } = linked;
    if (event.kind === "tool") return `这是第 ${model.turn} 次模型响应提出的 ${call.name} 调用。` + (event.status === "running" ? "程序正在处理，尚无结果。" : event.status === "failed" ? "程序返回了错误，错误本身也可以成为模型的输入。" : "程序已返回实际结果。") + (call.nextModel ? ` 已核对：这条回执出现在第 ${call.nextModel.turn} 次模型请求的消息中。` : call.receipt ? "回执已记录，但尚无后续模型请求接收它的证据。" : "尚未找到与这次执行结果对应的回执记录。");
    return "程序把工具结果整理为回执，并保留原调用编号。写入回执本身不会发起模型请求。" + (call.nextModel ? ` 后续第 ${call.nextModel.turn} 次模型请求确实携带了它。` : "当前尚无后续模型请求携带它的证据。");
  }
  return event.explanation;
}
function eventLink(event: TraceEvent, label: string, part = ""): string { return `<button class="text-link" data-event="${esc(event.id)}" data-part="${esc(part)}"${part ? ' data-detail="io"' : ""}>${esc(label)} <span aria-hidden="true">↗</span></button>`; }
function renderDetail(current: Run): void {
  const event = current.events.find(item => item.id === selected);
  if (!event) return;
  const tabs: [DetailTab, string][] = [["io", "原始记录"], ["code", "源码"], ["overview", "说明"]];
  document.querySelector(".trace-pane")?.classList.toggle("detail-open", detailOpen);
  setHTML("detail-heading", `<div><span class="eyebrow">${roles[event.kind]} · ${esc(event.id)}</span><h2>${esc(title(event))}</h2></div><div class="detail-tabs" role="tablist" aria-label="步骤详情">${tabs.map(([id, label]) => `<button id="detail-tab-${id}" role="tab" aria-controls="detail-content" aria-selected="${detailTab === id}" data-tab="${id}" class="${detailTab === id ? "active" : ""}">${label}</button>`).join("")}</div><button id="detail-toggle" class="detail-toggle" data-toggle-detail aria-expanded="${detailOpen}" aria-controls="detail-content">${detailOpen ? "收起 ↓" : "展开记录 ↑"}</button>`);
  const source = current.source[event.code];
  const usage = tokenUsage(event);
  const stats = `<div class="detail-stats"><span>耗时 <b>${event.status === "running" ? "进行中" : formatDuration(event.d)}</b></span>${event.kind === "model" ? `<span>输入 <b>${number(usage.input)}</b></span><span>输出 <b>${number(usage.output)}</b></span><span>合计 <b>${number(usage.total)}</b></span>${usage.cached !== undefined ? `<span>其中缓存输入 <b>${number(usage.cached)}</b></span>` : ""}` : ""}</div>`;
  let content = "";
  if (detailTab === "overview") {
    content = `<p class="step-explanation">${esc(explanation(event))}</p>`;
    const connections: string[] = [];
    for (const step of graph.steps) for (const call of step.calls) {
      if (event.id === step.model.id && call.tool) connections.push(eventLink(call.tool, "本次提出 → " + title(call.tool)));
      if (event.id === call.tool?.id || event.id === call.receipt?.id) {
        connections.push(eventLink(step.model, "来自第 " + step.model.turn + " 次模型响应", "/output/message/tool_calls/" + call.callIndex));
        if (call.receipt && event.id !== call.receipt.id) connections.push(eventLink(call.receipt, "对应的工具回执"));
        if (call.nextModel) connections.push(eventLink(call.nextModel, "进入第 " + call.nextModel.turn + " 次请求的消息", "/input/messages/" + call.messageIndex));
      }
      if (event.id === call.nextModel?.id && call.tool) connections.push(eventLink(call.tool, "本次收到 ← " + title(call.tool) + (call.tool.status === "failed" ? "的错误" : "的结果")));
    }
    if (connections.length) content += `<div class="connections">${[...new Set(connections)].join("")}</div>`;
    content += `<div class="step-facts"><span>事件开始 <b>${event.t.toFixed(3)}s</b></span><span>实际状态 <b>${event.status === "running" ? "进行中" : event.status === "failed" ? "失败或被拒绝" : "已返回"}</b></span>${source ? `<span>对应函数 <b>${esc(source.path)}:${source.line}</b></span>` : ""}</div>`;
    if (event.kind === "tool" && event.output?.error) content += `<div class="error-evidence"><code>${esc(event.output.error)}</code><p>${esc(event.output.message ?? "工具没有执行成功。")}</p></div>`;
  } else if (detailTab === "io") {
    const filename = current.status === "running" ? "trace.jsonl" : "run.json";
    content = `<div class="record-link"><button id="open-record" class="text-link" data-open-record ${openingRecord ? "disabled" : ""} title="在本机编辑器中打开记录，定位到所选事件或字段的实际行">${openingRecord ? "正在打开…" : "打开本地记录 ↗"}</button><code>${filename} · ${esc(event.id)}</code><span id="record-feedback" role="status">${esc(recordFeedback)}</span></div>`;
    if (pointerPart) {
      let value: unknown = event;
      for (const segment of pointerPart.split("/").slice(1)) value = Array.isArray(value) ? value[Number(segment)] : object(value)[segment];
      content += `<div class="evidence-fragment"><h3>已定位的消息 / 字段</h3><pre>${pretty(value ?? null)}</pre></div>`;
    }
    content += `<div class="json-pair"><section><h3>实际输入 <code>${esc(pointer(event))}/input</code></h3><pre>${pretty(event.input)}</pre></section><section><h3>实际输出 <code>${esc(pointer(event))}/output</code></h3><pre>${event.status === "running" ? "尚未返回" : pretty(event.output)}</pre></section></div><p class="detail-note">${current.status === "running" ? "运行中打开 trace.jsonl 的对应事件行；结束后打开 run.json。" : "打开后定位到所选事件或字段的实际行。"}查看记录不会重新运行任务。</p>`;
  } else content = source ? `<div class="source-heading"><code>${esc(source.path)}:${source.line}</code><span>本次运行保存的函数源码</span></div><pre class="source-code">${esc(source.code)}</pre><p class="detail-note">关联到函数整体，未声称精确到执行语句。历史源码不会被当前文件覆盖。</p>` : '<p class="detail-note">这条历史记录没有对应的源码快照。</p>';
  setHTML("detail-content", stats + content);
}
function render(): void {
  if (!config) return;
  $("submit").disabled = busy || !config.configured;
  $("submit").textContent = busy ? "正在运行…" : "运行任务 →";
  if (!run) return;
  const current = run;
  $("conversation-title").textContent = current.task;
  $("conversation-title").title = current.task;
  graph = buildTraceGraph(current);
  const previous = selected;
  if ($("follow").checked && current.status === "running") selected = current.events.at(-1)?.id ?? null;
  if (!current.events.some(event => event.id === selected)) selected = graph.steps[0]?.model.id ?? current.events[0]?.id ?? null;
  if (selected !== previous) {
   pointerPart = ""; recordFeedback = "";
   if ($("follow").checked && selected) {
    const section = executionSections(current).find(section => section.events.some(event => event.id === selected));
    if (section?.kind === "request") batchStates.set(section.anchor.id, true);
   }
  }
  $("model-label").textContent = current.model;
  $("workspace-label").textContent = (current.workspace === config.workspace ? "只读工作区 · " : "历史工作区 · ") + current.workspace;
  $("workspace-label").title = current.workspace;
  $("run-id").textContent = "RUN " + current.id.slice(0, 8);
  $("status").textContent = statuses[current.status];
  $("status").dataset.status = current.status;
  const seconds = current.status === "running" ? Math.max(0, Date.now() / 1000 - current.created_at) : current.duration ?? 0;
  $("metrics").textContent = `${current.model_requests} 次模型 · ${current.tool_calls} 次工具 · ${totalTokens(current)} · ${formatDuration(seconds)}`;
  $("trace-summary").textContent = `执行过程 · ${totalTokens(current)} · ${formatDuration(seconds)} ${traceCollapsed ? "‹" : "›"}`;
  const usage = runUsage(current);
  $("metrics").title = `输入 ${number(usage.input.total)}（${usage.input.count}/${usage.models} 次已知） · 输出 ${number(usage.output.total)}（${usage.output.count}/${usage.models} 次已知） · 缓存输入 ${number(usage.cached.total)}（输入子项，不重复计入总计）`;
  $("download").disabled = false;
  const error = current.events.find(event => event.kind === "tool" && event.status === "failed");
  setHTML("conversation", `<article class="message user-message"><div class="speaker"><span class="avatar">你</span><span>本次任务</span></div><p>${esc(current.task)}</p></article><article class="message assistant-message"><div class="speaker"><span class="avatar agent-avatar">↻</span><span>Loop</span><small>${current.status === "running" ? "执行中" : "最终回答"}</small></div>${current.answer ? `<p>${esc(current.answer)}</p>` : `<div class="answer-placeholder">${current.status === "running" ? '<span class="waiting-dot"></span> 正在处理任务，右侧展示实际发生的步骤。' : "这次没有产生最终回答。请在右侧查看停止位置。"}</div>`}${error ? `<button class="error-link" data-event="${esc(error.id)}">${current.tool_errors} 次工具错误 · 在图中查看 ↗</button>` : ""}${current.status === "completed" ? '<p class="acceptance-note">循环已结束 · 请对照工具结果核对回答</p>' : ""}</article>`);
  renderGraph(current);
  renderDetail(current);
  if ($("follow").checked && current.status === "running" && previous !== selected) document.getElementById("node-" + selected)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
async function refreshHistory(): Promise<RunSummary[]> {
 items = await api<RunSummary[]>("/api/runs");
 busy = items.some(item => item.status === "running");
 renderTaskLists();
 $("submit").disabled = busy || !config?.configured;
 return items;
}
async function poll(): Promise<void> {
  if (!activeId) return;
  const id = activeId;
  try {
    const snapshot = await api<Run>("/api/runs/" + encodeURIComponent(id));
    if (activeId !== id) return;
    if (!run) $("follow").checked = snapshot.status === "running";
    run = snapshot;
    if (run.status !== "running") await refreshHistory();
    if (activeId !== id) return;
    render();
    window.clearTimeout(pollTimer);
    if (run.status === "running" || busy) pollTimer = window.setTimeout(() => { void poll(); }, 650);
  } catch (error) {
    if (activeId !== id) return;
    showError(message(error)); $("submit").disabled = busy || !config?.configured;
    if (!run) {
     $("conversation-title").textContent = "记录未加载";
     setHTML("conversation", `<div class="welcome"><h3>无法读取这条任务</h3><p>${esc(message(error))}</p><button data-home>返回所有任务</button></div>`);
     setHTML("graph", '<div class="empty-graph"><p>没有可展示的记录。</p></div>');
    }
  }
}
async function chooseRun(id: string, changeURL = true): Promise<void> {
  page = "run"; batchStates.clear();
  activeId = id; run = null; selected = null; pointerPart = ""; recordFeedback = ""; detailOpen = false;
  window.clearTimeout(pollTimer); showError(""); applyLayout(); renderTaskLists();
  $("conversation-title").textContent = "正在读取任务…";
  setHTML("graph", '<div class="empty-graph"><p>正在读取这次运行…</p></div>');
  setHTML("conversation", '<p class="muted loading-note">正在载入任务和回答…</p>');
  setHTML("detail-heading", ""); setHTML("detail-content", ""); setHTML("timeline", "");
  if (changeURL) updateURL(id);
  await poll();
}
function selectEvent(id: string, part = "", detail?: string): void {
  if (!run?.events.some(event => event.id === id)) return;
  selected = id; pointerPart = part; recordFeedback = ""; detailOpen = true;
  const section = executionSections(run).find(section=>section.events.some(event=>event.id===id));
  if (section?.kind === "request") batchStates.set(section.anchor.id,true); $("follow").checked = false;
  detailTab = detail === "overview" || detail === "code" ? detail : "io";
  if (traceCollapsed) { traceCollapsed = false; savePreference("loop.traceCollapsed", false); applyLayout(); }
  render();
  const target = document.getElementById("node-" + id) ?? document.getElementById("receipt-" + id);
  target?.scrollIntoView({ block: "nearest", inline: "nearest" });
  target?.focus({ preventScroll: true });
}
async function openRecord(): Promise<void> {
 if (!run || !selected || !config || openingRecord) return;
 const runID = run.id, eventID = selected, field = pointerPart;
 openingRecord = true; recordFeedback = ""; renderDetail(run);
 try {
  const result = await api<{ path: string; line: number; editor: string }>(`/api/runs/${encodeURIComponent(runID)}/open-record`, {
   method: "POST", headers: { "Content-Type": "application/json", "X-Lab-Token": config.token }, body: JSON.stringify({ event_id: eventID, field })
  });
  if (run?.id === runID && selected === eventID && pointerPart === field) recordFeedback = `${result.editor} · ${result.path.split(/[\\/]/).at(-1)}:${result.line}`;
 } catch (error) {
  if (run?.id === runID && selected === eventID && pointerPart === field) recordFeedback = message(error);
 } finally { openingRecord = false; if (run) renderDetail(run); }
}
document.addEventListener("click", event => {
  if (!(event.target instanceof Element)) return;
  const batch = event.target.closest<HTMLElement>("[data-batch]")?.dataset.batch;
  if (batch && run) { batchStates.set(batch,!(batchStates.get(batch) ?? run.events.length<=12)); render(); }
  const taskLink = event.target.closest<HTMLElement>("[data-run]");
  if (taskLink?.dataset.run) { void chooseRun(taskLink.dataset.run); return; }
  if (event.target.closest("[data-home]")) { void showHome(); return; }
  if (event.target.closest("[data-new-task]")) { showNewTask(); return; }
  if (event.target.closest("[data-toggle-trace]")) { traceCollapsed = !traceCollapsed; savePreference("loop.traceCollapsed", traceCollapsed); applyLayout(); render(); }
  if (event.target.closest("[data-toggle-detail]")) { detailOpen = !detailOpen; render(); }
  const node = event.target.closest<HTMLElement>("[data-event]");
  if (node?.dataset.event) selectEvent(node.dataset.event, node.dataset.part ?? "", node.dataset.detail);
  const tab = event.target.closest<HTMLElement>("[data-tab]")?.dataset.tab;
  if (tab === "overview" || tab === "io" || tab === "code") { detailTab = tab; render(); }
  if (event.target.closest("[data-open-record]")) void openRecord();
  const example = event.target.closest<HTMLElement>("[data-example]")?.dataset.example;
  if (example) { $("task").value = example; $("task").focus(); }
});
$("detail-heading").addEventListener("keydown", event => {
  if (!(event.target instanceof HTMLElement) || !event.target.dataset.tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const tabs: DetailTab[] = ["io", "code", "overview"];
  const index = tabs.indexOf(detailTab);
  detailTab = event.key === "Home" ? "io" : event.key === "End" ? "overview" : tabs[(index + (event.key === "ArrowRight" ? 1 : 2)) % 3];
  render(); document.getElementById("detail-tab-" + detailTab)?.focus();
});
$("trace-focus").onclick = () => { traceFocused=!traceFocused; traceCollapsed=false; applyLayout(); };
$("follow").onchange = () => render();
$("sidebar-toggle").onclick = () => { sidebarCollapsed = !sidebarCollapsed; savePreference("loop.sidebarCollapsed", sidebarCollapsed); applyLayout(); };
$("refresh-tasks").onclick = () => { void refreshHistory().catch(error => { $("home-note").textContent = message(error); }); };
window.addEventListener("popstate", () => { void routeFromLocation(); });
$("task-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!config || busy) return;
  showError(""); busy = true; $("submit").disabled = true; $("submit").textContent = "正在提交…";
  try {
    const result = await api<{ id: string }>("/api/runs", { method: "POST", headers: { "Content-Type": "application/json", "X-Lab-Token": config.token }, body: JSON.stringify({ task: $("task").value, max_requests: Number($("budget").value) }) });
    activeId = result.id; await refreshHistory(); await chooseRun(result.id);
  } catch (error) {
    showError(message(error));
    try { await refreshHistory(); } catch { busy = true; }
    $("submit").disabled = busy || !config.configured; $("submit").textContent = busy ? "请等待当前任务" : "运行任务 →";
  }
});
$("download").onclick = () => {
  if (!run) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(run, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = "loop-run-" + run.id + ".json";
  anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};
async function initialize(): Promise<void> {
  try {
    config = await api<Config>("/api/config");
    $("workspace-label").textContent = "只读工作区 · " + config.workspace;
    $("workspace-label").title = config.workspace;
    $("model-label").textContent = config.configured ? config.model : "模型未配置";
    $("task").value = config.default_task;
    $("history-note").textContent = config.history.skipped ? `跳过 ${config.history.skipped} 条无效或未结束记录，原文件保留。` : "历史详情按需读取，不会重跑任务。";
    $("access").textContent = "新任务只读目录：" + config.workspace;
    $("submit").disabled = !config.configured;
    if (!config.configured) showError("在启动服务的终端配置 OPENAI_API_KEY 和 OPENAI_MODEL，然后重启服务。");
    await refreshHistory();
    await routeFromLocation();
  } catch (error) { showError("无法连接本机服务：" + message(error)); $("home-note").textContent = "无法连接本机服务：" + message(error); }
}
void initialize();
