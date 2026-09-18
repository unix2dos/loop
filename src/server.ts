import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import type { Message, ModelCaller, Tool } from './agent.ts';
import { checkExercise, codingExercise, codingReady, codingTask, prepareExercise } from './coding.ts';
import { conversationMessages } from './conversation.ts';
import { HTTPModel } from './model.ts';
import { locateRecord, openRecordEditor } from './record.ts';
import { integerArgument, loadHistory, object, ordinaryDirectory, projectRoot, randomID, readStoredRun, runIDPattern, sortedSummaries, sourceRecords, summarizeRun, text } from './storage.ts';
import type { Run } from './storage.ts';
import { RunTask } from './trace.ts';
export const defaultTask = '先列出工作区文件，再读取与工具调用最相关的一份笔记。根据原文说明：模型提出工具调用之后，程序还要做什么？请注明文件名和原文依据，只读，不修改文件。';
export type CallerFactory = (id: string) => {
    call: ModelCaller;
    model: string;
};
class HTTPError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
}
export function localRequest(req: IncomingMessage): boolean {
    const host = req.headers.host ?? '', match = /^(127\.0\.0\.1|localhost):(\d+)$/.exec(host);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535 || Number(match[2]) !== req.socket.localPort)
        return false;
    return (!req.headers.origin || req.headers.origin === `http://${host}`) && req.headers['sec-fetch-site'] !== 'cross-site';
}
export function allowedRequest(req: IncomingMessage): boolean {
    if (process.env.LOOP_PUBLIC !== '1')
        return localRequest(req);
    return req.headers['sec-fetch-site'] !== 'cross-site' && (!req.headers.origin || [`http://${req.headers.host}`, `https://${req.headers.host}`].includes(req.headers.origin));
}
function write(res: ServerResponse, status: number, raw: string | Buffer, type = 'application/json; charset=utf-8'): void {
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(raw), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
    res.end(raw);
}
function respond(res: ServerResponse, status: number, value: unknown): void { write(res, status, JSON.stringify(value)); }
async function body(req: IncomingMessage, keys: string[], limit: number): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let length = 0;
    try {
        for await (const chunk of req) {
            length += chunk.length;
            if (length <= limit)
                chunks.push(chunk);
        }
        if (length > limit)
            throw new Error('large body');
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), data = object(JSON.parse(raw));
        if (Object.keys(data).some(key => !keys.includes(key)))
            throw new Error('unknown field');
        return data;
    }
    catch {
        throw new HTTPError(400, '请求 JSON、参数或大小无效');
    }
}
export function NewServer(workspace: string, state: string, factory: CallerFactory = HTTPModel) {
    workspace = resolve(workspace);
    state = resolve(state);
    if (!statSync(workspace).isDirectory())
        throw new Error('工作区必须是存在的目录');
    mkdirSync(state, { recursive: true, mode: 0o700 });
    ordinaryDirectory(state);
    const { history, skipped } = loadHistory(state), loaded = history.size;
    const { sources, buildID } = sourceRecords(), runs = new Map<string, Run>();
    const token = randomBytes(32).toString('hex');
    const tools = JSON.parse(readFileSync(join(projectRoot, 'tools.json'), 'utf8')) as Tool[];
    const codingTools = JSON.parse(readFileSync(join(projectRoot, 'coding-tools.json'), 'utf8')) as Tool[];
    // Cache assets alongside the source snapshot, so editing disk cannot change a running build's UI.
    const assets = new Map<string, {
        raw: Buffer;
        type: string;
    }>();
    for (const [url, path, type] of [['/', 'index.html', 'text/html'], ['/icon.png', 'assets/branding/loop-icon-v1.png', 'image/png'],
        ...['app', 'trace-graph', 'conversation'].map(name => [`/${name}.js`, `web/dist/${name}.js`, 'text/javascript'])]) {
        assets.set(url, { raw: readFileSync(join(projectRoot, path)), type });
    }
    let active = false;
    function newRun(task: string, budget: number, model: string): Run {
        task = text(task).trim();
        if (!task || [...task].length > 4000 || !Number.isInteger(budget) || budget < 1 || budget > 8)
            throw new HTTPError(400, '任务或请求上限无效');
        return { id: randomID(), conversation_turn: 1, task, model, workspace, max_requests: budget, status: 'running', task_result: 'not_evaluated', answer: '', error: null, events: [], created_at: Date.now() / 1000, duration: 0, model_requests: 0, tool_calls: 0, tool_errors: 0, source: structuredClone(sources), engine: 'typescript', build_id: buildID };
    }
    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (req.method === 'GET' && ['/healthz', '/readyz'].includes(path)) {
            respond(res, 200, { status: path === '/healthz' ? 'ok' : 'ready' });
            return;
        }
        if (!allowedRequest(req))
            throw new HTTPError(403, '仅接受同源请求');
        if (req.method === 'GET') {
            const asset = assets.get(path);
            if (asset) {
                write(res, 200, asset.raw, asset.type);
                return;
            }
            if (path === '/favicon.ico') {
                write(res, 204, '', 'image/x-icon');
                return;
            }
            if (path === '/api/config') {
                const available = process.env.LOOP_PUBLIC !== '1' && localRequest(req), message = available ? await codingReady() : 'Coding 练习只在本机提供';
                respond(res, 200, { workspace, state_dir: state, model: process.env.OPENAI_MODEL ?? '', configured: !!(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL), token, default_task: defaultTask,
                    coding_available: available, coding_ready: available && !message, coding_message: message, coding_task: codingTask, history: { loaded, skipped } });
                return;
            }
            if (path === '/api/runs') {
                for (const [id, run] of runs)
                    history.set(id, summarizeRun(run));
                respond(res, 200, sortedSummaries(history));
                return;
            }
            const match = /^\/api\/runs\/([a-f0-9]{32})$/.exec(path);
            if (match) {
                try {
                    respond(res, 200, runs.get(match[1]) ?? readStoredRun(state, match[1]));
                }
                catch {
                    throw new HTTPError(404, '运行记录不存在、尚未保存或格式无效');
                }
                return;
            }
            throw new HTTPError(404, 'not_found');
        }
        const record = /^\/api\/runs\/([a-f0-9]{32})\/open-record$/.exec(path);
        if (req.method !== 'POST' || path !== '/api/runs' && !record)
            throw new HTTPError(404, 'not_found');
        const supplied = Buffer.from(String(req.headers['x-lab-token'] ?? ''));
        if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token)))
            throw new HTTPError(403, '请求令牌无效，请刷新页面');
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json')
            throw new HTTPError(415, '需要 JSON 请求');
        if (record) {
            if (process.env.LOOP_PUBLIC === '1' || !localRequest(req))
                throw new HTTPError(403, '本地编辑器仅限本机访问');
            const data = await body(req, ['event_id', 'field'], 4096);
            let location;
            try {
                location = locateRecord(state, record[1], text(data.event_id), data.field === undefined ? '' : text(data.field));
            }
            catch {
                throw new HTTPError(404, '未找到对应的本地记录或字段；请稍后重试');
            }
            try {
                const editor = await openRecordEditor(location);
                respond(res, 200, { ...location, editor });
            }
            catch (error) {
                throw new HTTPError(500, (error as Error).message);
            }
            return;
        }
        const data = await body(req, ['exercise', 'approve_exercise', 'parent_run_id', 'task', 'max_requests'], 20000);
        let exercise: string, parentID: string, run: Run;
        try {
            exercise = data.exercise === undefined ? '' : text(data.exercise);
            parentID = data.parent_run_id === undefined ? '' : text(data.parent_run_id);
            if (data.approve_exercise !== undefined && typeof data.approve_exercise !== 'boolean')
                throw new Error('invalid approval');
            run = newRun(text(data.task), integerArgument(data, 'max_requests', 4), process.env.OPENAI_MODEL ?? '');
        }
        catch {
            throw new HTTPError(400, '任务或请求上限无效');
        }
        if (exercise && (exercise !== codingExercise || parentID) || data.approve_exercise && !exercise)
            throw new HTTPError(400, '练习参数无效；请从新的 Coding 练习开始');
        if (exercise && (!data.approve_exercise || process.env.LOOP_PUBLIC === '1' || !localRequest(req)))
            throw new HTTPError(403, 'Coding 练习需要本机用户明确授权');
        if (active)
            throw new HTTPError(409, '已有任务运行中，请等它结束');
        // ponytail: one active run, reserved before async setup. Add a queue only when parallel tasks are a product requirement.
        active = true;
        let submitted = false;
        try {
            let prior: Message[] = [];
            if (parentID) {
                if (!runIDPattern.test(parentID))
                    throw new HTTPError(400, '上一轮记录无效');
                if ([...history.values()].some(item => item.parent_run_id === parentID))
                    throw new HTTPError(409, '这段对话已有后续消息，请刷新后继续');
                let parent: Run;
                try {
                    parent = readStoredRun(state, parentID);
                }
                catch {
                    throw new HTTPError(400, '上一轮记录尚未保存或不可用，无法继续对话');
                }
                if (parent.exercise === codingExercise) {
                    if (process.env.LOOP_PUBLIC === '1' || !localRequest(req))
                        throw new HTTPError(403, 'Coding 练习仅限本机访问');
                    const rootID = parent.conversation_id ?? parent.id;
                    try {
                        const root = readStoredRun(state, rootID);
                        if (root.exercise !== codingExercise)
                            throw new Error('invalid root');
                        run.workspace = join(state, rootID, 'workspace');
                        checkExercise(run.workspace);
                    }
                    catch {
                        throw new HTTPError(400, '授权练习的文件不可用或已变化，请开始新的练习');
                    }
                    run.exercise = codingExercise;
                }
                else if (parent.workspace !== workspace)
                    throw new HTTPError(400, '当前工作区与这段历史不同，请切回原工作区或开始新任务');
                try {
                    prior = conversationMessages(state, parent);
                }
                catch (error) {
                    throw new HTTPError(400, (error as Error).message);
                }
                Object.assign(run, { parent_run_id: parent.id, conversation_id: parent.conversation_id ?? parent.id, conversation_turn: (parent.conversation_turn ?? 1) + 1 });
            }
            if (exercise)
                run.exercise = codingExercise;
            if (run.exercise) {
                const error = await codingReady();
                if (error)
                    throw new HTTPError(503, error);
            }
            let transport;
            try {
                transport = factory(run.conversation_id ?? run.id);
            }
            catch {
                throw new HTTPError(503, '模型配置不可用，请设置 OPENAI_API_KEY、OPENAI_MODEL，以及可选 OPENAI_BASE_URL');
            }
            if (run.exercise && !parentID)
                run.workspace = prepareExercise(state, run.id);
            run.model = transport.model;
            runs.set(run.id, run);
            history.set(run.id, summarizeRun(run));
            if (runs.size > 8) {
                const oldest = [...runs.values()].filter(item => item.id !== run.id).sort((a, b) => a.created_at - b.created_at)[0];
                if (oldest)
                    runs.delete(oldest.id);
            }
            submitted = true;
            // A run belongs to the server, not the browser connection that submitted it.
            void RunTask(new AbortController().signal, run, transport.call, run.exercise ? codingTools : tools, join(state, run.id), prior)
                .catch(() => { run.status = 'failed'; run.error = { error_type: 'StorageError', message: '本地记录或执行异常' }; })
                .finally(() => { history.set(run.id, summarizeRun(run)); active = false; });
            respond(res, 202, { id: run.id });
        }
        finally {
            if (!submitted)
                active = false;
        }
    }
    const server = createServer({ headersTimeout: 5000, requestTimeout: 10000, keepAliveTimeout: 60000, maxHeaderSize: 16384 }, (req, res) => {
        void handle(req, res).catch(error => { if (!res.headersSent && !res.destroyed)
            respond(res, error instanceof HTTPError ? error.status : 500, { error: error instanceof HTTPError ? error.message : '本地服务处理失败' }); });
    });
    return { server, newRun, runs, history, tools, token, workspace, state, sources, buildID };
}
