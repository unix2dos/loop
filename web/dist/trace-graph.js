export const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const array = (value) => Array.isArray(value) ? value : [];
// Compare recorded JSON values without relying on object-key order.
export function sameJSON(left, right) {
    if (left === right)
        return true;
    if (Array.isArray(left) || Array.isArray(right))
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((v, i) => sameJSON(v, right[i]));
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
        return false;
    const a = object(left), b = object(right), keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameJSON(a[key], b[key]));
}
export function parseJSON(value) {
    if (typeof value !== "string")
        return undefined;
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
export function buildTraceGraph(run) {
    const models = run.events.map((event, index) => ({ event, index })).filter(item => item.event.kind === "model");
    const linked = new Set();
    const steps = models.map(({ event: model, index }, position) => {
        const next = models[position + 1];
        const batch = run.events.slice(index + 1, next?.index ?? run.events.length);
        const proposed = array(object(model.output?.message).tool_calls);
        const messages = array(next?.event.input.messages).map(object);
        let assistantIndex = -1;
        messages.forEach((message, i) => { if (message.role === "assistant")
            assistantIndex = i; });
        // Scope IDs to the originating model batch. IDs can recur in later responses.
        const echoedBatch = assistantIndex >= 0 && sameJSON(messages[assistantIndex].tool_calls, proposed);
        // ponytail: per-call scans suit short teaching traces; index each batch by ID if large batches become common.
        const calls = proposed.map((raw, callIndex) => {
            const call = object(raw), fn = object(call.function);
            const link = { id: typeof call.id === "string" ? call.id : "", name: typeof fn.name === "string" ? fn.name : "未知工具", arguments: fn.arguments, callIndex };
            if (!link.id || proposed.filter(value => object(value).id === link.id).length !== 1)
                return link;
            const matches = batch.filter(event => event.kind === "tool" && event.input.tool_call_id === link.id && event.title === link.name && sameJSON(parseJSON(event.input.arguments), parseJSON(link.arguments)) && parseJSON(link.arguments) !== undefined);
            if (matches.length !== 1)
                return link;
            link.tool = matches[0];
            linked.add(link.tool.id);
            if (link.tool.output === null || link.tool.status === "running")
                return link;
            const receipts = batch.filter(event => event.kind === "control" && event.output?.tool_call_id === link.id && typeof event.output.content === "string" && sameJSON(parseJSON(event.output.content), link.tool?.output));
            if (receipts.length !== 1)
                return link;
            link.receipt = receipts[0];
            if (!next || !echoedBatch)
                return link;
            const forwarded = messages.map((message, messageIndex) => ({ message, messageIndex })).filter(({ message, messageIndex }) => messageIndex > assistantIndex && message.role === "tool" && message.tool_call_id === link.id && sameJSON(parseJSON(message.content), link.tool?.output));
            if (forwarded.length === 1) {
                link.nextModel = next.event;
                link.messageIndex = forwarded[0].messageIndex;
            }
            return link;
        });
        return { model, calls };
    });
    return { steps, unlinkedTools: run.events.filter(event => event.kind === "tool" && !linked.has(event.id)) };
}
export function relatedEvents(graph, selected) {
    const related = new Set();
    for (const step of graph.steps)
        for (const call of step.calls) {
            const ids = [step.model.id, call.tool?.id, call.receipt?.id, call.nextModel?.id].filter((id) => Boolean(id));
            if (selected !== null && ids.includes(selected))
                ids.forEach(id => related.add(id));
        }
    return related;
}
const tokenNumber = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
export function tokenUsage(event) {
    const usage = object(event.output?.usage);
    return { input: tokenNumber(usage.prompt_tokens), output: tokenNumber(usage.completion_tokens), total: tokenNumber(usage.total_tokens), cached: tokenNumber(object(usage.prompt_tokens_details).cached_tokens) };
}
export function runUsage(run) {
    const values = run.events.filter(event => event.kind === "model").map(tokenUsage);
    const sum = (field) => {
        const known = values.map(value => value[field]).filter((n) => n !== undefined);
        return { total: known.length ? known.reduce((total, value) => total + value, 0) : undefined, count: known.length };
    };
    return { models: values.length, input: sum("input"), output: sum("output"), total: sum("total"), cached: sum("cached") };
}
export function formatDuration(seconds) {
    return seconds < 1 ? (seconds * 1000).toFixed(1) + " ms" : seconds.toFixed(2) + " s";
}
