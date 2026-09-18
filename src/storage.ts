import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import type { Run, RunSummary, Source } from '../web/src/types.ts';
export type { Run, RunSummary, Source } from '../web/src/types.ts';
export const projectRoot = resolve(import.meta.dirname, '..');
export const runIDPattern = /^[a-f0-9]{32}$/;
export const eventIDPattern = /^e[0-9]+$/;
export const randomID = () => randomBytes(16).toString('hex');
export const fileHash = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
export function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('JSON object required');
    return value as Record<string, unknown>;
}
export function integerArgument(args: Record<string, unknown>, key: string, fallback: number): number {
    if (!Object.hasOwn(args, key))
        return fallback;
    if (!Number.isSafeInteger(args[key]))
        throw new Error('integer required');
    return args[key] as number;
}
export function text(value: unknown): string {
    if (typeof value !== 'string' || !value.isWellFormed())
        throw new Error('string required');
    return value;
}
export function ordinaryDirectory(path: string): void {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('ordinary directory required');
}
export function readOrdinaryFile(path: string, maxBytes = 64 * 1024 * 1024): Buffer {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.size > maxBytes)
            throw new Error('ordinary bounded file required');
        return readFileSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
export function appendJSON(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    ordinaryDirectory(dirname(path));
    const fd = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
        if (!fstatSync(fd).isFile())
            throw new Error('ordinary file required');
        writeFileSync(fd, JSON.stringify(value) + '\n');
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
export function atomicWrite(path: string, content: string, mode = 0o600): void {
    ordinaryDirectory(dirname(path));
    const temporary = join(dirname(path), `.loop-${randomID()}.tmp`);
    const fd = openSync(temporary, 'wx', mode);
    try {
        try {
            writeFileSync(fd, content);
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        renameSync(temporary, path);
    }
    finally {
        rmSync(temporary, { force: true });
    }
}
export function saveRun(path: string, run: Run): void { atomicWrite(path, JSON.stringify(run, null, 2) + '\n'); }
export function summarizeRun(run: Run): RunSummary {
    const { id, task, model, status, created_at, exercise, parent_run_id, conversation_id, conversation_turn } = run;
    return { id, task, model, status, created_at, ...(exercise ? { exercise } : {}), ...(parent_run_id ? { parent_run_id, conversation_id } : {}), conversation_turn };
}
export function sortedSummaries(history: Map<string, RunSummary>): RunSummary[] {
    return [...history.values()].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
}
// Capture the exact source and assets once at server startup, before accepting runs.
export function sourceRecords(): {
    sources: Record<string, Source>;
    buildID: string;
} {
    const definitions: [
        string,
        string,
        string
    ][] = [
        ['context', 'context.ts', 'BuildTurnMessages'], ['loop', 'agent.ts', 'RunLoop'],
        ['coding_dispatch', 'coding.ts', 'ExecuteCoding'], ['command', 'coding.ts', 'RunExerciseTests'], ['write', 'coding.ts', 'WriteExerciseFile'],
        ['dispatch', 'tools.ts', 'ExecuteReadonly'], ['read', 'tools.ts', 'ReadFile'], ['list', 'tools.ts', 'ListFiles'],
    ];
    const sources: Record<string, Source> = {};
    const paths = ['index.html', 'tools.json', 'coding-tools.json', 'package.json',
        ...readdirSync(join(projectRoot, 'src')).filter(p => p.endsWith('.ts')).map(p => `src/${p}`),
        ...readdirSync(join(projectRoot, 'web/dist')).filter(p => p.endsWith('.js')).map(p => `web/dist/${p}`),
        ...readdirSync(join(projectRoot, 'testdata/ts-average')).map(p => `testdata/ts-average/${p}`)];
    const hash = createHash('sha256'), rawFiles = new Map<string, string>();
    for (const path of paths.sort()) {
        const raw = readFileSync(join(projectRoot, path), 'utf8');
        rawFiles.set(path, raw);
        hash.update(path).update('\0').update(raw);
    }
    for (const [key, file, name] of definitions) {
        const path = `src/${file}`, raw = rawFiles.get(path)!;
        const tree = ts.createSourceFile(path, raw, ts.ScriptTarget.Latest, true);
        const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
        if (!fn)
            throw new Error(`missing source function ${name}`);
        const start = fn.getStart(tree);
        sources[key] = { path, line: tree.getLineAndCharacterOfPosition(start).line + 1, code: raw.slice(start, fn.end) };
    }
    return { sources, buildID: hash.digest('hex') };
}
export function decodeHistory(raw: Buffer | string, id: string): Run {
    const run = object(JSON.parse(raw.toString()));
    if (!runIDPattern.test(id) || run.id !== id || run.engine !== 'typescript')
        throw new Error('invalid run identity');
    for (const key of ['task', 'model', 'workspace', 'answer', 'task_result', 'build_id'])
        text(run[key]);
    if (run.exercise !== undefined && run.exercise !== 'ts-average')
        throw new Error('invalid exercise');
    if (!['completed', 'failed', 'budget_exhausted'].includes(text(run.status)))
        throw new Error('unfinished run');
    for (const key of ['created_at', 'duration', 'model_requests', 'tool_calls', 'tool_errors']) {
        if (typeof run[key] !== 'number' || !Number.isFinite(run[key]) || run[key] < 0)
            throw new Error('invalid counters');
    }
    for (const key of ['model_requests', 'tool_calls', 'tool_errors', 'conversation_turn', 'max_requests']) {
        if (!Number.isSafeInteger(run[key]))
            throw new Error('invalid integer');
    }
    if ((run.max_requests as number) < 1 || (run.max_requests as number) > 8)
        throw new Error('invalid budget');
    if (run.error !== null)
        object(run.error);
    if (run.parent_run_id !== undefined) {
        if (!runIDPattern.test(text(run.parent_run_id)) || run.parent_run_id === id || !runIDPattern.test(text(run.conversation_id)) || run.conversation_id === id || (run.conversation_turn as number) < 2)
            throw new Error('invalid conversation link');
    }
    else if (run.conversation_id !== undefined || run.conversation_turn !== 1)
        throw new Error('invalid root');
    if (!Array.isArray(run.events) || !run.events.length)
        throw new Error('invalid events');
    const sources = object(run.source), ids = new Set<string>();
    for (const item of run.events) {
        const event = object(item), eventID = text(event.id);
        if (!eventIDPattern.test(eventID) || ids.has(eventID))
            throw new Error('invalid event identity');
        ids.add(eventID);
        for (const key of ['title', 'code', 'explanation'])
            text(event[key]);
        if (!['input', 'model', 'tool', 'control'].includes(text(event.kind)) || !['succeeded', 'failed'].includes(text(event.status)))
            throw new Error('invalid event state');
        for (const key of ['t', 'd', 'turn'])
            if (typeof event[key] !== 'number' || !Number.isFinite(event[key]) || event[key] < 0)
                throw new Error('invalid event timing');
        if (!Number.isSafeInteger(event.turn))
            throw new Error('invalid event turn');
        object(event.input);
        object(event.output);
        const source = object(sources[text(event.code)]);
        text(source.path);
        text(source.code);
        if (!Number.isSafeInteger(source.line) || (source.line as number) < 1)
            throw new Error('invalid source');
    }
    return run as unknown as Run;
}
export function readRunFile(directory: string, id: string, name: string): Buffer {
    if (!runIDPattern.test(id) || !['run.json', 'trace.jsonl', 'session.jsonl'].includes(name))
        throw new Error('invalid record path');
    ordinaryDirectory(directory);
    ordinaryDirectory(join(directory, id));
    return readOrdinaryFile(join(directory, id, name), name === 'session.jsonl' ? 16 * 1024 * 1024 : 64 * 1024 * 1024);
}
export function readStoredRun(directory: string, id: string): Run { return decodeHistory(readRunFile(directory, id, 'run.json'), id); }
export function loadHistory(directory: string) {
    const history = new Map<string, RunSummary>();
    let skipped = 0;
    if (existsSync(directory)) {
        // ponytail: scan once and retain summaries; add a persistent index if startup scans become slow.
        for (const id of readdirSync(directory)) {
            if (!runIDPattern.test(id))
                continue;
            try {
                history.set(id, summarizeRun(readStoredRun(directory, id)));
            }
            catch {
                skipped++;
            }
        }
    }
    return { history, skipped };
}
