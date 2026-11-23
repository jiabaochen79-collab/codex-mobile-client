import type { RpcMessage } from './broker.js';

// Paginated rollout history is durable history, not the running executor's
// transient state. Overlay native events so a running turn cannot appear stopped.
export class LiveState {
  private turns = new Map<string, { turn: any; items: Map<string, any> }>();
  started(threadId: string, turn: any) {
    const previous = this.turns.get(threadId)?.turn;
    if (typeof turn?.id !== 'string' || previous?.id === turn.id) return;
    // Native UUIDv7 IDs retain turn ordering when an extremely fast goal starts
    // its next turn before an older start response is flushed.
    if (/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-/i.test(previous?.id ?? '') && /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-/i.test(turn.id) && previous.id > turn.id) return;
    this.turns.set(threadId, { turn: { ...turn, turnStartedAtMs: (turn.startedAt ?? Date.now() / 1000) * 1000 }, items: new Map() });
    if (this.turns.size > 64) for (const [id, entry] of this.turns) { if (id !== threadId && entry.turn.status !== 'inProgress') this.turns.delete(id); if (this.turns.size <= 64) break; }
  }
  accept(message: RpcMessage) {
    const p = message.params, threadId = p?.threadId;
    if (typeof threadId !== 'string') return;
    if (message.method === 'turn/started' && typeof p.turn?.id === 'string') {
      this.started(threadId, p.turn);
    }
    const current = this.turns.get(threadId);
    if (!current) return;
    if (message.method === 'turn/completed' && p.turn?.id === current.turn.id) current.turn = { ...current.turn, ...p.turn, turnStartedAtMs: current.turn.turnStartedAtMs };
    if (p.turnId !== current.turn.id) return;
    if ((message.method === 'item/started' || message.method === 'item/completed') && typeof p.item?.id === 'string') {
      const { result: _result, aggregatedOutput: _output, contentItems: _content, ...item } = p.item;
      current.items.set(item.id, item);
      if (current.items.size > 1000) current.items.delete(current.items.keys().next().value!);
    }
    const item = current.items.get(p.itemId);
    if (!item) return;
    if ((message.method === 'item/agentMessage/delta' || message.method === 'item/plan/delta') && typeof p.delta === 'string') item.text = (item.text ?? '') + p.delta;
    if (message.method === 'item/reasoning/summaryTextDelta' && Number.isSafeInteger(p.summaryIndex) && p.summaryIndex >= 0 && p.summaryIndex < 100 && typeof p.delta === 'string') { item.summary ??= []; item.summary[p.summaryIndex] = (item.summary[p.summaryIndex] ?? '') + p.delta; }
  }
  read(threadId: string) {
    const current = this.turns.get(threadId);
    return current ? { ...current.turn, items: [...current.items.values()] } : null;
  }
}
