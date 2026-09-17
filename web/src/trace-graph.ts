import type { JSONObject, Run, TraceEvent } from "./types.js";

export const object = (value: unknown): JSONObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JSONObject : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

// Compare recorded JSON values without relying on object-key order.
export function sameJSON(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((v, i) => sameJSON(v, right[i]));
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const a = object(left), b = object(right), keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameJSON(a[key], b[key]));
}
export function parseJSON(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}
export interface CallLink {
  id: string;
  name: string;
  arguments: unknown;
  callIndex: number;
  tool?: TraceEvent;
  receipt?: TraceEvent;
  nextModel?: TraceEvent;
  messageIndex?: number;
}
export interface ModelStep {
  model: TraceEvent;
  calls: CallLink[];
}
export interface TraceGraph {
  steps: ModelStep[];
  unlinkedTools: TraceEvent[];
}

export function buildTraceGraph(run: Run): TraceGraph {
  const models = run.events.map((event, index) => ({ event, index })).filter(item => item.event.kind === "model");
  const linked = new Set<string>();
  const steps = models.map(({ event: model, index }, position): ModelStep => {
    const next = models[position + 1];
    const batch = run.events.slice(index + 1, next?.index ?? run.events.length);
    const proposed = array(object(model.output?.message).tool_calls);
    const messages = array(next?.event.input.messages).map(object);
    let assistantIndex = -1;
    messages.forEach((message, i) => { if (message.role === "assistant") assistantIndex = i; });
    // Scope IDs to the originating model batch. IDs can recur in later responses.
    const echoedBatch = assistantIndex >= 0 && sameJSON(messages[assistantIndex].tool_calls, proposed);
    // ponytail: per-call scans suit short teaching traces; index each batch by ID if large batches become common.
    const calls = proposed.map((raw, callIndex): CallLink => {
      const call = object(raw), fn = object(call.function);
      const link: CallLink = { id: typeof call.id === "string" ? call.id : "", name: typeof fn.name === "string" ? fn.name : "未知工具", arguments: fn.arguments, callIndex };
      if (!link.id || proposed.filter(value => object(value).id === link.id).length !== 1) return link;
      const matches = batch.filter(event => event.kind === "tool" && event.input.tool_call_id === link.id && event.title === link.name && sameJSON(parseJSON(event.input.arguments), parseJSON(link.arguments)) && parseJSON(link.arguments) !== undefined);
      if (matches.length !== 1) return link;
      link.tool = matches[0];
      linked.add(link.tool.id);
      if (link.tool.output === null || link.tool.status === "running") return link;
      const receipts = batch.filter(event => event.kind === "control" && event.output?.tool_call_id === link.id && typeof event.output.content === "string" && sameJSON(parseJSON(event.output.content), link.tool?.output));
      if (receipts.length !== 1) return link;
      link.receipt = receipts[0];
      if (!next || !echoedBatch) return link;
      const forwarded = messages.map((message, messageIndex) => ({ message, messageIndex })).filter(({ message, messageIndex }) => messageIndex > assistantIndex && message.role === "tool" && message.tool_call_id === link.id && sameJSON(parseJSON(message.content), link.tool?.output));
      if (forwarded.length === 1) {
        link.nextModel = next.event;
        link.messageIndex = forwarded[0].messageIndex;
      }
      return link;
    });
    return { model, calls };
  });
  return { steps, unlinkedTools: run.events.filter(event => event.kind === "tool" && !linked.has(event.id)) };
}

export function relatedEvents(graph: TraceGraph, selected: string | null): Set<string> {
  const related = new Set<string>();
  for (const step of graph.steps) for (const call of step.calls) {
    const ids = [step.model.id, call.tool?.id, call.receipt?.id, call.nextModel?.id].filter((id): id is string => Boolean(id));
    if (selected !== null && ids.includes(selected)) ids.forEach(id => related.add(id));
  }
  return related;
}

export interface TokenUsage { input?: number; output?: number; total?: number; cached?: number }
const tokenNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
export function tokenUsage(event: TraceEvent): TokenUsage {
  const usage = object(event.output?.usage);
  return { input: tokenNumber(usage.prompt_tokens), output: tokenNumber(usage.completion_tokens), total: tokenNumber(usage.total_tokens), cached: tokenNumber(object(usage.prompt_tokens_details).cached_tokens) };
}
export function runUsage(run: Run): { models: number; input: { total?: number; count: number }; output: { total?: number; count: number }; total: { total?: number; count: number }; cached: { total?: number; count: number } } {
  const values = run.events.filter(event => event.kind === "model").map(tokenUsage);
  const sum = (field: keyof TokenUsage): { total?: number; count: number } => {
    const known = values.map(value => value[field]).filter((n): n is number => n !== undefined);
    return { total: known.length ? known.reduce((total, value) => total + value, 0) : undefined, count: known.length };
  };
  return { models: values.length, input: sum("input"), output: sum("output"), total: sum("total"), cached: sum("cached") };
}
export function formatDuration(seconds: number): string {
  return seconds < 1 ? (seconds * 1000).toFixed(1) + " ms" : seconds.toFixed(2) + " s";
}

export interface ExecutionSection { kind: "start" | "request" | "end"; anchor: TraceEvent; events: TraceEvent[] }
// Group for presentation without dropping or synthesizing any recorded event.
export function executionSections(run: Run): ExecutionSection[] {
  const sections: ExecutionSection[] = [];
  let section: ExecutionSection | undefined;
  for (const event of run.events) {
    const end = event.kind === "control" && typeof event.output?.run_status === "string";
    if (!section || event.kind === "model" || end) {
      section = { kind: end ? "end" : event.kind === "model" ? "request" : "start", anchor: event, events: [] };
      sections.push(section);
    }
    section.events.push(event);
  }
  return sections;
}
export function timelineLayout(run: Run, mode: "steps" | "time", elapsed = run.duration ?? 0): { extent: number; bars: { event: TraceEvent; left: number; width: number }[] } {
  const duration = (event: TraceEvent): number => event.status === "running" ? Math.max(0, elapsed - event.t) : event.d;
  const extent = mode === "steps" ? Math.max(1, run.events.length) : Math.max(.001, elapsed, ...run.events.map(event => event.t + duration(event)));
  return { extent, bars: run.events.map((event, index) => ({ event, left: mode === "steps" ? index / extent : event.t / extent, width: mode === "steps" ? .76 / extent : duration(event) / extent })) };
}
