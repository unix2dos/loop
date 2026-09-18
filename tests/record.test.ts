import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonOffset, locateRecord } from '../src/record.ts';
import { NewServer } from '../src/server.ts';
import { saveRun } from '../src/storage.ts';
test('record locations follow original JSON structure, escaped pointers and live ledger', t => {
    const raw = '{\n  "other": {"id":"e002"},\n  "events": [\n    {"id":"e001","input":"中文\\n e002"},\n    {"id":"e002",\n     "input": {"a/b~c": [null,\n       {"role":"tool"}]}}\n  ]\n}';
    for (const [path, line, starts] of [[['events', '1'], 5, '{"id":"e002"'], [['events', '1', 'input', 'a/b~c', '1'], 7, '{"role":"tool"}'], [['events', '0', 'input'], 4, '"中文\\n e002"']] as [
        string[],
        number,
        string
    ][]) {
        const offset = jsonOffset(raw, path);
        assert.equal(raw.slice(0, offset).split('\n').length, line);
        assert.ok(raw.slice(offset).startsWith(starts));
    }
    assert.throws(() => jsonOffset(raw, ['events', '9']));
    const compact = JSON.stringify(JSON.parse(raw));
    assert.equal(compact.slice(0, jsonOffset(compact, ['events', '1'])).split('\n').length, 1);
    const state = mkdtempSync(join(tmpdir(), 'loop-record-'));
    t.after(() => rmSync(state, { recursive: true, force: true }));
    const app = NewServer(state, state), run = app.newRun('record', 1, 'fake');
    run.status = 'completed';
    run.events = [{ id: 'e001', kind: 'model', title: 'model', turn: 1, t: 0, d: 0, status: 'succeeded', input: { 'a/b~c': [null, 'TARGET_FIELD'] }, output: {}, code: 'loop', explanation: '' }];
    const folder = join(state, run.id);
    mkdirSync(folder);
    const path = join(folder, 'run.json');
    saveRun(path, run);
    const before = readFileSync(path, 'utf8'), location = locateRecord(state, run.id, 'e001', '/input/a~1b~0c/1');
    assert.match(before.split('\n')[location.line - 1], /TARGET_FIELD/);
    assert.equal(location.path, path);
    for (const [id, event, field] of [['../escape', 'e001', ''], [run.id, 'e999', ''], [run.id, 'e001', '/input/missing'], [run.id, 'e001', '/inputs'], [run.id, 'e001', '/../../file']])
        assert.throws(() => locateRecord(state, id, event, field));
    assert.equal(readFileSync(path, 'utf8'), before);
    rmSync(path);
    symlinkSync(join(state, 'outside.json'), path);
    assert.throws(() => locateRecord(state, run.id, 'e001', ''));
    rmSync(path);
    writeFileSync(join(folder, 'trace.jsonl'), '{"phase":"start","id":"e002","input":{}}\n{"phase":"finish","id":"e002","output":{"content":"result"}}\n{"phase":"start","id":"e003","input":{}}\n{"phase":"finish","id":"e002"');
    for (const [event, field, line] of [['e002', '', 2], ['e002', '/input', 1], ['e002', '/output/content', 2], ['e003', '', 3]] as [
        string,
        string,
        number
    ][])
        assert.equal(locateRecord(state, run.id, event, field).line, line);
});
