import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import type { ModelCaller, ModelRequest, ModelResponse, ToolCall } from '../src/agent.ts';
import { RunLoop } from '../src/agent.ts';
import { BuildTurnMessages } from '../src/context.ts';
import { conversationMessages } from '../src/conversation.ts';
import { HTTPModel, ModelError, parseMessage } from '../src/model.ts';
import { NewServer } from '../src/server.ts';
import { decodeHistory, readStoredRun, saveRun } from '../src/storage.ts';
import { ExecuteReadonly, ReadFile, ListFiles } from '../src/tools.ts';
import { RunTask } from '../src/trace.ts';
import type { Run } from '../src/storage.ts';
const cases = JSON.parse(readFileSync(new URL('../testdata/loop-cases.json', import.meta.url), 'utf8')) as {
    name: string;
    budget: number;
    responses: ModelResponse[];
    status: string;
    requests: number;
    tools: number;
    tool_errors: number;
    answer: string;
}[];
const signal = () => new AbortController().signal;
function setup(t: test.TestContext) {
    const root = mkdtempSync(join(tmpdir(), 'loop-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const work = join(root, 'work'), state = join(root, 'state');
    mkdirSync(work);
    mkdirSync(state);
    writeFileSync(join(work, 'note.md'), 'ACTUAL_CONTENT_73');
    return { root, work, state };
}
function scripted(responses: ModelResponse[], requests: ModelRequest[]): ModelCaller {
    return async (signal, input) => { signal.throwIfAborted(); requests.push(structuredClone(input)); assert.ok(responses[requests.length - 1], 'unexpected extra model request'); return structuredClone(responses[requests.length - 1]); };
}
const call = (name: string, args: unknown): ToolCall => ({ id: 'tool-1', type: 'function', function: { name, arguments: JSON.stringify(args) } });
for (const sample of cases)
    test(`shared behavior contract: ${sample.name}`, async (t) => {
        const { work, state } = setup(t), app = NewServer(work, state), run = app.newRun('读取 note.md', sample.budget, 'scripted'), requests: ModelRequest[] = [];
        await RunTask(signal(), run, scripted(sample.responses, requests), app.tools, join(state, run.id));
        assert.deepEqual([run.status, run.model_requests, run.tool_calls, run.tool_errors, run.answer], [sample.status, sample.requests, sample.tools, sample.tool_errors, sample.answer]);
        assert.equal(run.task_result, 'not_evaluated');
        assert.deepEqual(readStoredRun(state, run.id), run);
        assert.match(run.source.loop.code, /async function RunLoop/);
        assert.equal(run.source.loop.path, 'src/agent.ts');
        for (const source of Object.values(run.source))
            assert.ok(readFileSync(new URL('../' + source.path, import.meta.url), 'utf8').split('\n').slice(source.line - 1).join('\n').startsWith(source.code));
        if (sample.name === 'batch') {
            const receipts = requests[1].messages.filter(m => m.role === 'tool');
            assert.deepEqual(receipts.map(m => m.tool_call_id), ['list-1', 'read-1']);
            assert.equal(JSON.parse(receipts[1].content).content, 'ACTUAL_CONTENT_73');
        }
    });
test('tool identity, cancellation, and request/tool budgets preserve ordering', async (t) => {
    const { work, state } = setup(t), app = NewServer(work, state);
    const response = structuredClone(cases[0].responses[0]);
    response.choices[0].message.tool_calls![1].id = response.choices[0].message.tool_calls![0].id;
    const run = app.newRun('invalid batch', 1, 'fake');
    await RunTask(signal(), run, scripted([response], []), app.tools, join(state, run.id));
    assert.equal(run.status, 'failed');
    assert.equal(run.tool_calls, 0);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(RunLoop(controller.signal, async () => { assert.fail('model called after cancellation'); }, async () => '', '', [], [], '', 1), { name: 'AbortError' });
    const batch = structuredClone(cases[0].responses[0]);
    batch.choices[0].message.tool_calls = Array.from({ length: 26 }, (_, index) => ({ ...call('list_files', { path: '.' }), id: `call-${index}` }));
    const limited = app.newRun('tool budget', 1, 'fake');
    await RunTask(signal(), limited, scripted([batch], []), app.tools, join(state, limited.id));
    assert.equal(limited.status, 'budget_exhausted');
    assert.equal(limited.tool_calls, 26);
    assert.equal(limited.tool_errors, 2);
});
test('readonly tools reject escapes and invalid parameters, preserve byte offsets', t => {
    const { root, work } = setup(t);
    writeFileSync(join(root, 'outside.md'), 'SECRET');
    symlinkSync(join(root, 'outside.md'), join(work, 'escape.md'));
    writeFileSync(join(work, 'secret.txt'), 'SECRET');
    writeFileSync(join(work, '.hidden.md'), 'SECRET');
    for (const [name, args] of [['read_file', { path: '../outside.md' }], ['read_file', { path: 'escape.md' }], ['read_file', { path: 'secret.txt' }], ['read_file', { path: '.hidden.md' }],
        ['read_file', { path: 'note.md', offset: true }], ['read_file', { path: 'note.md', offset: null }], ['read_file', { path: 'note.md', offset: -1 }],
        ['read_file', { path: 'note.md', extra: 1 }], ['list_files', { path: '.', limit: 101 }], ['write_file', { path: 'note.md', content: 'changed' }], ['shell', { path: '.' }], ['read_file', []]] as [
        string,
        unknown
    ][]) {
        assert.equal(ExecuteReadonly(signal(), work, call(name, args)).error, 'tool_rejected');
    }
    assert.equal(readFileSync(join(work, 'note.md'), 'utf8'), 'ACTUAL_CONTENT_73');
    writeFileSync(join(work, 'large.md'), 'a'.repeat(51202));
    assert.deepEqual(ReadFile(work, 'large.md', 51200), { path: 'large.md', content: 'aa', truncated: false, next_offset: null });
    assert.equal(ReadFile(work, 'large.md', 0).next_offset, 51200);
    writeFileSync(join(work, 'utf8.md'), '中');
    assert.throws(() => ReadFile(work, 'utf8.md', 1));
    assert.ok(!(ListFiles(work, '.', 0, 100).files as string[]).includes('escape.md'));
});
test('context refresh retains actual messages, history rejects malformed ledgers', async (t) => {
    const { work, state } = setup(t), app = NewServer(work, state), run = app.newRun('first', 1, 'fake');
    await RunTask(signal(), run, scripted(cases[0].responses, []), app.tools, join(state, run.id));
    const prior = conversationMessages(state, run), saved = JSON.stringify(prior);
    const next = BuildTurnMessages(prior, 'next', work, 'read only', new Date('2030-05-06T12:00:00Z'));
    assert.equal(next.messages.filter(m => m.role === 'system').length, 1);
    assert.deepEqual(next.messages.slice(1, -1), prior.slice(1));
    assert.equal(JSON.stringify(prior), saved);
    assert.match(next.messages[0].content, /2030-05-06/);
    const ledger = join(state, run.id, 'session.jsonl'), original = readFileSync(ledger);
    for (const invalid of [prior.slice(0, -1), [...prior, { role: 'system', content: 'extra' }], [...prior, { role: 'tool', content: 'orphan', tool_call_id: 'bad' }]]) {
        writeFileSync(ledger, invalid.map(message => JSON.stringify({ type: 'message', message })).join('\n') + '\n');
        assert.throws(() => conversationMessages(state, run));
    }
    writeFileSync(ledger, original);
});
async function listening(t: test.TestContext, app: ReturnType<typeof NewServer>) {
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    t.after(() => new Promise<void>((resolve, reject) => { app.server.close(error => error ? reject(error) : resolve()); app.server.closeAllConnections(); }));
    return `http://127.0.0.1:${(app.server.address() as import('node:net').AddressInfo).port}`;
}
async function finished(base: string, id: string, cookie = ''): Promise<Run> {
    for (let i = 0; i < 500; i++) {
        const run = await (await fetch(`${base}/api/runs/${id}`, { headers: cookie ? { Cookie: cookie } : {} })).json() as Run;
        if (run.status !== 'running')
            return run;
        await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('run did not finish');
}
test('public visitors see only their own runs; daily model quota survives restart and old runs expire', async t => {
    const previous = { public: process.env.LOOP_PUBLIC, daily: process.env.LOOP_PUBLIC_DAILY_REQUESTS };
    process.env.LOOP_PUBLIC = '1';
    process.env.LOOP_PUBLIC_DAILY_REQUESTS = '2';
    t.after(() => {
        if (previous.public === undefined) delete process.env.LOOP_PUBLIC; else process.env.LOOP_PUBLIC = previous.public;
        if (previous.daily === undefined) delete process.env.LOOP_PUBLIC_DAILY_REQUESTS; else process.env.LOOP_PUBLIC_DAILY_REQUESTS = previous.daily;
    });
    const { work, state } = setup(t);
    const factory = () => ({ model: 'fake', call: (async () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] })) as ModelCaller });
    const app = NewServer(work, state, factory), base = await listening(t, app);
    const session = async () => {
        const response = await fetch(base + '/api/config');
        assert.equal(response.status, 200);
        return response.headers.get('set-cookie')!.split(';')[0];
    };
    const a = await session(), b = await session();
    assert.notEqual(a, b);
    const post = (cookie: string, data: unknown) => fetch(base + '/api/runs', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Lab-Token': app.token }, body: JSON.stringify(data) });
    const first = await post(a, { task: 'a' });
    assert.equal(first.status, 202);
    const id = (await first.json()).id as string;
    await finished(base, id, a);
    assert.deepEqual((await (await fetch(base + '/api/runs', { headers: { Cookie: b } })).json() as Run[]).map(run => run.id), []);
    assert.equal((await fetch(base + '/api/runs/' + id, { headers: { Cookie: b } })).status, 404);
    assert.equal((await post(b, { task: 'steal', parent_run_id: id })).status, 404);
    assert.equal((await fetch(base + '/api/runs')).status, 403);
    const second = await post(b, { task: 'b' });
    assert.equal(second.status, 202);
    await finished(base, (await second.json()).id, b);
    assert.equal((await post(a, { task: 'over quota' })).status, 429);
    const stale = readStoredRun(state, id);
    stale.created_at = Date.now() / 1000 - 8 * 86400;
    saveRun(join(state, id, 'run.json'), stale);
    const restarted = NewServer(work, state, factory), next = await listening(t, restarted);
    assert.equal((await fetch(next + '/api/config', { headers: { Cookie: a } })).status, 200);
    assert.equal(existsSync(join(state, id)), false);
    assert.equal((await fetch(next + '/api/runs/' + id, { headers: { Cookie: a } })).status, 404);
    const aHistory = await (await fetch(next + '/api/runs', { headers: { Cookie: a } })).json() as Run[];
    const bHistory = await (await fetch(next + '/api/runs', { headers: { Cookie: b } })).json() as Run[];
    assert.equal(aHistory.length, 0);
    assert.equal(bHistory.length, 1);
    assert.equal((await fetch(next + '/api/runs/' + bHistory[0].id, { headers: { Cookie: a } })).status, 404);
    assert.equal((await fetch(next + '/api/runs', { method: 'POST', headers: { Cookie: a, 'Content-Type': 'application/json', 'X-Lab-Token': restarted.token }, body: JSON.stringify({ task: 'still over quota' }) })).status, 429);
});
test('HTTP lifecycle, isolation, restart, continuation and current-head enforcement', async (t) => {
    const { work, state } = setup(t);
    const requests: ModelRequest[] = [];
    let release!: () => void;
    const wait = new Promise<void>(r => { release = r; });
    let calls = 0;
    const factory = () => ({ model: 'fake', call: (async (_signal, input) => { requests.push(structuredClone(input)); if (++calls === 1) {
            await wait;
            return structuredClone(cases[0].responses[0]);
        } return structuredClone(cases[0].responses[1]); }) as ModelCaller });
    let app = NewServer(work, state, factory), base = await listening(t, app);
    const post = async (data: unknown, headers: Record<string, string> = {}) => fetch(base + '/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lab-Token': app.token, ...headers }, body: JSON.stringify(data) });
    const first = await post({ task: 'first', max_requests: 1 });
    assert.equal(first.status, 202);
    const id = (await first.json()).id;
    assert.equal((await post({ task: 'overlap' })).status, 409);
    release();
    const root = await finished(base, id);
    assert.equal(root.status, 'budget_exhausted');
    const before = readFileSync(join(state, id, 'run.json'));
    const childResponse = await post({ task: 'continue', parent_run_id: id });
    assert.equal(childResponse.status, 202);
    const child = await finished(base, (await childResponse.json()).id);
    assert.equal(child.conversation_turn, 2);
    assert.equal(child.conversation_id, id);
    assert.equal(requests[1].messages.filter(m => m.role === 'tool').length, 2);
    assert.ok(before.equals(readFileSync(join(state, id, 'run.json'))));
    assert.equal((await post({ task: 'old head', parent_run_id: id })).status, 409);
    assert.equal((await post({ task: 'x' }, { 'X-Lab-Token': '' })).status, 403);
    assert.equal((await post({ task: 'x', max_requests: true })).status, 400);
    assert.equal((await post({ task: 'x', extra: 'wrong' })).status, 400);
    assert.equal((await post({ task: 'x'.repeat(4001) })).status, 400);
    assert.equal((await post({ task: 'x' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ task: 'fix', exercise: 'ts-average' })).status, 403);
    assert.equal((await post({ task: 'fix', exercise: 'go-average', approve_exercise: true })).status, 400);
    assert.equal((await fetch(base + '/healthz')).status, 200);
    assert.equal((await fetch(base + '/app.js')).status, 200);
    const crossHostStatus = await new Promise<number>((resolve, reject) => { const req = request(base + '/api/config', { headers: { Host: 'attacker.example:80' } }, res => { res.resume(); resolve(res.statusCode!); }); req.on('error', reject); req.end(); });
    assert.equal(crossHostStatus, 403);
    app = NewServer(work, state, factory);
    base = await listening(t, app);
    assert.equal(app.history.size, 2);
    assert.equal(app.runs.size, 0);
    const thirdResponse = await post({ task: 'after restart', parent_run_id: child.id });
    const third = await finished(base, (await thirdResponse.json()).id);
    assert.equal(third.conversation_turn, 3);
    const freshResponse = await post({ task: 'new' });
    const fresh = await finished(base, (await freshResponse.json()).id);
    assert.equal(fresh.parent_run_id, undefined);
    assert.equal(requests.at(-1)!.messages.length, 2);
    for (let n = 1; n <= 10; n++) {
        const copy = { ...root, id: n.toString(16).padStart(32, '0') };
        mkdirSync(join(state, copy.id));
        saveRun(join(state, copy.id, 'run.json'), copy);
    }
    const reloaded = NewServer(work, state, factory);
    assert.equal(reloaded.history.size, 14);
    const linked = 'f'.repeat(32);
    symlinkSync(join(state, root.id), join(state, linked));
    assert.throws(() => readStoredRun(state, linked));
    const invalid = JSON.parse(before.toString());
    invalid.events[0].t = -1;
    assert.throws(() => decodeHistory(JSON.stringify(invalid), root.id));
});
test('model transport validates wire responses and never leaks provider bodies', async (t) => {
    const previous = { ...process.env };
    t.after(() => { for (const key of ['OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_BASE_URL']) {
        if (previous[key] === undefined)
            delete process.env[key];
        else
            process.env[key] = previous[key];
    } });
    let mode = 'ok', calls = 0;
    const server = createServer(async (req, res) => {
        calls++;
        assert.equal(req.url, '/v1/chat/completions');
        assert.equal(req.headers.authorization, 'Bearer fake-test-key');
        assert.equal(req.headers['user-agent'], 'loop/0.1');
        assert.equal(req.headers['x-opencode-session'], undefined);
        const chunks: Buffer[] = [];
        for await (const c of req)
            chunks.push(c);
        assert.equal(JSON.parse(Buffer.concat(chunks).toString()).model, 'fake');
        if (mode === 'error') {
            res.writeHead(429);
            res.end(JSON.stringify({ type: 'QuotaExceeded', message: 'PRIVATE_PROVIDER_BODY' }));
        }
        else if (mode === 'invalid')
            res.end('{broken');
        else
            res.end(JSON.stringify(cases[0].responses[0]));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
    process.env.OPENAI_API_KEY = 'fake-test-key';
    process.env.OPENAI_MODEL = 'fake';
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`;
    const transport = HTTPModel('session');
    const input = { model: 'fake', messages: [], tools: [] };
    assert.equal((await transport.call(signal(), input)).choices[0].message.tool_calls?.length, 2);
    mode = 'error';
    await assert.rejects(transport.call(signal(), input), (error: unknown) => error instanceof ModelError && error.status === 429 && error.code === 'QuotaExceeded' && !String(error).includes('PRIVATE'));
    mode = 'invalid';
    await assert.rejects(transport.call(signal(), input), { name: 'InvalidResponse' });
    assert.equal(calls, 3);
    assert.throws(() => parseMessage({ role: 'assistant', content: { invalid: true } }));
});
test('model deadline cancels stalled headers and a stalled response body', async (t) => {
    const previous = { ...process.env };
    t.after(() => { for (const key of ['OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_BASE_URL']) {
        if (previous[key] === undefined)
            delete process.env[key];
        else
            process.env[key] = previous[key];
    } });
    let mode = 'headers', requests = 0;
    const server = createServer((req, res) => { requests++; req.resume(); if (mode === 'body') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{');
    } });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
    process.env.OPENAI_API_KEY = 'fake';
    process.env.OPENAI_MODEL = 'fake';
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`;
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, 'timeout', (ms: number) => { assert.equal(ms, 60000); return timeout(80); });
    for (const phase of ['headers', 'body']) {
        mode = phase;
        const start = performance.now();
        await assert.rejects(HTTPModel('deadline').call(signal(), { model: 'fake', messages: [], tools: [] }), { name: 'ConnectionOrTimeoutError' });
        assert.ok(performance.now() - start < 1500, 'deadline must not wait for the peer to finish');
    }
    assert.equal(requests, 2, 'failed calls must not automatically retry');
});
