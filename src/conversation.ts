import type { Message } from './agent.ts';
import { parseMessage } from './model.ts';
import { object, readRunFile } from './storage.ts';
import type { Run } from './storage.ts';
export function conversationMessages(state: string, parent: Run): Message[] {
    const invalid = new Error('上一轮消息记录不完整或工具回执未配对，无法继续；请开始新任务');
    let raw: Buffer;
    try {
        raw = readRunFile(state, parent.id, 'session.jsonl');
    }
    catch {
        throw new Error('上一轮完整消息记录不可用，无法继续；请开始新任务');
    }
    const messages: Message[] = [], pending = new Set<string>();
    let users = 0;
    try {
        for (const line of raw.toString().trim().split('\n')) {
            const record = object(JSON.parse(line));
            if (record.type !== 'message')
                throw invalid;
            const m = parseMessage(record.message);
            if (!messages.length && m.role !== 'system' || pending.size && m.role !== 'tool')
                throw invalid;
            if (m.role !== 'assistant' && m.tool_calls?.length || m.role !== 'tool' && m.tool_call_id)
                throw invalid;
            switch (m.role) {
                case 'system':
                    if (messages.length)
                        throw invalid;
                    break;
                case 'user':
                    users++;
                    break;
                case 'assistant':
                    for (const call of m.tool_calls ?? []) {
                        if (!call.id || pending.has(call.id) || call.type !== 'function' || !call.function.name)
                            throw invalid;
                        pending.add(call.id);
                    }
                    break;
                case 'tool':
                    if (!m.tool_call_id || !pending.delete(m.tool_call_id))
                        throw invalid;
                    break;
                default: throw invalid;
            }
            messages.push(m);
        }
        if (pending.size || users !== parent.conversation_turn)
            throw invalid;
    }
    catch {
        throw invalid;
    }
    return messages;
}
