import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolCall } from './agent.ts';
import { atomicWrite, fileHash, object, ordinaryDirectory, projectRoot, randomID, readOrdinaryFile, runIDPattern, text } from './storage.ts';
import { maxReadBytes, ReadFile } from './tools.ts';
export const codingExercise = 'ts-average' as const;
export const codingImage = 'node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553';
export const codingTask = '修复 average 在空数组或 null 输入时发生的错误，保留非空输入向零取整的平均行为。先运行 node --test average.test.ts 确认问题，再读取代码并修改 average.ts，最后重新运行测试，依据真实输出报告结果。不要修改测试或 package.json。';
export const codingAccess = '本次已授权独立 TypeScript 练习：可以读取项目文件，仅可通过 write_file 修改 average.ts。只允许运行 node --test average.test.ts，测试在断网、非 root、项目只读挂载的容器中执行。测试与 package.json 受保护。测试失败应根据回执修正代码后再验证；不能声称未执行的测试已经通过。';
export const exerciseFiles = ['README.md', 'average.ts', 'average.test.ts', 'package.json'];
export interface CommandResult {
    stdout: string;
    stderr: string;
    code: number | null;
    timedOut: boolean;
    truncated: boolean;
}
export async function dockerCommand(args: string[], signal: AbortSignal): Promise<CommandResult> {
    signal.throwIfAborted();
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'XDG_RUNTIME_DIR', 'TMPDIR'])
        if (process.env[key] !== undefined)
            env[key] = process.env[key];
    return new Promise((resolve, reject) => {
        const child = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
        const stdout: Buffer[] = [], stderr: Buffer[] = [];
        let outSize = 0, errSize = 0, truncated = false;
        const collect = (chunks: Buffer[], data: Buffer, size: number) => { const keep = Math.min(data.length, Math.max(0, 65536 - size)); if (keep < data.length)
            truncated = true; chunks.push(data.subarray(0, keep)); return size + keep; };
        child.stdout.on('data', (data: Buffer) => { outSize = collect(stdout, data, outSize); });
        child.stderr.on('data', (data: Buffer) => { errSize = collect(stderr, data, errSize); });
        const abort = () => child.kill('SIGKILL');
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted)
            abort();
        child.once('error', error => { signal.removeEventListener('abort', abort); reject(error); });
        child.once('close', code => { signal.removeEventListener('abort', abort); resolve({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), code, timedOut: signal.aborted, truncated }); });
    });
}
export async function codingReady(): Promise<string> {
    try {
        const result = await dockerCommand(['image', 'inspect', codingImage], AbortSignal.timeout(4000));
        if (result.code === 0 && !result.timedOut)
            return '';
    }
    catch { /* Report one actionable setup message. */ }
    return '请先启动 Docker，并按 Coding 练习文档准备 Node 镜像';
}
export function exerciseTemplate(name: string): Buffer { return readFileSync(join(projectRoot, 'testdata/ts-average', name)); }
export function prepareExercise(state: string, id: string): string {
    if (!runIDPattern.test(id))
        throw new Error('invalid exercise ID');
    ordinaryDirectory(state);
    const root = join(state, id);
    mkdirSync(root, { mode: 0o700 });
    const folder = join(root, 'workspace');
    mkdirSync(folder, { mode: 0o755 });
    for (const name of exerciseFiles)
        atomicWrite(join(folder, name), exerciseTemplate(name).toString(), 0o644);
    return folder;
}
export function checkExercise(workspace: string): void {
    ordinaryDirectory(workspace);
    if (readdirSync(workspace).length !== exerciseFiles.length)
        throw new Error('练习项目出现了未授权的文件，请检查项目');
    for (const name of exerciseFiles) {
        const path = join(workspace, name), info = lstatSync(path);
        if (info.nlink !== 1)
            throw new Error('练习文件不得使用硬链接');
        const raw = readOrdinaryFile(path, maxReadBytes);
        new TextDecoder('utf-8', { fatal: true }).decode(raw);
        if (name !== 'average.ts' && !raw.equals(exerciseTemplate(name)))
            throw new Error('受保护的练习材料已变化，请开始新的练习');
    }
}
export async function ExecuteCoding(signal: AbortSignal, workspace: string, call: ToolCall): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const reject = (message: string) => ({ error: 'tool_rejected', message });
    let args: Record<string, unknown>;
    try {
        checkExercise(workspace);
        args = object(JSON.parse(call.function.arguments));
        const expected = call.function.name === 'write_file' ? ['path', 'content', 'expected_sha256'] : call.function.name === 'run_command' ? ['command'] : ['path'];
        if (Object.keys(args).some(key => !expected.includes(key)) || expected.some(key => typeof args[key] !== 'string' || !text(args[key]).isWellFormed()))
            return reject('工具参数或字段不符合要求');
    }
    catch {
        return reject('练习文件或工具参数无效，请检查输入');
    }
    switch (call.function.name) {
        case 'list_files': return args.path === '.' ? { path: '.', files: exerciseFiles, next_offset: null } : reject('本练习只允许列出根目录 .');
        case 'read_file': {
            const name = text(args.path);
            if (!exerciseFiles.includes(name))
                return reject('只能读取本练习列出的四份文件');
            const result = ReadFile(workspace, name, 0);
            return { ...result, sha256: fileHash(text(result.content)) };
        }
        case 'write_file': return WriteExerciseFile(workspace, text(args.path), text(args.content), text(args.expected_sha256));
        case 'run_command': return args.command === 'node --test average.test.ts' ? RunExerciseTests(signal, workspace) : reject('本练习仅允许命令 node --test average.test.ts');
        default: return reject('未提供这个工具');
    }
}
// ponytail: one active writer in an isolated exercise; shared repositories need coordinated writes.
export function WriteExerciseFile(workspace: string, path: string, content: string, expected: string): Record<string, unknown> {
    if (path !== 'average.ts' || !content || !content.isWellFormed() || Buffer.byteLength(content) > maxReadBytes)
        return { error: 'tool_rejected', message: '只允许修改 average.ts，内容须为不超过 50 KiB 的 UTF-8 文本' };
    try {
        checkExercise(workspace);
    }
    catch {
        return { error: 'tool_rejected', message: '练习文件类型或内容已变化' };
    }
    const target = join(workspace, path), before = readOrdinaryFile(target, maxReadBytes).toString();
    if (expected !== fileHash(before))
        return { error: 'file_changed', message: '文件版本与读取时不同，本次没有写入；请重新读取后再修改' };
    if (before === content)
        return { path, changed: false, sha256: expected };
    atomicWrite(target, content, 0o644);
    return { path, changed: true, before_sha256: expected, sha256: fileHash(content), before, after: content, diff: exerciseDiff(before, content) };
}
export function exerciseDiff(before: string, after: string): string {
    const lines = (s: string) => s ? s.replace(/\n$/, '').split('\n') : [];
    let result = `--- a/average.ts\n+++ b/average.ts\n@@ -1,${lines(before).length} +1,${lines(after).length} @@\n`;
    for (const [prefix, value] of [['-', before], ['+', after]]) {
        for (const line of lines(value))
            result += prefix + line + '\n';
        if (value && !value.endsWith('\n'))
            result += '\\ No newline at end of file\n';
    }
    return result;
}
export function exerciseContainerArgs(workspace: string, name: string): string[] {
    // Docker's --mount syntax uses commas as separators; reject ambiguous host paths.
    if (workspace.includes(','))
        throw new Error('练习路径不可包含逗号');
    return ['create', '--name', name, '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '768m', '--cpus', '2', '--user', '65532:65532', '--tmpfs', '/tmp:rw,exec,nosuid,size=256m', '--mount', `type=bind,src=${workspace},dst=/workspace,readonly`, '--workdir', '/workspace', '--env', 'HOME=/tmp', codingImage, 'node', '--test', 'average.test.ts'];
}
export class ExecutionError extends Error {
    result: Record<string, unknown>;
    constructor(message: string, result: Record<string, unknown>) { super(message); this.result = result; }
}
export async function RunExerciseTests(signal: AbortSignal, workspace: string): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    checkExercise(workspace);
    const name = 'loop-exercise-' + randomID();
    const result: Record<string, unknown> = { command: 'node --test average.test.ts', image: codingImage, network: 'none', workspace_mount: 'read-only', container_name: name, exit_code: null, timed_out: false, tested_sha256: fileHash(readOrdinaryFile(join(workspace, 'average.ts'), maxReadBytes)) };
    let container = '';
    try {
        // Resolve create independently of cancellation; the test starts only after identity is known.
        const created = await dockerCommand(exerciseContainerArgs(workspace, name), AbortSignal.timeout(10000));
        container = created.stdout.trim();
        if (created.code !== 0 || !/^[a-f0-9]{64}$/.test(container)) {
            result.error = 'container_create_failed';
            throw new ExecutionError('无法确认容器创建结果，代码尚未启动', result);
        }
        result.container_id = container;
        const timeout = AbortSignal.timeout(90000), running = AbortSignal.any([signal, timeout]);
        const output = await dockerCommand(['start', '--attach', container], running);
        Object.assign(result, { stdout: output.stdout, stderr: output.stderr, output_truncated: output.truncated });
        if (running.aborted) {
            result.error = signal.aborted ? 'command_canceled' : 'command_timeout';
            result.timed_out = timeout.aborted;
            if (signal.aborted)
                throw new ExecutionError('运行已取消', result);
            return result;
        }
        const inspected = await dockerCommand(['inspect', '--format', '{{.State.Running}} {{.State.ExitCode}}', container], AbortSignal.timeout(5000));
        const match = /^false (-?\d+)$/.exec(inspected.stdout.trim());
        if (inspected.code !== 0 || !match)
            throw new ExecutionError('无法确认测试进程退出状态', result);
        result.exit_code = Number(match[1]);
        if (result.exit_code !== 0)
            result.error = 'command_failed';
        else if (output.code !== 0)
            throw new ExecutionError('测试连接异常', result);
        return result;
    }
    catch (error) {
        if (error instanceof ExecutionError)
            throw error;
        throw new ExecutionError('容器执行状态未确认，请检查 Docker', result);
    }
    finally {
        // A generated unique name also reconciles a create whose response was lost.
        try {
            const cleaned = await dockerCommand(['rm', '--force', /^[a-f0-9]{64}$/.test(container) ? container : name], AbortSignal.timeout(10000));
            result.cleanup_confirmed = cleaned.code === 0 || /No such container/.test(cleaned.stderr);
        }
        catch {
            result.cleanup_confirmed = false;
        }
        if (!result.cleanup_confirmed)
            throw new ExecutionError('练习容器清理未确认，请停止并检查 Docker', result);
    }
}
