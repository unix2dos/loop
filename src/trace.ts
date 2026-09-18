import { join } from 'node:path';
import type { Message, ModelCaller, Tool, ToolExecutor } from './agent.ts';
import { errBudget, RunLoop } from './agent.ts';
import { BuildTurnMessages, readonlyAccess } from './context.ts';
import { codingAccess, codingExercise, ExecuteCoding, ExecutionError } from './coding.ts';
import { errorDetails } from './model.ts';
import { appendJSON, saveRun } from './storage.ts';
import type { Run } from './storage.ts';
import { ExecuteReadonly } from './tools.ts';
import type { EventKind, EventStatus, JSONObject, TraceEvent } from '../web/src/types.ts';
export async function RunTask(signal: AbortSignal, run: Run, call: ModelCaller, tools: Tool[], output: string, prior: Message[] = []): Promise<void> {
    const started = performance.now(), path = join(output, 'trace.jsonl'), session = join(output, 'session.jsonl');
    const coding = run.exercise === codingExercise, access = coding ? codingAccess : readonlyAccess, dispatch = coding ? 'coding_dispatch' : 'dispatch';
    const begin = (kind: EventKind, title: string, input: object, code: string, explanation: string): TraceEvent => {
        const event: TraceEvent = { id: `e${String(run.events.length + 1).padStart(3, '0')}`, kind, title, turn: run.model_requests, t: (performance.now() - started) / 1000, d: 0, status: 'running', input: structuredClone(input) as JSONObject, output: null, code, explanation };
        appendJSON(path, { phase: 'start', ...event });
        run.events.push(event);
        return event;
    };
    const finish = (event: TraceEvent, output: object, status: EventStatus) => {
        Object.assign(event, { output: structuredClone(output), status, d: (performance.now() - started) / 1000 - event.t });
        appendJSON(path, { phase: 'finish', ...event });
    };
    const instant = (kind: EventKind, title: string, input: object, output: object, code: string, explanation: string) => finish(begin(kind, title, input, code, explanation), output, 'succeeded');
    const model: ModelCaller = async (signal, input) => {
        run.model_requests++;
        const event = begin('model', `第 ${run.model_requests} 次模型请求`, input, 'loop', '这里记录实际发送的消息和工具定义。模型提出调用请求后，工具才会执行。');
        try {
            const response = await call(signal, input);
            if (response.choices.length !== 1)
                throw new Error('invalid model choices');
            const choice = response.choices[0];
            finish(event, { finish_reason: choice.finish_reason, message: { ...choice.message, role: 'assistant' }, ...(response.usage ? { usage: response.usage } : {}) }, 'succeeded');
            return response;
        }
        catch (error) {
            finish(event, errorDetails(error), 'failed');
            throw error;
        }
    };
    const execute: ToolExecutor = async (signal, tool) => {
        run.tool_calls++;
        instant('control', '选择工具执行器', { tool: tool.function.name, arguments: tool.function.arguments, tool_call_id: tool.id }, { executor: coding ? 'ExecuteCoding' : 'ExecuteReadonly', allowed_tools: tools.map(t => t.function.name), exercise: run.exercise ?? '' }, dispatch, '这里选择受限执行器。参数与路径是否通过，以下一条工具事件的真实结果为准。');
        let code = dispatch;
        if (coding && tool.function.name === 'write_file')
            code = 'write';
        if (coding && tool.function.name === 'run_command')
            code = 'command';
        if (tool.function.name === 'read_file')
            code = 'read';
        if (!coding && tool.function.name === 'list_files')
            code = 'list';
        const event = begin('tool', tool.function.name, { arguments: tool.function.arguments, tool_call_id: tool.id }, code, '执行器返回真实结果；错误也会作为工具回执进入下一轮，并保留原调用编号。');
        let result: JSONObject;
        try {
            result = run.tool_calls > 24 ? { error: 'tool_budget_exhausted' } : coding ? await ExecuteCoding(signal, run.workspace, tool) : ExecuteReadonly(signal, run.workspace, tool);
        }
        catch (error) {
            finish(event, error instanceof ExecutionError ? error.result : errorDetails(error), 'failed');
            throw error;
        }
        const failed = Object.hasOwn(result, 'error');
        if (failed)
            run.tool_errors++;
        finish(event, result, failed ? 'failed' : 'succeeded');
        const content = JSON.stringify(result);
        instant('control', '交回工具回执', { tool_call_id: tool.id }, { tool_call_id: tool.id, content }, 'loop', '结果交回工具循环，随后作为 role=tool 消息追加，并与原 tool_call_id 配对。');
        return content;
    };
    let answer = '', failure: unknown;
    try {
        const { messages, runtime } = BuildTurnMessages(prior, run.task, run.workspace, access);
        instant('input', '提交任务', { task: run.task, exercise: run.exercise ?? '', conversation_turn: run.conversation_turn, parent_run_id: run.parent_run_id ?? '' }, { workspace: run.workspace, access, exercise_authorized: coding }, 'loop', '用户消息成为本轮输入；追问会携带已有对话，读取新的文件内容仍须通过工具。');
        instant('control', '准备上下文和请求额度', { max_requests: run.max_requests, tools, system: messages[0].content, runtime_context: runtime, system_policy: 'current_per_turn', system_refreshed: prior.length > 0, history_messages: prior.length, parent_run_id: run.parent_run_id ?? '' }, { status: 'ready' }, 'context', '本轮使用最新系统规则和服务端日期、时区；保留历史用户、模型与工具消息，不改写旧记录。时间是本轮开始时的快照；额度只限制本轮模型请求次数。');
        for (const message of messages)
            appendJSON(session, { type: 'message', message });
        answer = await RunLoop(signal, model, execute, run.model, tools, messages, session, run.max_requests);
    }
    catch (error) {
        failure = error;
    }
    const status = failure === undefined ? 'completed' : failure === errBudget ? 'budget_exhausted' : 'failed';
    const detail = failure === undefined ? null : errorDetails(failure);
    try {
        const event = begin('control', status === 'completed' ? '正常结束' : status === 'budget_exhausted' ? '达到请求上限' : '运行失败', { model_requests: run.model_requests, max_requests: run.max_requests }, 'loop', '正常结束只说明循环结束，不证明回答正确或任务验收通过。');
        finish(event, { run_status: status, task_result: 'not_evaluated', error: detail }, failure === undefined ? 'succeeded' : 'failed');
        Object.assign(run, { status, answer, error: detail, duration: (performance.now() - started) / 1000 });
        saveRun(join(output, 'run.json'), run);
    }
    catch (error) {
        run.status = 'failed';
        run.error = { error_type: 'StorageError', message: '本地运行记录保存失败' };
        throw error;
    }
}
