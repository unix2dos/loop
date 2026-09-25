export type JSONObject = Record<string, unknown>;
export type RunStatus = "running" | "completed" | "failed" | "budget_exhausted";
export type EventKind = "input" | "model" | "tool" | "control";
export type EventStatus = "running" | "succeeded" | "failed";

export interface Source {
  path: string;
  line: number;
  code: string;
}
export interface TraceEvent {
  id: string;
  kind: EventKind;
  title: string;
  turn: number;
  t: number;
  d: number;
  status: EventStatus;
  input: JSONObject;
  output: JSONObject | null;
  code: string;
  explanation: string;
}
export interface RunSummary {
  exercise?: "ts-average";
  visitor_id?: string;
  parent_run_id?: string;
  conversation_id?: string;
  conversation_turn?: number;
  id: string;
  task: string;
  model: string;
  status: RunStatus;
  created_at: number;
}
export interface Run extends RunSummary {
  workspace: string;
  max_requests: number;
  task_result: string;
  answer: string;
  error: JSONObject | null;
  events: TraceEvent[];
  duration?: number;
  model_requests: number;
  tool_calls: number;
  tool_errors: number;
  source: Record<string, Source>;
  engine?: string;
  build_id?: string;
}
export interface Config {
  public_mode: boolean;
  workspace: string;
  state_dir: string;
  model: string;
  configured: boolean;
  token: string;
  default_task: string;
  coding_available: boolean;
  coding_ready: boolean;
  coding_message: string;
  coding_task: string;
  history: { loaded: number; skipped: number };
}
