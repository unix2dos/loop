import { conversationID, conversationHeads, conversationOverview, conversationTitle, shortTitle, traceKey } from "./conversation.js";
import type { Config, EventKind, Run, RunStatus, RunSummary, TraceEvent } from "./types.js";
import { buildTraceGraph, object, relatedEvents, tokenUsage, runUsage, formatDuration, executionSections, timelineLayout } from "./trace-graph.js";
import type { CallLink, TraceGraph } from "./trace-graph.js";

interface FormElements {
  task: HTMLTextAreaElement; budget: HTMLSelectElement;
  submit: HTMLButtonElement; download: HTMLButtonElement; "task-form": HTMLFormElement;
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
let newExercise = false;
let activeId: string | null = null, selected: string | null = null;
let graph: TraceGraph = { steps: [], unlinkedTools: [] };
let detailTab: DetailTab = "io", pointerPart = "", busy = false, detailOpen = false;
let pollTimer: number | undefined;
let openingRecord = false, recordFeedback = "";
let conversation: Run[] = [], conversationReady = false;
const runCache = new Map<string, Run>();
const batchStates = new Map<string, boolean>(), turnStates = new Map<string, boolean>();
let selectedRunID: string | null = null;
function selectedRun(): Run | null { return conversation.find(item=>item.id===selectedRunID) ?? run; }
const nodeID = (runID: string, eventID: string): string => `node-${runID}-${eventID}`;
let items: RunSummary[] = [], page: "home" | "new" | "run" | "settings" = "home";
function readPreference(key: string, fallback = false): boolean { try { const value = localStorage.getItem(key); return value === null ? fallback : value === "true"; } catch { return fallback; } }
let sidebarCollapsed = readPreference("loop.sidebarCollapsed", innerWidth < 900), traceCollapsed = readPreference("loop.traceCollapsed");
function savePreference(key: string, value: boolean | number): void { try { localStorage.setItem(key, String(value)); } catch { /* Browser storage is optional. */ } }
function readBudget(): number {
 try {
  const n = Number(localStorage.getItem("loop.maxRequests"));
  if (n >= 1 && n <= 8 && Number.isInteger(n)) return n;
 } catch { /* Browser storage is optional. */ }
 return 4;
}
let maxRequests = readBudget(), settingsReturn: "home" | "new" | "run" = "home";
let followLatest = true, followScrollLock = 0, renamingId: string | null = null;
// ponytail: Conversation Title overrides stay in localStorage. Ceiling: another browser and run export will not see them. Upgrade: persist on the root Run.
function loadTitles(): Record<string, string> {
 try {
  const parsed: unknown = JSON.parse(localStorage.getItem("loop.conversationTitles") || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const titles: Record<string, string> = {};
  for (const [id, title] of Object.entries(parsed as Record<string, unknown>)) if (typeof title === "string") titles[id] = title;
  return titles;
 } catch { return {}; }
}
function saveTitle(id: string, value: string, task: string): void {
 const titles = loadTitles(), next = value.replace(/\s+/g, " ").trim();
 if (!next || next === shortTitle(task)) delete titles[id];
 else titles[id] = Array.from(next).slice(0, 40).join("");
 try { localStorage.setItem("loop.conversationTitles", JSON.stringify(titles)); } catch { /* Browser storage is optional. */ }
}
function rootTask(item: RunSummary): string { return items.find(root => root.id === conversationID(item))?.task ?? item.task; }
function displayTitle(item: RunSummary): string { return conversationTitle(rootTask(item), loadTitles()[conversationID(item)] ?? ""); }
let conversationShare = .65;
try {
 const saved = Number(localStorage.getItem("loop.conversationShare"));
 if (Number.isFinite(saved) && saved > 0 && saved < 1) conversationShare = saved;
} catch { /* Browser storage is optional. */ }
const splitter = $("trace-resize"), workbench = $("workbench");
function updateSplitWidth(share?: number): void {
 if (!splitter.offsetWidth) return; // Hidden in collapsed and phone layouts.
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
let traceListShare = .58;
try { const saved=Number(localStorage.getItem("loop.traceListShare")); if (saved>0 && saved<1) traceListShare=saved; } catch { /* Optional browser preference. */ }
const detailDivider=$("detail-resize"), tracePane=$("trace-pane");
function detailSpace(): {top:number; available:number} {
 const header=tracePane.querySelector<HTMLElement>(".trace-heading")!.getBoundingClientRect();
 return {top:header.bottom,available:tracePane.clientHeight-header.height-detailDivider.offsetHeight};
}
function updateDetailHeight(share?: number): void {
 if (!detailOpen || !detailDivider.offsetHeight || !tracePane.clientHeight) return;
 const {available}=detailSpace(); if (available<=0) return;
 const minList=Math.min(100,available*.4), minDetail=Math.min(160,available*.4);
 const height=Math.max(minList,Math.min(available-minDetail,available*(share??traceListShare)));
 if (share!==undefined) traceListShare=height/available;
 tracePane.style.setProperty("--trace-list-height",height+"px");
 detailDivider.setAttribute("aria-valuenow",String(Math.round(height/available*100)));
 detailDivider.setAttribute("aria-valuemin",String(Math.ceil(minList/available*100)));
 detailDivider.setAttribute("aria-valuemax",String(Math.floor((available-minDetail)/available*100)));
 detailDivider.setAttribute("aria-valuetext",`轨迹列表 ${Math.round(height)} 像素，原始记录 ${Math.round(available-height)} 像素`);
}
let detailDragOffset=0;
detailDivider.onpointerdown=event=>{
 if (event.button!==0 || !event.isPrimary) return;
 event.preventDefault();detailDivider.focus();detailDragOffset=event.clientY-detailDivider.getBoundingClientRect().top;
 detailDivider.setPointerCapture(event.pointerId);document.body.classList.add("resizing-detail");
};
detailDivider.onpointermove=event=>{
 if (!detailDivider.hasPointerCapture(event.pointerId)) return;
 const {top,available}=detailSpace();if(available>0)updateDetailHeight((event.clientY-top-detailDragOffset)/available);
};
detailDivider.onpointerup=event=>{if(detailDivider.hasPointerCapture(event.pointerId))detailDivider.releasePointerCapture(event.pointerId);};
detailDivider.onlostpointercapture=()=>{document.body.classList.remove("resizing-detail");savePreference("loop.traceListShare",traceListShare);};
detailDivider.ondblclick=()=>{updateDetailHeight(.58);savePreference("loop.traceListShare",traceListShare);};
detailDivider.onkeydown=event=>{
 if(!["ArrowUp","ArrowDown","Home","End"].includes(event.key))return;
 event.preventDefault();const current=Number(detailDivider.getAttribute("aria-valuenow"))/100;
 updateDetailHeight(event.key==="Home"?0:event.key==="End"?1:current+(event.key==="ArrowUp"?-.03:.03));savePreference("loop.traceListShare",traceListShare);
};
const detailObserver=new ResizeObserver(()=>updateDetailHeight());
detailObserver.observe(tracePane);detailObserver.observe(tracePane.querySelector(".trace-heading")!);
const number = (value: number | undefined): string => value === undefined ? "未返回" : value.toLocaleString("zh-CN");
function totalTokens(current: Pick<Run, "events">): string {
 const usage = runUsage(current);
 return usage.total.total === undefined ? "Token 未返回" : number(usage.total.total) + " tokens" + (usage.total.count < usage.models ? `（${usage.total.count}/${usage.models} 次已知）` : "");
}
function applyLayout(): void {
 $("app-shell").classList.toggle("sidebar-collapsed", sidebarCollapsed);
 $("workbench").classList.toggle("trace-collapsed", traceCollapsed);
 $("sidebar-toggle").setAttribute("aria-expanded", String(!sidebarCollapsed));
 $("sidebar-toggle").setAttribute("aria-label", sidebarCollapsed ? "展开任务侧栏" : "收起任务侧栏");
 $("sidebar-toggle").textContent = sidebarCollapsed ? "☰" : "‹";
 $("trace-toggle").setAttribute("aria-expanded", String(!traceCollapsed));
 $("trace-summary").setAttribute("aria-expanded", String(!traceCollapsed));
 $("task-home").hidden = page !== "home";
 $("settings").hidden = page !== "settings";
 $("workbench").hidden = page === "home" || page === "settings";
 updateSplitWidth();
}
function updateURL(id: string | null, fresh = false, settings = false): void {
 const url = new URL(location.href); url.search = ""; url.hash = "";
 if (id) url.searchParams.set("run", id); else if (fresh) url.searchParams.set("new", "1"); else if (settings) url.searchParams.set("settings", "1");
 if (url.href !== location.href) window.history.pushState(null, "", url);
}
function resetRunView(): void {
 newExercise = false;
 conversation = []; conversationReady = false; runCache.clear(); turnStates.clear(); selectedRunID = null;
 run = null; activeId = null; selected = null; pointerPart = ""; batchStates.clear(); recordFeedback = ""; detailOpen = false; graph = { steps: [], unlinkedTools: [] };
 $("download").disabled = true; $("follow-latest").hidden = true; window.clearTimeout(pollTimer);
 document.querySelector(".trace-pane")?.classList.remove("detail-open");
 setHTML("detail-heading", '<h2>选择一个步骤查看原始记录</h2>'); setHTML("detail-content", ""); setHTML("timeline", "");
 $("trace-title").textContent = "执行轨迹";
 $("event-count").textContent = "尚无记录"; $("run-id").textContent = "";
 $("status").textContent = "等待任务"; $("status").dataset.status = "";
 $("metrics").textContent = "提交任务后显示实际用量与耗时";
 $("trace-summary").textContent = "执行过程 · 尚未运行";
 if (config) { $("model-label").textContent = config.configured ? config.model : "模型未配置"; $("workspace-label").textContent = "只读工作区 · " + config.workspace; }
}
function renderTaskLists(): void {
 const heads = conversationHeads(items);
 const rootID = run ? conversationID(run) : items.find(item=>item.id===activeId)?.conversation_id || activeId;
 const date = (item: RunSummary): string => new Date(item.created_at * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
 const editing = renamingId !== null && document.activeElement instanceof HTMLInputElement && document.activeElement.id === "task-title-input";
 if (!editing) {
  setHTML("task-list", heads.map(item => {
   const id = conversationID(item), label = displayTitle(item), active = rootID === id;
   if (id === renamingId) return `<div class="task-item ${active ? "active" : ""} renaming"><input id="task-title-input" class="task-title-input" value="${esc(label)}" maxlength="40" aria-label="对话标题"><span><i class="task-dot ${esc(item.status)}"></i><time>${date(item)}</time></span></div>`;
   return `<div class="task-item ${active ? "active" : ""}"><button type="button" id="task-${esc(item.id)}" class="task-open" data-run="${esc(item.id)}"${active ? ' aria-current="true"' : ""} title="${esc(rootTask(item))}"><strong>${esc(label)}</strong><span><i class="task-dot ${esc(item.status)}"></i><time>${date(item)}</time></span></button><button type="button" class="task-rename" data-rename="${esc(id)}" title="改名">改名</button></div>`;
  }).join("") || '<p class="list-empty">尚无任务记录</p>');
 }
 setHTML("home-task-list", heads.map(item => `<button id="home-task-${esc(item.id)}" class="home-task" data-run="${esc(item.id)}"><span><strong>${esc(displayTitle(item))}</strong><small>${esc(item.model)} · ${esc(item.id.slice(0, 8))}</small></span><span class="task-state ${esc(item.status)}">${esc(statuses[item.status])}</span><time>${date(item)}</time><span aria-hidden="true">↗</span></button>`).join("") || '<div class="home-empty"><h2>从一个小任务开始</h2><p>提交一个只读任务，模型请求和工具回执会一起保存在本地。</p><button class="primary" data-new-task>创建第一个任务 →</button></div>');
 $("task-count").textContent = `${heads.length} 段对话`;
 $("home-count").textContent = `${heads.length} 段对话 · ${items.length} 轮运行`;
}
function finishRename(id: string, value: string | null): void {
 if (renamingId !== id) return;
 renamingId = null;
 const item = items.find(entry => conversationID(entry) === id);
 if (value !== null && item) saveTitle(id, value, rootTask(item));
 renderTaskLists();
 if (run && conversationID(run) === id) {
  const task = conversation[0]?.task ?? run.task;
  $("conversation-title").textContent = conversationTitle(task, loadTitles()[id] ?? "");
  $("conversation-title").title = task;
 }
}
function startRename(id: string): void {
 renamingId = id;
 renderTaskLists();
 const input = document.getElementById("task-title-input");
 if (!(input instanceof HTMLInputElement)) return;
 input.focus(); input.select();
 input.onkeydown = event => {
  if (event.key === "Enter") { event.preventDefault(); finishRename(id, input.value); }
  if (event.key === "Escape") { event.preventDefault(); finishRename(id, null); }
 };
 input.onblur = () => finishRename(id, input.value);
}
async function showHome(changeURL = true): Promise<void> {
 page = "home"; resetRunView(); showError(""); if (changeURL) updateURL(null); applyLayout(); renderTaskLists();
 await pollTaskList();
}
function showNewTask(changeURL = true): void {
 page = "new"; resetRunView(); showError(""); if (changeURL) updateURL(null, true); applyLayout(); renderTaskLists();
 $("conversation-title").textContent = "新任务";
 setHTML("conversation", `<div class="welcome"><span class="eyebrow">运行与观察</span><h3>从一个问题开始。</h3><p>输入任务，阅读回答。需要观察过程时，在右侧查看模型请求、工具与回执。</p>${config?.coding_available ? `<button type="button" data-coding ${config.coding_ready ? "" : "disabled"}>修复一个 TypeScript 程序 ↗</button><p>${config.coding_ready ? "观察一次真实的测试、改代码、再测试。" : esc(config.coding_message)}</p>` : ""}</div>`);
 setHTML("graph", '<div class="empty-graph"><p>还没有执行记录。<br>提交任务后，过程会在这里出现。</p></div>');
 if (!config?.configured) showError("请先在服务端配置模型，然后重启。");
 $("task").value = ""; $("task").focus(); render(); void pollTaskList();
}
function showSettings(changeURL = true): void {
 if (page !== "settings") settingsReturn = page;
 page = "settings"; if (changeURL) updateURL(null, false, true); applyLayout();
 $("budget").value = String(maxRequests);
}
function leaveSettings(): void {
 if (settingsReturn === "run" && activeId && run) { page = "run"; applyLayout(); render(); updateURL(activeId); }
 else if (settingsReturn === "new") { page = "new"; applyLayout(); render(); updateURL(null, true); }
 else void showHome();
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
 else if (params.get("settings") === "1") showSettings(false);
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
  // The local TypeScript API validates persisted runs and model/tool inputs at its boundaries.
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
  if (event.kind === "tool") return ({ read_file: "读取文件", list_files: "列出文件", write_file: "修改文件", run_command: "运行测试" } as Record<string, string>)[event.title] ?? event.title;
  return event.title;
}
function rowRole(event: TraceEvent): string {
 if (event.kind === "input") return "USER";
 if (event.kind === "model") return object(event.output?.message).role === "assistant" ? "ASSISTANT" : "MODEL";
 if (event.kind === "tool") return "TOOL";
 if (typeof event.input.system === "string") return "CONTEXT";
 if (typeof event.output?.tool_call_id === "string" && typeof event.output.content === "string") return "RESULT";
 if (typeof event.output?.run_status === "string") return "STOP";
 return "HARNESS";
}
function rowText(event: TraceEvent): string {
 if (event.status === "running") return event.kind === "model" ? "模型请求中，等待响应" : event.title + " · 进行中";
 if (event.kind === "input") return typeof event.input.task === "string" ? event.input.task : event.title;
 if (event.kind === "model") {
  const content = object(event.output?.message).content;
  return typeof content === "string" && content.trim() ? content : summary(event);
 }
 if (event.kind === "tool") {
  if (event.title === "run_command") return `${event.output?.command ?? "node --test average.test.ts"} → ${event.output?.timed_out ? "执行超时" : event.output?.exit_code !== null && event.output?.exit_code !== undefined ? "退出码 " + event.output.exit_code : "退出状态未确认"}`;
  if (event.title === "write_file") return `${event.output?.path ?? "average.ts"} → ${event.output?.error ?? (event.output?.changed ? "已修改 · 查看真实 diff" : "内容未变化")}`;
  const args = typeof event.input.arguments === "string" ? event.input.arguments : JSON.stringify(event.input.arguments);
  const result = event.output?.error ?? (event.output?.content ? String(event.output.content) : event.output?.files ? JSON.stringify(event.output.files) : summary(event));
  return event.title + " " + args + " → " + String(result);
 }
 if (typeof event.input.system === "string") {
  const runtime=object(event.input.runtime_context);
  if (typeof runtime.date === "string") return `本轮上下文 · ${runtime.date} · ${String(runtime.time_zone ?? "")} · ${event.input.system_refreshed ? "更新系统规则，保留历史对话" : "新对话"} · 模型请求额度 ${String(event.input.max_requests ?? "—")}`;
  return "准备上下文 · 模型请求额度 " + String(event.input.max_requests ?? "—") + " · " + event.input.system;
 }
 if (rowRole(event) === "RESULT") return "交回工具回执 · " + String(event.output?.content ?? "");
 return event.title;
}
function eventRow(current: Run, event: TraceEvent, related: Set<string>): string {
 const usage = tokenUsage(event), text = rowText(event);
 const modelTokens = event.kind === "model" ? `<small>${usage.total === undefined ? event.status === "running" ? "等待用量" : "Token 未返回" : number(usage.total) + " tokens"}</small>` : "";
 return `<button id="${nodeID(current.id,event.id)}" class="trace-row kind-${event.kind} ${event.status} ${selectedRunID === current.id && selected === event.id ? "selected" : ""} ${related.has(event.id) ? "related" : ""}" data-trace-run="${esc(current.id)}" data-event="${esc(event.id)}" aria-pressed="${selectedRunID === current.id && selected === event.id}" title="${esc(event.id + " · " + event.title + " · " + text.slice(0, 500))}"><span class="row-index">${esc(event.id.replace(/^e0*/, "") || "0")}</span><span class="role-tag role-${rowRole(event).toLowerCase()}"${rowRole(event) === "HARNESS" ? ' title="Harness 控制步骤，例如选择工具执行器。上下文准备、回执回填和停止控制也属于 Harness 的职责；此标签不是模型消息角色。"' : ""}>${rowRole(event)}</span><span class="row-content">${event.kind === "model" ? `<span class="request-mark" title="模型轮次：一次模型请求及其引发的工具处理；同批多个工具属于同一轮，不是用户对话轮次。">模型轮次 ${event.turn}</span>` : ""}${esc(text.replace(/\s+/g, " ").slice(0, 700))}</span><span class="row-metric">${event.status === "running" ? "进行中" : formatDuration(event.d)}${modelTokens}</span></button>`;
}
function callFor(id: string): { call: CallLink; model: TraceEvent } | undefined {
  for (const step of graph.steps) for (const call of step.calls) if (call.tool?.id === id || call.receipt?.id === id) return { call, model: step.model };
  return undefined;
}
function pointer(event: TraceEvent): string { return "/events/" + selectedRun()!.events.findIndex(item => item.id === event.id); }
function runStream(current: Run): string {
 const localGraph = buildTraceGraph(current);
 const related = relatedEvents(localGraph, selectedRunID===current.id ? selected : null);
 let html = localGraph.unlinkedTools.length ? `<p class="stream-note">${localGraph.unlinkedTools.length} 条工具记录的调用来源尚未核对，以下按原始顺序保留。</p>` : "";
 const sections = executionSections(current);
 for (const section of sections) {
  const step = localGraph.steps.find(item => item.model.id === section.anchor.id);
  const rest = section.kind === "request" ? section.events.slice(1) : [];
  if (section.kind !== "request") {
   html += `<section class="stream-section phase-${section.kind}" aria-label="${section.kind==="start"?"任务与上下文":"运行结束"}">${section.events.map(event=>eventRow(current,event,related)).join("")}</section>`;
   continue;
  }
  html += `<section class="stream-section phase-request" aria-label="模型轮次 ${section.anchor.turn}">${eventRow(current,section.anchor,related)}`;
  if (rest.length) {
   const open = batchStates.get(traceKey(current.id,section.anchor.id)) ?? current.events.length <= 12;
   const names = rest.filter(event=>event.kind==="tool").map(event=>event.title);
   const errors = rest.filter(event=>event.kind==="tool" && event.status==="failed").length;
   html += `<button id="batch-${current.id}-${esc(section.anchor.id)}" class="batch-summary ${errors ? "has-error" : ""}" data-batch="${esc(traceKey(current.id,section.anchor.id))}" data-trace-run="${current.id}" aria-expanded="${open}" aria-controls="batch-events-${current.id}-${esc(section.anchor.id)}"><span class="disclosure-arrow">${open?"▾":"▸"}</span><span>${names.length ? names.length + " 个工具调用 · " + [...new Set(names)].map(esc).join("、") : "Harness 处理记录"}</span><small>${rest.length} 条事件${errors ? ` · ${errors} 次错误` : ""}</small></button><div id="batch-events-${current.id}-${esc(section.anchor.id)}" class="batch-events" ${open?"":"hidden"}>${rest.map(event=>eventRow(current,event,related)).join("")}</div>`;
   const forwarded = step?.calls.filter(call=>call.nextModel) ?? [];
   if (forwarded.length) html += `<button class="stream-receipt-link" data-trace-run="${current.id}" data-event="${esc(forwarded[0].nextModel!.id)}" data-part="/input/messages">↳ ${forwarded.length} 条回执已进入请求 ${forwarded[0].nextModel!.turn} · 查看消息依据</button>`;
   else if (step?.calls.some(call=>call.receipt)) html += `<p class="stream-note">${current.status==="budget_exhausted" ? "回执已记录；本轮模型额度耗尽，没有下一次模型请求。" : "回执已记录，本轮尚未观察到携带它的后续请求。"}</p>`;
  }
  html += "</section>";
 }
 if (!current.events.length) html = `<div class="empty-graph"><p>${current.status === "running" ? "等待第一个执行事件…" : "本次没有可用的执行事件，请查看运行状态。"}</p></div>`;
 return html;
}
function renderGraph(): void {
 const overview = conversationOverview(conversation), count = Math.max(1,overview.eventCount), extent = Math.max(.001,overview.duration);
 const related = relatedEvents(graph,selected);
 const marker = (current: Run, event: TraceEvent, left: number, width: number, step = false): string => {
  const isSelected = selectedRunID===current.id && selected===event.id;
  return `<button class="timeline-bar kind-${event.kind} ${event.status} ${isSelected?"selected":""} ${selectedRunID===current.id&&related.has(event.id)?"related":""}" data-trace-run="${current.id}" data-event="${esc(event.id)}" style="left:${left*100}%;width:${width*100}%" aria-pressed="${isSelected}" aria-label="${step?"步骤":"耗时"} Turn ${current.conversation_turn??1} ${esc(event.id+" "+title(event))}" title="Turn ${current.conversation_turn??1} · ${esc(event.id+" · "+title(event)+" · "+(event.status==="running"?"进行中":formatDuration(event.d)))}">${step?esc(event.id.replace(/^e0*/,"")):""}</button>`;
 };
 const lanes: [EventKind,string][] = [["input","输入"],["model","模型"],["tool","工具"],["control","Harness"]];
 const timeBars = overview.turns.flatMap(turn => timelineLayout(turn.run,"time",turn.duration).bars.map(bar=>({run:turn.run,event:bar.event,left:(turn.start+bar.event.t)/extent,width:(bar.event.status==="running"?Math.max(0,turn.duration-bar.event.t):bar.event.d)/extent})));
 setHTML("timeline", `<div class="timeline-lane turn-lane"><span>Turn</span><div class="turn-track">${overview.turns.map(turn=>`<button data-turn-focus="${turn.run.id}" style="left:${turn.firstStep/count*100}%;width:${turn.run.events.length/count*100}%" title="定位对话第 ${turn.number} 轮">Turn ${turn.number}</button>`).join("")}</div></div><div class="timeline-lane step-lane"><span>步骤</span><div class="step-track">${overview.turns.flatMap(turn=>turn.run.events.map((event,index)=>marker(turn.run,event,(turn.firstStep+index)/count,.76/count,true))).join("")}</div></div><div class="timeline-axis" title="各轮实际执行耗时相加，不包含等待用户回复的时间"><span>执行</span><div>${[0,.5,1].map(n=>`<span>${(overview.duration*n).toFixed(2)}s</span>`).join("")}</div></div>${lanes.map(([kind,label])=>`<div class="timeline-lane"><span>${label}</span><div class="lane-track">${timeBars.filter(bar=>bar.event.kind===kind).map(bar=>marker(bar.run,bar.event,bar.left,bar.width)).join("")}</div></div>`).join("")}`);
 setHTML("graph", overview.turns.map(turn=>{
  const open = turnStates.get(turn.run.id) ?? (conversation.length<=3 || turn.run.id===conversation.at(-1)?.id);
  return `<section class="trace-turn" id="turn-${turn.run.id}"><button id="turn-heading-${turn.run.id}" class="turn-heading" data-turn="${turn.run.id}" aria-expanded="${open}" aria-controls="turn-events-${turn.run.id}"><span class="turn-number">${open?"▾":"▸"} Turn ${turn.number}</span><span class="turn-task">${esc(turn.run.task)}</span><span class="turn-status ${turn.run.status}">${statuses[turn.run.status]}</span><span class="turn-metrics">${turn.run.model_requests} 模型轮次 · ${turn.run.tool_calls} 工具 · ${totalTokens(turn.run)} · ${formatDuration(turn.duration)}${turn.run.tool_errors?` · ${turn.run.tool_errors} 次工具错误`:""}</span></button><div id="turn-events-${turn.run.id}" ${open?"":"hidden"}>${runStream(turn.run)}</div></section>`;
 }).join(""));
 $("event-count").textContent = `全对话 · ${conversation.length} Turns · ${overview.eventCount} 条事件`;
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
function eventLink(event: TraceEvent, label: string, part = ""): string { return `<button class="text-link" data-trace-run="${selectedRun()!.id}" data-event="${esc(event.id)}" data-part="${esc(part)}"${part ? ' data-detail="io"' : ""}>${esc(label)} <span aria-hidden="true">↗</span></button>`; }
function renderDetail(current: Run): void {
  const event = current.events.find(item => item.id === selected);
  if (!event) {setHTML("detail-heading","<h2>选择一个步骤查看原始记录</h2>");setHTML("detail-content","");return;}
  const tabs: [DetailTab, string][] = [["io", "原始记录"], ["code", "源码"], ["overview", "说明"]];
  document.querySelector(".trace-pane")?.classList.toggle("detail-open", detailOpen);
  setHTML("detail-heading", `<div><span class="eyebrow">Turn ${current.conversation_turn??1} · ${roles[event.kind]} · ${esc(event.id)}</span><h2>${esc(title(event))}</h2></div><div class="detail-tabs" role="tablist" aria-label="步骤详情">${tabs.map(([id, label]) => `<button id="detail-tab-${id}" role="tab" aria-controls="detail-content" aria-selected="${detailTab === id}" data-tab="${id}" class="${detailTab === id ? "active" : ""}">${label}</button>`).join("")}</div><button id="detail-toggle" class="detail-toggle" data-toggle-detail aria-expanded="${detailOpen}" aria-controls="detail-content">${detailOpen ? "收起 ↓" : "展开记录 ↑"}</button>`);
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
    if (event.title === "write_file" && typeof event.output?.diff === "string") content += `<section><h3>实际文件变更</h3><pre>${esc(event.output.diff)}</pre></section>`;
    if (event.title === "run_command" && event.output) content += `<section><h3>测试回执 · ${event.output.timed_out ? "超时" : "退出码 " + esc(event.output.exit_code ?? "未确认")}</h3><pre>${esc(event.output.stdout || "（stdout 为空）")}</pre>${event.output.stderr ? `<pre>${esc(event.output.stderr)}</pre>` : ""}${event.output.output_truncated ? "<p>输出超过上限，已截断。</p>" : ""}</section>`;
    content += `<div class="json-pair"><section><h3>实际输入 <code>${esc(pointer(event))}/input</code></h3><pre>${pretty(event.input)}</pre></section><section><h3>实际输出 <code>${esc(pointer(event))}/output</code></h3><pre>${event.status === "running" ? "尚未返回" : pretty(event.output)}</pre></section></div><p class="detail-note">${current.status === "running" ? "运行中打开 trace.jsonl 的对应事件行；结束后打开 run.json。" : "打开后定位到所选事件或字段的实际行。"}查看记录不会重新运行任务。</p>`;
  } else content = source ? `<div class="source-heading"><code>${esc(source.path)}:${source.line}</code><span>本次运行保存的函数源码</span></div><pre class="source-code">${esc(source.code)}</pre><p class="detail-note">关联到函数整体，未声称精确到执行语句。历史源码不会被当前文件覆盖。</p>` : '<p class="detail-note">这条历史记录没有对应的源码快照。</p>';
  setHTML("detail-content", stats + content);
  updateDetailHeight();
}
async function loadConversation(current: Run): Promise<Run[]> {
 const rootID = conversationID(current);
 const head = conversationHeads(items).find(item=>conversationID(item)===rootID) ?? current;
 const chain: Run[] = [], seen = new Set<string>();
 let id: string | undefined = head.id;
 runCache.set(current.id, current);
 while (id) {
  if (seen.has(id)) throw new Error("对话记录存在循环引用，无法载入");
  seen.add(id);
  let item = runCache.get(id);
  if (!item || (item.status === "running" && item.id !== current.id)) item = await api<Run>("/api/runs/"+encodeURIComponent(id));
  if (conversationID(item) !== rootID) throw new Error("对话记录的关联不一致");
  runCache.set(id,item); chain.unshift(item); id = item.parent_run_id;
 }
 return chain;
}
function renderConversation(): void {
 setHTML("conversation", conversation.map(turn => {
  const error = turn.events.find(event=>event.kind==="tool" && event.status==="failed");
  return `<section class="conversation-turn" aria-label="对话第 ${turn.conversation_turn ?? 1} 轮"><article class="message user-message"><div class="speaker"><span class="avatar">你</span><span>第 ${turn.conversation_turn ?? 1} 轮</span></div><p>${esc(turn.task)}</p></article><article class="message assistant-message"><div class="speaker"><span class="avatar agent-avatar"><img src="/icon.png" alt=""></span><span>Loop</span><button class="turn-trace ${turn.id===selectedRunID?"active":""}" data-run="${esc(turn.id)}" aria-pressed="${turn.id===selectedRunID}">${turn.id===selectedRunID?"正在查看此轮轨迹":"查看此轮轨迹 ↗"}</button></div>${turn.answer ? `<p>${esc(turn.answer)}</p>` : `<div class="answer-placeholder">${turn.status==="running"?'<span class="waiting-dot"></span> 正在处理…':"本轮未产生最终回答 · "+esc(statuses[turn.status])}</div>`}${error ? `<button class="error-link" data-run="${esc(turn.id)}" data-run-event="${esc(error.id)}">${turn.tool_errors} 次工具错误 · 查看本轮轨迹 ↗</button>` : ""}${turn.status==="completed"?'<p class="acceptance-note">循环已结束 · 请对照工具结果核对回答</p>':""}</article></section>`;
 }).join(""));
}
function render(): void {
  if (!config) return;
  $("submit").disabled = busy || !config.configured || (page === "run" && !conversationReady);
  $("submit").textContent = busy ? "正在运行…" : page === "run" ? "发送追问 →" : newExercise ? "授权并运行练习 →" : "开始任务 →";
  const coding = page === "run" ? !!run?.exercise : newExercise;
  $("coding-consent").hidden = !(page === "new" && newExercise);
  $("coding-consent").textContent = `本轮最多 ${maxRequests} 次模型请求，练习建议 6 次。点击“授权并运行练习”，允许 Loop 只修改本次独立项目的 average.ts，并在断网容器内运行测试。测试文件受保护。`;
  $("mode-label").textContent = coding ? "TypeScript 修复练习" : "对话与只读工具";
  $("access").textContent = coding ? (run ? "独立练习：" + run.workspace : "将创建独立副本 · 不修改现有项目") : "只读目录：" + config.workspace;
  if (!run) {
   $("follow-latest").hidden = true;
   $("workspace-label").textContent = newExercise ? "运行时将创建独立练习目录" : "只读工作区 · " + config.workspace;
   return;
  }
  const current = run;
  const task = conversation[0]?.task ?? current.task;
  const heading = conversationTitle(task, loadTitles()[conversationID(current)] ?? "");
  $("conversation-title").textContent = heading;
  $("conversation-title").title = task;
  $("trace-title").textContent = "执行轨迹 · 整段对话";
  const head = conversation.at(-1) ?? current;
  const previous = selectedRunID+":"+selected;
  if (followLatest && head.status === "running") { selectedRunID=head.id; selected=head.events.at(-1)?.id ?? null; }
  const detail = selectedRun() ?? current; selectedRunID=detail.id;
  graph = buildTraceGraph(detail);
  if (!detail.events.some(event=>event.id===selected)) selected = graph.steps[0]?.model.id ?? detail.events[0]?.id ?? null;
  if (selectedRunID+":"+selected !== previous) {
   pointerPart=""; recordFeedback="";
   if (followLatest && selected) {
    turnStates.set(detail.id,true);
    const section=executionSections(detail).find(section=>section.events.some(event=>event.id===selected));
    if (section?.kind==="request") batchStates.set(traceKey(detail.id,section.anchor.id),true);
   }
  }
  $("model-label").textContent = current.model;
  $("workspace-label").textContent = (current.exercise ? "独立练习 · " : current.workspace === config.workspace ? "只读工作区 · " : "历史工作区 · ") + current.workspace;
  $("workspace-label").title = current.workspace;
  $("run-id").textContent = "RUN " + current.id.slice(0, 8);
  $("status").textContent = statuses[head.status];
  $("status").dataset.status = head.status;
  const overview = conversationOverview(conversation);
  $("metrics").textContent = `${conversation.length} Turns（对话轮次） · ${overview.modelRequests} 次模型请求 · ${overview.toolCalls} 次工具 · ${totalTokens(overview)} · 执行 ${formatDuration(overview.duration)}`;
  $("trace-summary").textContent = `执行过程 · ${conversation.length} Turns · ${totalTokens(overview)} ${traceCollapsed?"‹":"›"}`;
  const usage = runUsage(overview);
  $("metrics").title = `累计执行耗时，不含轮间等待。输入 ${number(usage.input.total)} · 输出 ${number(usage.output.total)} · 缓存输入 ${number(usage.cached.total)}（输入子项，不重复计入）`;
  $("download").disabled = false;
  $("download").textContent = conversation.length>1 ? "导出对话 ↓" : "导出 ↓";
  $("follow-latest").hidden = head.status !== "running" || followLatest;
  renderConversation();
  renderGraph();
  renderDetail(detail);
  if (followLatest && head.status === "running" && previous !== selectedRunID+":"+selected && selected) {
   followScrollLock += 1;
   document.getElementById(nodeID(detail.id,selected))?.scrollIntoView({ block: "nearest", inline: "nearest" });
   window.setTimeout(() => { followScrollLock = Math.max(0, followScrollLock - 1); }, 150);
  }
}
async function refreshHistory(): Promise<RunSummary[]> {
 items = await api<RunSummary[]>("/api/runs");
 busy = items.some(item => item.status === "running");
 renderTaskLists();
 $("submit").disabled = busy || !config?.configured || (page === "run" && !conversationReady);
 return items;
}
async function poll(): Promise<void> {
  if (!activeId) return;
  const id = activeId;
  try {
    const snapshot = await api<Run>("/api/runs/" + encodeURIComponent(id));
    if (activeId !== id) return;
    if (!run) followLatest = snapshot.status === "running";
    run = snapshot;
    await refreshHistory();
    const chain = await loadConversation(snapshot);
    if (activeId !== id) return;
    conversation = chain; conversationReady = true;
    if (activeId !== id) return;
    render();
    window.clearTimeout(pollTimer);
    if (run.status === "running" || busy) pollTimer = window.setTimeout(() => { void poll(); }, 650);
  } catch (error) {
    if (activeId !== id) return;
    conversationReady = false; showError(message(error)); $("submit").disabled = busy || !config?.configured || (page === "run" && !conversationReady);
    if (!run) {
     $("conversation-title").textContent = "记录未加载";
     setHTML("conversation", `<div class="welcome"><h3>无法读取这条任务</h3><p>${esc(message(error))}</p><button data-home>返回所有任务</button></div>`);
     setHTML("graph", '<div class="empty-graph"><p>没有可展示的记录。</p></div>');
    }
  }
}
async function chooseRun(id: string, changeURL = true): Promise<void> {
  page = "run"; conversationReady = false; selectedRunID=id; turnStates.set(id,true); followLatest = true;
  const target = items.find(item=>item.id===id);
  if (!run || !target || conversationID(run)!==conversationID(target)) { conversation=[]; runCache.clear(); batchStates.clear(); turnStates.clear(); turnStates.set(id,true); $("task").value=""; }
  activeId = id; run = null; selected = null; pointerPart = ""; recordFeedback = ""; detailOpen = false;
  window.clearTimeout(pollTimer); showError(""); applyLayout(); renderTaskLists();
  $("conversation-title").textContent = "正在读取任务…";
  setHTML("graph", '<div class="empty-graph"><p>正在读取这次运行…</p></div>');
  setHTML("conversation", '<p class="muted loading-note">正在载入任务和回答…</p>');
  setHTML("detail-heading", ""); setHTML("detail-content", ""); setHTML("timeline", "");
  if (changeURL) updateURL(id);
  await poll();
}
function selectEvent(id: string, part = "", detail?: string, runID = selectedRunID ?? run?.id): void {
  const current = conversation.find(item=>item.id===runID);
  if (!current?.events.some(event=>event.id===id)) return;
  selectedRunID=current.id; selected=id; pointerPart=part; recordFeedback=""; detailOpen=true;
  turnStates.set(current.id,true);
  const section=executionSections(current).find(section=>section.events.some(event=>event.id===id));
  if (section?.kind==="request") batchStates.set(traceKey(current.id,section.anchor.id),true);
  followLatest=false;
  detailTab=detail==="overview"||detail==="code"?detail:"io";
  if (traceCollapsed) {traceCollapsed=false;savePreference("loop.traceCollapsed",false);applyLayout();}
  render();
  const target=document.getElementById(nodeID(current.id,id));
  target?.scrollIntoView({block:"nearest",inline:"nearest"}); target?.focus({preventScroll:true});
}
function focusTurn(id: string): void {
 const current=conversation.find(item=>item.id===id); if (!current) return;
 turnStates.set(id,true); selectedRunID=id; selected=current.events.find(event=>event.kind==="model")?.id ?? current.events[0]?.id ?? null;
 pointerPart="";recordFeedback="";followLatest=false;
 if (traceCollapsed) {traceCollapsed=false;savePreference("loop.traceCollapsed",false);applyLayout();}
 render();document.getElementById("turn-"+id)?.scrollIntoView({block:"nearest",inline:"nearest"});
}
async function openRecord(): Promise<void> {
 const current=selectedRun();
 if (!current || !selected || !config || openingRecord) return;
 const runID = current.id, eventID = selected, field = pointerPart;
 openingRecord = true; recordFeedback = ""; renderDetail(selectedRun()!);
 try {
  const result = await api<{ path: string; line: number; editor: string }>(`/api/runs/${encodeURIComponent(runID)}/open-record`, {
   method: "POST", headers: { "Content-Type": "application/json", "X-Lab-Token": config.token }, body: JSON.stringify({ event_id: eventID, field })
  });
  if (selectedRunID === runID && selected === eventID && pointerPart === field) recordFeedback = `${result.editor} · ${result.path.split(/[\\/]/).at(-1)}:${result.line}`;
 } catch (error) {
  if (selectedRunID === runID && selected === eventID && pointerPart === field) recordFeedback = message(error);
 } finally { openingRecord = false; if (run) renderDetail(selectedRun()!); }
}
document.addEventListener("click", event => {
  if (!(event.target instanceof Element)) return;
  const rename = event.target.closest<HTMLElement>("[data-rename]")?.dataset.rename;
  if (rename) { startRename(rename); return; }
  if (event.target.closest("#follow-latest")) {
   followLatest = true;
   const head = conversation.at(-1);
   if (head) { selectedRunID = head.id; selected = head.events.at(-1)?.id ?? null; }
   render();
   return;
  }
  const batch = event.target.closest<HTMLElement>("[data-batch]")?.dataset.batch;
  if (batch) {
   const ownerID=event.target.closest<HTMLElement>("[data-batch]")?.dataset.traceRun;
   const owner=conversation.find(item=>item.id===ownerID);
   if (owner) {batchStates.set(batch,!(batchStates.get(batch) ?? owner.events.length<=12));render();} return;
  }
  const turn=event.target.closest<HTMLElement>("[data-turn]")?.dataset.turn;
  if (turn) {turnStates.set(turn,!(turnStates.get(turn) ?? (conversation.length<=3 || turn===conversation.at(-1)?.id)));render();return;}
  const focus=event.target.closest<HTMLElement>("[data-turn-focus]")?.dataset.turnFocus;
  if (focus) {focusTurn(focus);return;}
  const taskLink = event.target.closest<HTMLElement>("[data-run]");
  if (taskLink?.dataset.run && event.target.closest(".conversation-turn")) {
   focusTurn(taskLink.dataset.run);
   if (taskLink.dataset.runEvent) selectEvent(taskLink.dataset.runEvent,"",undefined,taskLink.dataset.run);
   return;
  }
  if (taskLink?.dataset.run) {
   const id = taskLink.dataset.run, eventID = taskLink.dataset.runEvent;
   const scroll = $("conversation").scrollTop;
   const sameConversation = items.find(item=>item.id===id)?.conversation_id === run?.conversation_id && conversation.some(turn=>turn.id===id);
   void chooseRun(id).then(() => {
    if (activeId !== id) return;
    if (sameConversation) $("conversation").scrollTop = scroll;
    if (eventID) selectEvent(eventID);
   }); return;
  }
  if (event.target.closest("[data-home]")) { void showHome(); return; }
  if (event.target.closest("[data-coding]") && config?.coding_ready) {
   newExercise = true; $("task").value = config.coding_task;
   $("conversation-title").textContent = "修复一个 TypeScript 程序";
   setHTML("conversation", '<div class="welcome"><span class="eyebrow">第一次 Coding 练习</span><h3>让失败的测试变绿。</h3><p>一个平均值函数遇到空输入就出错。Loop 会在独立副本里读取代码、修复它，并用原有测试验证。每次修改和测试输出都能在右侧查看。</p><p>授权范围：仅修改 average.ts；测试和 package.json 受保护；仅在断网容器内运行 node --test average.test.ts。</p><button type="button" data-settings>调整请求上限</button> <button type="button" data-new-task>返回普通对话</button></div>');
   render(); $("task").focus(); return;
  }
  if (event.target.closest("[data-new-task]")) { showNewTask(); return; }
  if (event.target.closest("[data-settings]")) { showSettings(); return; }
  if (event.target.closest("[data-leave-settings]")) { leaveSettings(); return; }
  if (event.target.closest("[data-toggle-trace]")) { traceCollapsed = !traceCollapsed; savePreference("loop.traceCollapsed", traceCollapsed); applyLayout(); render(); }
  if (event.target.closest("[data-toggle-detail]")) { detailOpen = !detailOpen; render(); }
  const node = event.target.closest<HTMLElement>("[data-event]");
  if (node?.dataset.event) selectEvent(node.dataset.event, node.dataset.part ?? "", node.dataset.detail, node.dataset.traceRun);
  const tab = event.target.closest<HTMLElement>("[data-tab]")?.dataset.tab;
  if (tab === "overview" || tab === "io" || tab === "code") { detailTab = tab; render(); }
  if (event.target.closest("[data-open-record]")) void openRecord();
});
$("detail-heading").addEventListener("keydown", event => {
  if (!(event.target instanceof HTMLElement) || !event.target.dataset.tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const tabs: DetailTab[] = ["io", "code", "overview"];
  const index = tabs.indexOf(detailTab);
  detailTab = event.key === "Home" ? "io" : event.key === "End" ? "overview" : tabs[(index + (event.key === "ArrowRight" ? 1 : 2)) % 3];
  render(); document.getElementById("detail-tab-" + detailTab)?.focus();
});
$("sidebar-toggle").onclick = () => { sidebarCollapsed = !sidebarCollapsed; savePreference("loop.sidebarCollapsed", sidebarCollapsed); applyLayout(); };
$("graph-scroll").addEventListener("scroll", () => {
 if (!followLatest || followScrollLock || page !== "run") return;
 const head = conversation.at(-1);
 if (head?.status !== "running") return;
 const last = head.events.at(-1);
 const row = last ? document.getElementById(nodeID(head.id, last.id)) : null;
 if (!row) return;
 const root = $("graph-scroll").getBoundingClientRect(), box = row.getBoundingClientRect();
 if (box.bottom > root.bottom + 40 || box.top < root.top - 8) {
  followLatest = false;
  $("follow-latest").hidden = false;
 }
}, { passive: true });
$("refresh-tasks").onclick = () => { void refreshHistory().catch(error => { $("home-note").textContent = message(error); }); };
$("budget").onchange = () => {
 const n = Number($("budget").value);
 if (n >= 1 && n <= 8) { maxRequests = n; savePreference("loop.maxRequests", n); }
};
window.addEventListener("popstate", () => { void routeFromLocation(); });
$("task-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!config || busy || (page === "run" && !conversationReady)) return;
  showError(""); busy = true; $("submit").disabled = true; $("submit").textContent = "正在提交…";
  try {
    const result = await api<{ id: string }>("/api/runs", { method: "POST", headers: { "Content-Type": "application/json", "X-Lab-Token": config.token }, body: JSON.stringify({ task: $("task").value, max_requests: maxRequests, ...(page === "new" && newExercise ? { exercise: "ts-average", approve_exercise: true } : {}), ...(page === "run" && conversation.length ? { parent_run_id: conversation.at(-1)!.id } : {}) }) });
    $("task").value = "";
    activeId = result.id; await refreshHistory(); await chooseRun(result.id);
    $("conversation").scrollTop = $("conversation").scrollHeight;
  } catch (error) {
    showError(message(error));
    try { await refreshHistory(); } catch { busy = true; }
    $("submit").disabled = busy || !config.configured || (page === "run" && !conversationReady); render();
  }
});
$("download").onclick = () => {
  if (!run) return;
  const output = conversation.length>1 ? {conversation_id:conversationID(run),runs:conversation} : run;
  const url = URL.createObjectURL(new Blob([JSON.stringify(output, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = conversation.length>1 ? "loop-conversation-"+conversationID(run)+".json" : "loop-run-"+run.id+".json";
  anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};
async function initialize(): Promise<void> {
  try {
    config = await api<Config>("/api/config");
    if (config.public_mode) {
      $("home-eyebrow").textContent = "LOOP / 公开体验";
      $("home-note").textContent = "匿名体验：任务和轨迹仅当前浏览器可见，保留 7 天。内容会发送给页面所示模型服务；请勿输入隐私或机密信息。免费额度用完后暂停使用。";
      $("public-composer-note").hidden = false;
    }
    $("workspace-label").textContent = "只读工作区 · " + config.workspace;
    $("workspace-label").title = config.workspace;
    $("model-label").textContent = config.configured ? config.model : "模型未配置";
    $("task").value = "";
    $("history-note").textContent = config.history.skipped ? `跳过 ${config.history.skipped} 条无效或未结束记录，原文件保留。` : "历史详情按需读取，不会重跑任务。";
    $("access").textContent = "只读目录：" + config.workspace;
    $("budget").value = String(maxRequests);
    $("submit").disabled = !config.configured;
    if (!config.configured) showError("在启动服务的终端配置 OPENAI_API_KEY 和 OPENAI_MODEL，然后重启服务。");
    await refreshHistory();
    await routeFromLocation();
  } catch (error) { showError("无法连接本机服务：" + message(error)); $("home-note").textContent = "无法连接本机服务：" + message(error); }
}
void initialize();
