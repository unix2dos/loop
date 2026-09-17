import {conversationHeads, conversationID, conversationOverview, traceKey} from "../web/dist/conversation.js";
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTraceGraph, relatedEvents, sameJSON, tokenUsage, runUsage, formatDuration, executionSections, timelineLayout } from '../web/dist/trace-graph.js';

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
check('对话侧栏合并连续轮次，旧运行保持独立', () => {
 const root={id:'root',created_at:1}, next={id:'next',conversation_id:'root',parent_run_id:'root',conversation_turn:2,created_at:2}, old={id:'legacy',created_at:0};
 assert.deepEqual(conversationHeads([next,root,old]).map(x=>x.id),['next','legacy']);
 assert.equal(conversationID(old),'legacy');
 assert.deepEqual(conversationHeads([root,next]).map(x=>x.id),['next']);
});
check('整段对话保留重复事件 ID 的归属，用量与执行时间跨轮累计', () => {
 const first={...example(),id:'first',created_at:100,duration:2,model_requests:2,tool_calls:2};
 const second={...example(),id:'second',conversation_turn:2,created_at:900,duration:3,model_requests:2,tool_calls:2};
 first.events[0].output.usage={total_tokens:10};second.events[0].output.usage={total_tokens:20};
 const before=JSON.stringify([first,second]);const overview=conversationOverview([first,second],903);
 assert.equal(overview.duration,5);assert.equal(overview.modelRequests,4);assert.equal(overview.toolCalls,4);
 assert.equal(overview.eventCount,12);assert.equal(overview.events.length,12);assert.equal(runUsage(overview).total.total,30);
 assert.deepEqual(overview.turns.map(t=>[t.number,t.start,t.firstStep]),[[1,0,0],[2,2,6]]);
 assert.notEqual(traceKey('first','e001'),traceKey('second','e001'));
 assert.equal(JSON.stringify([first,second]),before);
 second.status='running';assert.equal(conversationOverview([first,second],904).duration,6);
});
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
check('累计 token 使用真实值，缓存不重复计入合计', () => {
 const run = example();
 run.events[0].output.usage = {prompt_tokens:497,completion_tokens:83,total_tokens:580,prompt_tokens_details:{cached_tokens:0}};
 run.events.at(-1).output.usage = {prompt_tokens:1470,completion_tokens:430,total_tokens:1900,prompt_tokens_details:{cached_tokens:512}};
 const result=runUsage(run);
 assert.equal(result.input.total,1967); assert.equal(result.output.total,513);
 assert.equal(result.total.total,2480); assert.equal(result.cached.total,512); assert.equal(result.total.count,2);
});
check('未返回或非法 token 不当成零，部分统计保留覆盖数', () => {
 const run=example();
 run.events[0].output.usage={prompt_tokens:null,completion_tokens:-1,total_tokens:'580'};
 assert.equal(tokenUsage(run.events[0]).total,undefined);
 assert.equal(tokenUsage({output:{usage:{total_tokens:.5}}}).total,undefined);
 assert.equal(runUsage(run).total.total,undefined);
 run.events.at(-1).output.usage={total_tokens:0};
 const result=runUsage(run); assert.equal(result.total.total,0); assert.equal(result.total.count,1); assert.equal(result.models,2);
});
check('短工具耗时显示为毫秒',()=>{assert.equal(formatDuration(.0043),'4.3 ms');assert.equal(formatDuration(1.61),'1.61 s')});
check('全程分组覆盖每一条真实事件，顺序不变',()=>{
 const run=example();
 run.events.unshift(event('input','input',0,{task:'test'},{}),event('prepare','control',0,{},{}));
 run.events.push(event('end','control',2,{}, {run_status:'completed'}));
 const groups=executionSections(run);
 assert.deepEqual(groups.map(g=>g.kind),['start','request','request','end']);
 assert.deepEqual(groups.flatMap(g=>g.events.map(e=>e.id)),run.events.map(e=>e.id));
 assert.equal(new Set(groups.flatMap(g=>g.events.map(e=>e.id))).size,run.events.length);
});
check('预算结束保留准备、程序处理、工具、回执和终点',()=>{
 const run=example();run.events.pop();run.status='budget_exhausted';
 run.events.unshift(event('input','input',0,{},{}),event('prepare','control',0,{},{}));
 run.events.splice(3,0,event('dispatch','control',1,{tool_call_id:'list-1'},{executor:'ExecuteReadonly'}));
 run.events.push(event('end','control',1,{}, {run_status:'budget_exhausted'}));
 const groups=executionSections(run);
 assert.equal(groups.filter(g=>g.kind==='request').length,1);
 assert.ok(groups.flatMap(g=>g.events).some(e=>e.id==='dispatch'));
 assert.equal(groups.at(-1).anchor.output.run_status,'budget_exhausted');
});
check('步骤和耗时概览都覆盖完整事件，运行中不补未来步骤',()=>{
 const run=example();run.events.forEach((e,i)=>{e.t=i*.2;e.d=.1});run.duration=1.2;
 for(const mode of ['steps','time']){
  const layout=timelineLayout(run,mode);
  assert.deepEqual(layout.bars.map(b=>b.event.id),run.events.map(e=>e.id));
  assert.ok(layout.bars.every(b=>b.left>=0&&b.width>=0&&b.left+b.width<=1.000001));
 }
 run.events=run.events.slice(0,1);run.events[0].status='running';run.status='running';
 assert.equal(timelineLayout(run,'time',2).bars.length,1);
 assert.equal(executionSections({events:[]}).length,0);
});
console.log(`${passed} trace and usage checks passed`);
