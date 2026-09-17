import type { Config, EventKind, JSONObject, Run, RunStatus, RunSummary, TraceEvent } from "./types.js";

interface FormElements {
  task: HTMLTextAreaElement;
  budget: HTMLSelectElement;
  history: HTMLSelectElement;
  follow: HTMLInputElement;
  search: HTMLInputElement;
  submit: HTMLButtonElement;
  download: HTMLButtonElement;
  "task-form": HTMLFormElement;
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
const roles: Record<EventKind, string> = { input: "INPUT", model: "MODEL", tool: "TOOL", control: "HARNESS" };
const lanes: Record<EventKind, string> = { input: "Input", model: "Model", tool: "Tools", control: "Harness" };
const statuses: Record<RunStatus, string> = { running: "运行中", completed: "运行已结束", budget_exhausted: "模型请求额度耗尽", failed: "运行失败" };
type DetailTab = "overview" | "io" | "code";
let config: Config | null = null;
let run: Run | null = null;
let activeId: string | null = null;
let selected: string | null = null;
let detailTab: DetailTab = "overview";
let busy = false;
let query = "";
let pollTimer: number | undefined;

function message(error: unknown): string { return error instanceof Error ? error.message : "请求失败"; }
function showError(text: string): void {
  $("error").textContent = text;
  $("error").style.display = text ? "block" : "none";
}
function object(value: unknown): JSONObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JSONObject : {};
}
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...options });
  const result: unknown = await response.json();
  if (!response.ok) {
    const detail = object(result).error;
    throw new Error(typeof detail === "string" ? detail : "请求失败");
  }
  // This is the same-origin Go API contract, not runtime validation of arbitrary imported JSON.
  // Model arguments, requests and persisted records are validated at their Go trust boundaries.
  return result as T;
}
function summary(event: TraceEvent): string {
  if (event.status === "running") return "正在执行，等待真实返回结果";
  const output = event.output ?? {};
  if (event.kind === "model") {
    const reason = typeof output.finish_reason === "string" ? output.finish_reason : "未取得响应";
    const calls = object(output.message).tool_calls;
    return "finish_reason = " + reason + (Array.isArray(calls) ? " · " + calls.length + " 个工具请求" : "");
  }
  if (event.kind === "tool") {
    if (typeof output.error === "string") return "工具返回错误：" + output.error;
    return typeof event.input.arguments === "string" ? event.input.arguments : JSON.stringify(event.input.arguments);
  }
  if (typeof output.run_status === "string" && output.run_status in statuses) {
    return statuses[output.run_status as RunStatus] + " · 任务结果尚未验收";
  }
  return event.explanation;
}
function duration(event: TraceEvent, current: Run): number {
  return event.status === "running" ? Math.max(0, Date.now() / 1000 - current.created_at - event.t) : event.d;
}
function render(): void {
  const current = run;
  if (!current || !config) return;
  $("title").textContent = current.task;
  $("title").title = current.task;
  $("workspace-label").textContent = (current.workspace === config.workspace ? "只读工作区：" : "历史工作区（当时路径）：") + current.workspace;
  $("model-label").textContent = "真实模型 · " + current.model;
  $("download").disabled = false;
  const events = current.events;
  if ($("follow").checked && events.length) selected = events[events.length - 1].id;
  if (!events.some(event => event.id === selected)) selected = events[0]?.id ?? null;
  const seconds = current.status === "running" ? Math.max(0, Date.now() / 1000 - current.created_at) : (current.duration ?? 0);
  const end = Math.max(1, seconds, ...events.map(event => event.t + duration(event, current)));
  const scale = Math.max(1, Math.ceil(end * 1.08));
  $("ticks").innerHTML = [0, 1, 2, 3, 4].map(n => "<span>" + (scale * n / 4).toFixed(1) + "s</span>").join("");
  $("lanes").innerHTML = (Object.keys(lanes) as EventKind[]).map(kind =>
    '<div class="lane kind-' + kind + '"><span class="lane-name">' + lanes[kind] + '</span><div class="track">' +
    events.filter(event => event.kind === kind).map(event =>
      '<button class="bar ' + event.status + (event.id === selected ? " selected" : "") +
      '" data-event="' + esc(event.id) + '" title="' + esc(event.title) + '" aria-label="' + esc(event.title) +
      '" style="left:' + event.t / scale * 100 + "%;width:" + Math.max(.35, duration(event, current) / scale * 100) + '%"></button>'
    ).join("") + "</div></div>"
  ).join("");
  const filtered = events.filter(event => (event.title + " " + summary(event) + " " + roles[event.kind]).toLowerCase().includes(query));
  $("events").innerHTML = filtered.length ? filtered.map(event =>
    '<button class="event kind-' + event.kind + " " + event.status + (event.id === selected ? " selected" : "") +
    '" data-event="' + esc(event.id) + '" aria-pressed="' + (event.id === selected) +
    '"><span class="index">' + esc(event.id.slice(1)) + '</span><span class="role">' + roles[event.kind] +
    '</span><span class="event-main"><span class="event-title">' + esc(event.title) +
    '</span><span class="event-summary">' + esc(summary(event)) + '</span></span><span class="duration">' +
    (event.status === "running" ? "进行中" : event.d.toFixed(2) + "s") + "</span></button>"
  ).join("") : '<div class="empty">没有匹配的事件。</div>';
  $("event-count").textContent = filtered.length + " / " + events.length + " 个事件";
  $("metrics").textContent = current.model_requests + " 次模型请求 · " + current.tool_calls + " 次工具调用 · " + seconds.toFixed(1) + "s";
  $("status").textContent = statuses[current.status] +
    (current.status === "running" ? " · 当前请求超时设置为 60 秒" : current.status === "completed" ? " · 任务结果待你核对" : " · 任务未完成") +
    (current.tool_errors ? " · " + current.tool_errors + " 次工具错误" : "");
  $("run-id").textContent = current.id.slice(0, 10);
  renderDetail(events.find(event => event.id === selected), current);
  $("chat-content").className = "";
  $("chat-content").innerHTML = '<div class="message user"><small>用户任务</small>' + esc(current.task) +
    '</div><div class="message"><small>模型回答</small>' +
    esc(current.answer || (current.status === "running" ? "任务正在运行，尚无最终回答。" : "本次没有产生最终回答。请到轨迹中查看停止原因。")) + "</div>";
  $("submit").disabled = busy || !config.configured;
  $("submit").textContent = busy ? "正在运行…" : "运行任务 →";
}
function renderDetail(event: TraceEvent | undefined, current: Run): void {
  if (!event) {
    $("detail-head").textContent = "";
    $("detail-content").textContent = "等待第一个运行事件。";
    return;
  }
  const source = current.source[event.code];
  const turnLabel = event.turn ? "第 " + event.turn + " 次模型请求" : "模型请求前";
  const tabs: [DetailTab, string][] = [["overview", "这步发生了什么"], ["io", "输入 / 输出"], ["code", "核心代码"]];
  $("detail-head").innerHTML = '<div class="detail-meta kind-' + event.kind + '"><span class="role">' + roles[event.kind] +
    '</span><span class="node-id">' + esc(event.id) + " · " + turnLabel + "</span></div><h2>" + esc(event.title) +
    '</h2><div class="detail-sub">' + esc(summary(event)) + '</div><div class="detail-tabs">' +
    tabs.map(([id, label]) => '<button data-tab="' + id + '" class="' + (detailTab === id ? "active" : "") + '">' + label + "</button>").join("") + "</div>";
  if (!source) { $("detail-content").textContent = "该历史事件没有源码快照。"; return; }
  let content = "";
  if (detailTab === "overview") {
    content = "<p>" + esc(event.explanation) + '</p><dl class="facts"><dt>实际状态</dt><dd>' +
      ({ running: "执行中", succeeded: "已返回", failed: "失败或被拒绝" }[event.status]) +
      "</dd><dt>开始位置</dt><dd>" + event.t.toFixed(3) + "s</dd><dt>关联实现</dt><dd>" +
      esc(source.path) + ":" + source.line + '</dd></dl><div class="label">实际返回</div><pre class="json">' +
      (event.status === "running" ? "等待返回…" : pretty(event.output)) + "</pre>";
  }
  if (detailTab === "io") {
    content = '<div class="label">实际输入</div><pre class="json">' + pretty(event.input) +
      '</pre><div class="label">实际输出</div><pre class="json">' +
      (event.status === "running" ? "等待返回…" : pretty(event.output)) +
      '</pre><p class="note">这些字段来自本次执行记录；模型请求中的消息和工具定义没有用示例替换。</p>';
  }
  if (detailTab === "code") {
    content = '<div class="label">' + esc(source.path) + " · 第 " + source.line +
      ' 行起</div><pre class="code">' + esc(source.code) + '</pre><div class="explain"><p>' +
      esc(event.explanation) + '</p></div><p class="note">这是该次运行的源码快照。先预测改动一条规则会怎样，再提交一次新实验核对。</p>';
  }
  $("detail-content").innerHTML = content;
}
async function refreshHistory(): Promise<RunSummary[]> {
  const items = await api<RunSummary[]>("/api/runs");
  busy = items.some(item => item.status === "running");
  $("history").innerHTML = items.length ? items.map(item =>
    '<option value="' + esc(item.id) + '">' + esc(statuses[item.status] + " · " + item.task.slice(0, 24)) + "</option>"
  ).join("") : '<option value="">尚无运行记录</option>';
  if (activeId && items.some(item => item.id === activeId)) $("history").value = activeId;
  return items;
}
async function poll(): Promise<void> {
  if (!activeId) return;
  const id = activeId;
  try {
    const snapshot = await api<Run>("/api/runs/" + id);
    if (activeId !== id) return;
    run = snapshot;
    if (run.status !== "running") await refreshHistory();
    render();
    window.clearTimeout(pollTimer);
    if (run.status === "running" || busy) pollTimer = window.setTimeout(() => { void poll(); }, 650);
  } catch (error) {
    showError(message(error)); busy = false; $("submit").disabled = !config?.configured;
  }
}
async function chooseRun(id: string): Promise<void> {
  activeId = id; selected = null; window.clearTimeout(pollTimer); showError("");
  const url = new URL(location.href); url.searchParams.set("run", id);
  window.history.replaceState(null, "", url);
  await poll();
}
function showView(view: "trace" | "chat"): void {
  $("trace").style.display = view === "trace" ? "block" : "none";
  $("chat").style.display = view === "chat" ? "block" : "none";
  $("trace-tab").classList.toggle("active", view === "trace");
  $("chat-tab").classList.toggle("active", view === "chat");
}
document.addEventListener("click", event => {
  if (!(event.target instanceof Element)) return;
  const node = event.target.closest<HTMLElement>("[data-event]");
  if (node?.dataset.event) {
    selected = node.dataset.event; $("follow").checked = false; render();
    document.querySelector(".event.selected")?.scrollIntoView({ block: "nearest" });
  }
  const tab = event.target.closest<HTMLElement>("[data-tab]")?.dataset.tab;
  if (tab === "overview" || tab === "io" || tab === "code") { detailTab = tab; render(); }
});
$("search").addEventListener("input", () => { query = $("search").value.trim().toLowerCase(); render(); });
$("follow").onchange = () => render();
$("history").onchange = () => { void chooseRun($("history").value); };
$("trace-tab").onclick = () => showView("trace");
$("chat-tab").onclick = () => showView("chat");
$("task-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!config) return;
  showError(""); busy = true; $("submit").disabled = true; $("submit").textContent = "提交中…";
  try {
    const result = await api<{ id: string }>("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Lab-Token": config.token },
      body: JSON.stringify({ task: $("task").value, max_requests: Number($("budget").value) })
    });
    $("follow").checked = true; showView("trace"); await refreshHistory(); await chooseRun(result.id);
  } catch (error) {
    showError(message(error)); busy = false; $("submit").disabled = !config.configured; $("submit").textContent = "运行任务 →";
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
    $("workspace-label").textContent = "只读工作区：" + config.workspace;
    $("model-label").textContent = config.configured ? "真实模型 · " + config.model : "模型配置未就绪";
    $("task").value = config.default_task;
    $("history-note").textContent = "启动时载入 " + config.history.loaded + " 条历史记录；回看不会调用模型或工具。" +
      (config.history.skipped ? " " + config.history.skipped + " 条记录无效或未结束，已跳过并保留原文件。" : "");
    $("access").textContent = "新任务工作区：" + config.workspace;
    $("access").title = "只读 Markdown；选择历史记录不会改变新任务的工作区。";
    $("submit").disabled = !config.configured;
    if (!config.configured) showError("请设置服务端的 OPENAI_API_KEY、OPENAI_MODEL，以及可选 OPENAI_BASE_URL。");
    const items = await refreshHistory();
    const requested = new URL(location.href).searchParams.get("run");
    const id = items.find(item => item.id === requested)?.id ?? items[0]?.id;
    if (id) await chooseRun(id);
  } catch (error) { showError("无法连接本机服务：" + message(error)); }
}
void initialize();
