import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTraceGraph, relatedEvents, sameJSON } from '../web/dist/trace-graph.js';

const fixture = JSON.parse(readFileSync(new URL('../testdata/loop-cases.json', import.meta.url), 'utf8'))[0];
const clone = value => structuredClone(value);
const event = (id, kind, turn, input, output, status = 'succeeded') => ({ id, kind, turn, input, output, status, title: kind, t: 0, d: 0, code: 'loop', explanation: '' });
function example() {
  const response = clone(fixture.responses[0].choices[0]);
  const m1 = event('e001', 'model', 1, { messages: [] }, { finish_reason: response.finish_reason, message: response.message });
  const events = [m1];
  const messages = [{ role: 'user', content: '读取笔记' }, response.message];
  for (const [i, call] of response.message.tool_calls.entries()) {
    const result = i ? { error: 'tool_rejected', message: '无法读取' } : { files: ['note.md'], path: '.' };
    const tool = event(`e00${i * 2 + 2}`, 'tool', 1, { arguments: call.function.arguments, tool_call_id: call.id }, result, i ? 'failed' : 'succeeded');
    tool.title = call.function.name;
    events.push(tool, event(`e00${i * 2 + 3}`, 'control', 1, {}, { content: JSON.stringify(result), tool_call_id: call.id }));
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
  }
  events.push(event('e006', 'model', 2, { messages }, { finish_reason: 'stop', message: { role: 'assistant', content: '证据不足' } }));
  return { id: 'test-run', events, status: 'completed' };
}
let passed = 0;
function check(name, run) { run(); passed++; console.log('PASS ' + name); }
check('同一响应的两个调用分别配对，错误回执也进入下一次请求', () => {
  const graph = buildTraceGraph(example());
  assert.equal(graph.steps.length, 2);
  assert.deepEqual(graph.steps[0].calls.map(c => [c.tool.id, c.receipt.id, c.nextModel.id, c.messageIndex]), [['e002', 'e003', 'e006', 2], ['e004', 'e005', 'e006', 3]]);
  assert.equal(graph.unlinkedTools.length, 0);
  assert.deepEqual([...relatedEvents(graph, 'e004')].sort(), ['e001', 'e004', 'e005', 'e006']);
});
check('预算结束时不凭空补出下一次模型请求', () => {
  const run = example(); run.events.pop(); run.status = 'budget_exhausted';
  for (const c of buildTraceGraph(run).steps[0].calls) { assert.ok(c.receipt); assert.equal(c.nextModel, undefined); }
});
check('输入消息必须是实际 tool 回执且内容匹配', () => {
  const run = example(); run.events.at(-1).input.messages[2].role = 'user';
  run.events.at(-1).input.messages[3].content = '{"error":"different"}';
  assert.ok(buildTraceGraph(run).steps[0].calls.every(c => !c.nextModel));
});
check('消息中没有对应的 assistant 批次时不画反馈连线', () => {
  const run = example(); run.events.at(-1).input.messages[1] = { role: 'assistant', tool_calls: [] };
  assert.ok(buildTraceGraph(run).steps[0].calls.every(c => !c.nextModel));
});
check('不能把不匹配的工具输出当成已交回的回执', () => {
  const run = example(); run.events[2].output.content = '{"files":[]}';
  const c = buildTraceGraph(run).steps[0].calls[0]; assert.ok(c.tool); assert.equal(c.receipt, undefined); assert.equal(c.nextModel, undefined);
});
check('同批重复调用 ID 不做猜测性关联', () => {
  const run = example(); run.events[0].output.message.tool_calls[1].id = 'list-1';
  assert.ok(buildTraceGraph(run).steps[0].calls.every(c => !c.tool));
});
check('跨批重复调用 ID 按模型响应归属隔离', () => {
  const run = example();
  const next = run.events.at(-1), call = clone(run.events[0].output.message.tool_calls[0]);
  next.output = { finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [call] } };
  const result = { files: ['other.md'] };
  const tool = event('e007', 'tool', 2, { tool_call_id: call.id, arguments: call.function.arguments }, result); tool.title = 'list_files';
  run.events.push(tool, event('e008', 'control', 2, {}, { tool_call_id: call.id, content: JSON.stringify(result) }));
  run.events.push(event('e009', 'model', 3, { messages: [...clone(next.input.messages), clone(next.output.message), { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) }] }, { finish_reason: 'stop' }));
  const graph = buildTraceGraph(run);
  assert.equal(graph.steps[0].calls[0].tool.id, 'e002');
  assert.equal(graph.steps[1].calls[0].tool.id, 'e007');
  assert.equal(graph.steps[1].calls[0].nextModel.id, 'e009');
});
check('尚未返回的工具没有结果或反馈连线', () => {
  const run = example(); run.events = run.events.slice(0, 2); run.status = 'running'; run.events[1].status = 'running'; run.events[1].output = null;
  const calls = buildTraceGraph(run).steps[0].calls;
  assert.ok(calls[0].tool); assert.equal(calls[0].receipt, undefined); assert.equal(calls[1].tool, undefined);
});
check('截断或无执行记录的响应只显示提出的调用', () => {
  const run = example(); run.events = run.events.slice(0, 1); run.events[0].output.finish_reason = 'length'; run.status = 'failed';
  assert.ok(buildTraceGraph(run).steps[0].calls.every(c => !c.tool && !c.receipt && !c.nextModel));
});
check('匹配 JSON 不依赖键顺序，但不能混淆类型', () => {
  assert.ok(sameJSON({ a: 1, b: [2] }, { b: [2], a: 1 }));
  assert.ok(!sameJSON({ a: 1 }, { a: '1' }));
});
console.log(`${passed} trace relationship checks passed`);
