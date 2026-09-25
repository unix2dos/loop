import type { Message, ModelCaller, ModelResponse, ToolCall } from './agent.ts';
import { errBudget, errPublicQuota } from './agent.ts';
import { object } from './storage.ts';
export class ModelError extends Error {
    status?: number;
    code?: string;
    constructor(type: string, status?: number, code?: string) { super(type); this.name = type; this.status = status; this.code = code; }
}
export function parseMessage(value: unknown): Message {
    const m = object(value);
    if (typeof m.role !== 'string' || (m.content !== null && m.content !== undefined && typeof m.content !== 'string'))
        throw new Error('invalid message');
    const result: Message = { role: m.role, content: (m.content ?? '') as string };
    if (m.tool_call_id !== undefined && m.tool_call_id !== null) {
        if (typeof m.tool_call_id !== 'string')
            throw new Error('invalid tool id');
        result.tool_call_id = m.tool_call_id;
    }
    if (m.tool_calls !== undefined && m.tool_calls !== null) {
        if (!Array.isArray(m.tool_calls))
            throw new Error('invalid calls');
        result.tool_calls = m.tool_calls.map((value): ToolCall => {
            const call = object(value), fn = object(call.function);
            if (typeof call.id !== 'string' || typeof call.type !== 'string' || typeof fn.name !== 'string' || typeof fn.arguments !== 'string')
                throw new Error('invalid call');
            return { id: call.id, type: call.type, function: { name: fn.name, arguments: fn.arguments } };
        });
    }
    return result;
}
export function HTTPModel(runID: string): {
    call: ModelCaller;
    model: string;
} {
    const { OPENAI_API_KEY: key, OPENAI_MODEL: model } = process.env;
    if (!key || !model)
        throw new Error('missing model configuration');
    const endpoint = new URL(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1');
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)
        throw new Error('invalid model endpoint');
    endpoint.pathname = endpoint.pathname.replace(/\/$/, '') + '/chat/completions';
    const call: ModelCaller = async (signal, input) => {
        const headers: Record<string, string> = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': 'loop/0.1' };
        if (endpoint.hostname === 'opencode.ai')
            headers['x-opencode-session'] = runID;
        const timeout = AbortSignal.timeout(60000);
        let response: Response;
        try {
            response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(input), signal: AbortSignal.any([signal, timeout]), redirect: 'error' });
        }
        catch {
            signal.throwIfAborted();
            throw new ModelError('ConnectionOrTimeoutError');
        }
        let raw = '';
        try {
            const reader = response.body?.getReader();
            if (!reader)
                throw new Error('missing body');
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    size += value.length;
                    if (size > 8 * 1024 * 1024)
                        throw new Error('response too large');
                    chunks.push(value);
                }
            }
            finally {
                await reader.cancel();
            }
            raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        }
        catch {
            signal.throwIfAborted();
            throw new ModelError(timeout.aborted ? 'ConnectionOrTimeoutError' : 'InvalidResponse');
        }
        if (!response.ok) {
            let code: unknown;
            try {
                const body = object(JSON.parse(raw));
                code = body.type || body.code;
            }
            catch { /* Only expose a bounded provider code. */ }
            throw new ModelError('ProviderError', response.status, typeof code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(code) ? code : undefined);
        }
        try {
            const body = object(JSON.parse(raw));
            if (!Array.isArray(body.choices) || body.choices.length !== 1)
                throw new Error('invalid choices');
            const choice = object(body.choices[0]);
            if (typeof choice.finish_reason !== 'string')
                throw new Error('invalid finish reason');
            const result: ModelResponse = { choices: [{ finish_reason: choice.finish_reason, message: parseMessage(choice.message) }] };
            if (body.usage != null)
                result.usage = object(body.usage);
            return result;
        }
        catch {
            throw new ModelError('InvalidResponse');
        }
    };
    return { call, model };
}
export function errorDetails(error: unknown): Record<string, unknown> {
	const detail: Record<string, unknown> = { error_type: 'RuntimeError', message: error === errBudget ? '本轮模型请求次数已达上限' : error === errPublicQuota ? '公共模型额度已用完' : '运行失败，请查看失败事件' };
    if (error instanceof ModelError) {
        detail.error_type = error.name;
        if (error.status)
            detail.http_status = error.status;
        if (error.code)
            detail.provider_error = error.code;
    }
    if (error instanceof Error && error.name === 'AbortError')
        detail.error_type = 'Canceled';
    if (error instanceof Error && error.name === 'TimeoutError')
        detail.error_type = 'DeadlineExceeded';
    return detail;
}
