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
