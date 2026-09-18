import { appendJSON } from './storage.ts';
export interface ToolCall {
    id: string;
    type: string;
    function: {
        name: string;
        arguments: string;
    };
}
export interface Message {
    role: string;
    content: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}
export interface Tool {
    type: string;
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}
export interface ModelRequest {
    model: string;
    messages: Message[];
    tools: Tool[];
}
export interface ModelResponse {
    choices: {
        finish_reason: string;
        message: Message;
    }[];
    usage?: Record<string, unknown>;
}
export type ModelCaller = (signal: AbortSignal, input: ModelRequest) => Promise<ModelResponse>;
export type ToolExecutor = (signal: AbortSignal, call: ToolCall) => Promise<string>;
export const errBudget = new Error('model request budget exhausted');
// Own ordering and stopping; model transport and tool execution are supplied by the caller.
export async function RunLoop(signal: AbortSignal, call: ModelCaller, execute: ToolExecutor, model: string, tools: Tool[], initial: Message[], session: string, maxRequests: number): Promise<string> {
    if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 8)
        throw new Error('invalid request budget');
    const messages = [...initial];
    const add = (message: Message) => {
        messages.push(message);
        if (session)
            appendJSON(session, { type: 'message', message });
    };
    for (let request = 0; request < maxRequests; request++) {
        signal.throwIfAborted();
        const response = await call(signal, { model, messages, tools });
        if (response.choices.length !== 1)
            throw new Error('expected one model choice');
        const choice = response.choices[0];
        const message: Message = { ...choice.message, role: 'assistant' };
        delete message.tool_call_id;
        add(message);
        if (message.tool_calls?.length) {
            if (choice.finish_reason !== 'tool_calls')
                throw new Error('tool calls with inconsistent finish reason');
            const ids = new Set<string>();
            for (const tool of message.tool_calls) {
                if (!tool.id || ids.has(tool.id) || !tool.function.name || tool.type !== 'function')
                    throw new Error('invalid tool call identity');
                ids.add(tool.id);
            }
            for (const tool of message.tool_calls) {
                signal.throwIfAborted();
                const content = await execute(signal, tool);
                add({ role: 'tool', content, tool_call_id: tool.id });
            }
            continue;
        }
        if (choice.finish_reason === 'stop')
            return message.content;
        throw new Error(`model did not stop normally: ${choice.finish_reason}`);
    }
    throw errBudget;
}
