import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import type { ToolCall } from './agent.ts';
import { integerArgument, object, text } from './storage.ts';
export const maxReadBytes = 50 * 1024;
export function resolveWorkspace(workspace: string, name: string): string {
    if (!name || isAbsolute(name) || name.includes('\0'))
        throw new Error('relative path required');
    const root = realpathSync(workspace), target = realpathSync(join(root, name)), rel = relative(root, target);
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
        throw new Error('path escapes workspace');
    return target;
}
export function ReadFile(workspace: string, name: string, offset: number): Record<string, unknown> {
    if (!Number.isSafeInteger(offset) || offset < 0)
        throw new Error('invalid offset');
    const target = resolveWorkspace(workspace, name), fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        if (!fstatSync(fd).isFile())
            throw new Error('ordinary file required');
        const data = Buffer.alloc(maxReadBytes + 1);
        const size = readSync(fd, data, 0, data.length, offset), truncated = size > maxReadBytes;
        const raw = data.subarray(0, Math.min(size, maxReadBytes));
        return { path: name, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw), truncated, next_offset: truncated ? offset + raw.length : null };
    }
    finally {
        closeSync(fd);
    }
}
export function ListFiles(workspace: string, name: string, offset: number, limit: number): Record<string, unknown> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error('invalid pagination');
    const files = readdirSync(resolveWorkspace(workspace, name), { withFileTypes: true }).filter(e => e.isFile() && !e.isSymbolicLink()).map(e => e.name).sort();
    const start = Math.min(offset, files.length), end = Math.min(start + limit, files.length);
    return { path: name, files: files.slice(start, end), next_offset: end < files.length ? end : null };
}
export function ExecuteReadonly(signal: AbortSignal, workspace: string, call: ToolCall): Record<string, unknown> {
    signal.throwIfAborted();
    const reject = () => ({ error: 'tool_rejected', message: '请求不符合只读规则，或文件不可读取；检查工具名、相对路径和参数类型。' });
    try {
        const args = object(JSON.parse(call.function.arguments)), name = text(args.path);
        if (!name || name.split(/[\\/]/).some(p => p.startsWith('.') && p !== '.'))
            return reject();
        if (Object.keys(args).some(key => !['path', 'offset', ...(call.function.name === 'list_files' ? ['limit'] : [])].includes(key)))
            return reject();
        const offset = integerArgument(args, 'offset', 0);
        if (offset < 0)
            return reject();
        if (call.function.name === 'list_files') {
            const result = ListFiles(workspace, name, offset, integerArgument(args, 'limit', 20));
            result.files = (result.files as string[]).filter(file => file.endsWith('.md') && !file.startsWith('.'));
            return result;
        }
        if (call.function.name === 'read_file') {
            const target = resolveWorkspace(workspace, name);
            if (extname(target) !== '.md' || lstatSync(join(workspace, name)).isSymbolicLink())
                return reject();
            return ReadFile(workspace, name, offset);
        }
        return reject();
    }
    catch {
        return reject();
    }
}
