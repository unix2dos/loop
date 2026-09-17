export const conversationID = (run) => run.conversation_id || run.id;
// Keep one sidebar entry per conversation. A saved legacy run is its own root.
export function conversationHeads(items) {
    const heads = new Map();
    for (const item of items) {
        const id = conversationID(item), head = heads.get(id);
        if (!head || (item.conversation_turn ?? 1) > (head.conversation_turn ?? 1))
            heads.set(id, item);
    }
    return [...heads.values()].sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
}
export const traceKey = (runID, eventID) => `${runID}:${eventID}`;
// Concatenate execution time, excluding the time a person waits before replying.
// Keep each original event and its owning run; never rewrite stored IDs or clocks.
export function conversationOverview(runs, now = Date.now() / 1000) {
    let duration = 0, eventCount = 0;
    const turns = runs.map((run, index) => {
        const seconds = Math.max(0, run.status === "running" ? now - run.created_at : run.duration ?? 0, ...run.events.map(event => event.t + event.d));
        const turn = { run, number: run.conversation_turn ?? index + 1, start: duration, duration: seconds, firstStep: eventCount };
        duration += seconds;
        eventCount += run.events.length;
        return turn;
    });
    return { turns, duration, eventCount, events: runs.flatMap(run => run.events), modelRequests: runs.reduce((n, run) => n + run.model_requests, 0), toolCalls: runs.reduce((n, run) => n + run.tool_calls, 0) };
}
