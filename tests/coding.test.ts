import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { codingExercise, codingReady, dockerCommand, ExecuteCoding, ExecutionError, exerciseContainerArgs, prepareExercise, RunExerciseTests, WriteExerciseFile } from '../src/coding.ts';
import { fileHash, randomID, readStoredRun } from '../src/storage.ts';
import { NewServer } from '../src/server.ts';
import type { ModelRequest } from '../src/agent.ts';
import type { Run } from '../src/storage.ts';
const signal = () => new AbortController().signal;
const fixed = 'export function average(values: number[] | null): number { return !values?.length ? 0 : Math.trunc(values.reduce((a, b) => a + b, 0) / values.length); }\n';
function setup(t: test.TestContext) { const state = mkdtempSync(join(tmpdir(), 'loop-coding-')); t.after(() => rmSync(state, { recursive: true, force: true })); return { state, workspace: prepareExercise(state, randomID()) }; }
test('coding file boundaries and fingerprint-checked atomic writes', async (t) => {
    const { workspace } = setup(t), path = join(workspace, 'average.ts');
    const call = (name: string, args: unknown) => ExecuteCoding(signal(), workspace, { id: 'test', type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const before = await call('read_file', { path: 'average.ts' });
    const changed = before.content + '\n// edit after reading\n';
    writeFileSync(path, changed);
    assert.equal((await call('write_file', { path: 'average.ts', content: fixed, expected_sha256: before.sha256 })).error, 'file_changed');
    assert.equal(readFileSync(path, 'utf8'), changed);
    const fresh = await call('read_file', { path: 'average.ts' });
    const result = await call('write_file', { path: 'average.ts', content: fixed, expected_sha256: fresh.sha256 });
    assert.equal(result.before, changed);
    assert.equal(result.after, fixed);
    assert.equal(result.sha256, fileHash(fixed));
    assert.match(String(result.diff), /\+export function average/);
    for (const [name, args] of [['read_file', { path: '../average.ts' }], ['read_file', { path: 'average.ts', offset: 0 }], ['write_file', { path: 'average.test.ts', content: fixed, expected_sha256: fresh.sha256 }],
        ['run_command', { command: 'node --test average.test.ts; touch /tmp/escaped' }], ['run_command', { command: 'node --test average.test.ts', cwd: '/' }], ['write_file', { path: 'average.ts', content: '\ud800', expected_sha256: result.sha256 }]] as [
        string,
        unknown
    ][])
        assert.equal((await call(name, args)).error, 'tool_rejected');
    rmSync(path);
    symlinkSync(join(workspace, 'average.test.ts'), path);
    assert.equal((await call('read_file', { path: 'average.ts' })).error, 'tool_rejected');
    assert.throws(() => exerciseContainerArgs('/tmp/path,with-comma', 'name'));
});
test('real Docker: failure, checked fix, isolation, bounded output and cancellation cleanup', { skip: process.env.LOOP_TEST_DOCKER !== '1', timeout: 60000 }, async (t) => {
    assert.equal(await codingReady(), '');
    const { workspace } = setup(t);
    const oldKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'TEST_KEY_MUST_NOT_ENTER_CONTAINER';
    t.after(() => { if (oldKey === undefined)
        delete process.env.OPENAI_API_KEY;
    else
        process.env.OPENAI_API_KEY = oldKey; });
    const removed = async (result: Record<string, unknown>) => { assert.equal(result.cleanup_confirmed, true); assert.notEqual((await dockerCommand(['inspect', String(result.container_id)], AbortSignal.timeout(5000))).code, 0); };
    const failed = await RunExerciseTests(signal(), workspace);
    assert.equal(failed.error, 'command_failed');
    assert.notEqual(failed.exit_code, 0);
    await removed(failed);
    const path = join(workspace, 'average.ts'), before = readFileSync(path);
    assert.equal(WriteExerciseFile(workspace, 'average.ts', fixed, fileHash(before)).changed, true);
    const passed = await RunExerciseTests(signal(), workspace);
    assert.equal(passed.exit_code, 0);
    assert.equal(passed.tested_sha256, fileHash(fixed));
    await removed(passed);
    const isolation = `import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
assert.notEqual(process.getuid!(), 0);
assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.equal(fs.existsSync('/var/run/docker.sock'), false);
for (const path of ['/loop-escape', '/workspace/average.ts']) assert.throws(() => fs.writeFileSync(path, 'escape'));
await new Promise<void>((resolve, reject) => { const socket = net.createConnection({host:'1.1.1.1',port:443}); socket.setTimeout(1000); socket.on('connect',()=>{socket.destroy();reject(new Error('outbound network available'));}); socket.on('error',()=>resolve()); socket.on('timeout',()=>{socket.destroy();resolve();}); });
process.stdout.write('x'.repeat(70000));
${fixed}`;
    writeFileSync(path, isolation);
    const isolated = await RunExerciseTests(signal(), workspace);
    assert.equal(isolated.exit_code, 0);
    assert.equal(isolated.output_truncated, true);
    assert.ok(Buffer.byteLength(String(isolated.stdout)) <= 65536);
    await removed(isolated);
    writeFileSync(path, `await new Promise(() => { setInterval(() => {}, 1000); });\n${fixed}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    t.after(() => clearTimeout(timer));
    try {
        await RunExerciseTests(controller.signal, workspace);
        assert.fail('cancellation should stop execution');
    }
    catch (error) {
        assert.ok(error instanceof ExecutionError);
        assert.equal(error.result.exit_code, null);
        assert.equal(error.result.error, 'command_canceled');
        await removed(error.result);
    }
});
test('coding HTTP approval, normal tool isolation and continuation after restart', { skip: process.env.LOOP_TEST_DOCKER !== '1' }, async (t) => {
    const { state, workspace } = setup(t);
    const requests: ModelRequest[] = [];
    const factory = () => ({ model: 'fake', call: async (_signal: AbortSignal, input: ModelRequest) => { requests.push(structuredClone(input)); return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] }; } });
    const app = NewServer(workspace, state, factory);
    const beforeTools = JSON.stringify(app.tools);
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    t.after(() => new Promise<void>(resolve => { app.server.close(() => resolve()); app.server.closeAllConnections(); }));
    const base = `http://127.0.0.1:${(app.server.address() as import('node:net').AddressInfo).port}`;
    const post = async (data: unknown) => fetch(base + '/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lab-Token': app.token }, body: JSON.stringify(data) });
    const finish = async (response: Response): Promise<Run> => { assert.equal(response.status, 202); const { id } = await response.json(); for (let i = 0; i < 300; i++) {
        const run = app.runs.get(id)!;
        if (run.status !== 'running')
            return readStoredRun(state, id);
        await new Promise(r => setTimeout(r, 10));
    } throw new Error('stuck run'); };
    assert.equal((await post({ task: 'fix', exercise: codingExercise })).status, 403);
    const root = await finish(await post({ task: 'fix', exercise: codingExercise, approve_exercise: true }));
    assert.equal(JSON.stringify(app.tools), beforeTools);
    assert.equal(requests[0].tools.length, 4);
    const original = readFileSync(join(state, root.id, 'run.json'));
    const oldPublic = process.env.LOOP_PUBLIC;
    process.env.LOOP_PUBLIC = '1';
    try {
        assert.equal((await post({ task: 'continue', parent_run_id: root.id })).status, 403);
        assert.equal((await post({ task: 'fix', exercise: codingExercise, approve_exercise: true })).status, 403);
    }
    finally {
        if (oldPublic === undefined)
            delete process.env.LOOP_PUBLIC;
        else
            process.env.LOOP_PUBLIC = oldPublic;
    }
    const child = await finish(await post({ task: 'continue', parent_run_id: root.id }));
    assert.equal(child.workspace, root.workspace);
    assert.equal(child.exercise, codingExercise);
    assert.equal(child.parent_run_id, root.id);
    assert.equal(requests[1].tools.length, 4);
    assert.ok(original.equals(readFileSync(join(state, root.id, 'run.json'))));
});
test('fixed model responses drive a complete test, read, edit, retest loop', { skip: process.env.LOOP_TEST_DOCKER !== '1', timeout: 30000 }, async (t) => {
    const { state, workspace } = setup(t), { RunTask } = await import('../src/trace.ts');
    const app = NewServer(workspace, state), run = app.newRun('固定响应验收：修复 TypeScript 平均值', 4, 'scripted-validation');
    run.exercise = codingExercise;
    const definitions = JSON.parse(readFileSync(new URL('../coding-tools.json', import.meta.url), 'utf8'));
    let round = 0;
    const model = async (_signal: AbortSignal, input: ModelRequest) => {
        round++;
        const tool = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
        let calls;
        if (round === 1)
            calls = [tool('test-before', 'run_command', { command: 'node --test average.test.ts' }), tool('read-source', 'read_file', { path: 'average.ts' })];
        else if (round === 2) {
            const receipts = input.messages.filter(m => m.role === 'tool');
            assert.equal(JSON.parse(receipts[0].content).error, 'command_failed');
            const read = JSON.parse(receipts[1].content);
            calls = [tool('write-fix', 'write_file', { path: 'average.ts', content: fixed, expected_sha256: read.sha256 })];
        }
        else if (round === 3)
            calls = [tool('test-after', 'run_command', { command: 'node --test average.test.ts' })];
        else {
            const result = JSON.parse(input.messages.at(-1)!.content);
            assert.equal(result.exit_code, 0);
            assert.equal(result.cleanup_confirmed, true);
            return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '固定响应验收完成：实际修改后测试通过。' } }] };
        }
        return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: calls } }] };
    };
    await RunTask(signal(), run, model, definitions, join(state, run.id));
    assert.equal(run.status, 'completed');
    assert.equal(run.model_requests, 4);
    assert.equal(run.tool_calls, 4);
    assert.equal(run.tool_errors, 1);
    assert.equal(readFileSync(join(workspace, 'average.ts'), 'utf8'), fixed);
    assert.ok(run.events.some(event => event.code === 'write' && event.output?.changed === true));
    assert.equal(run.events.filter(event => event.title === 'run_command' && event.output?.cleanup_confirmed === true).length, 2);
    assert.deepEqual(readStoredRun(state, run.id), run);
});
