import type { Message, Snapshot } from '../src/shared/protocol';

export type DisplayTurn = { id: string; status: string; users: Message[]; process: Message[]; results: Message[] };
export function conversationTurns(snapshot: Snapshot | null): DisplayTurn[] {
  if (!snapshot) return [];
  const groups: { id: string; status: string; messages: Message[]; legacy: boolean }[] = [];
  for (const message of snapshot.messages) {
    let group = groups.at(-1);
    if (message.turnId) {
      if (!group || group.id !== message.turnId) { group = { id: message.turnId, status: message.turnStatus ?? 'completed', messages: [], legacy: false }; groups.push(group); }
    } else if (!group || message.role === 'user' && group.messages.some(m => m.role === 'user')) {
      group = { id: `legacy:${message.id}`, status: 'completed', messages: [], legacy: true }; groups.push(group);
    }
    group!.messages.push(message);
  }
  return groups.map((group, index) => {
    const status = group.id === snapshot.turnId && snapshot.busy || group.legacy && index === groups.length - 1 && snapshot.busy ? 'inProgress' : group.status;
    let results = group.messages.filter(m => m.role === 'assistant' && m.phase === 'final');
    if (!results.length && status === 'completed') {
      const last = group.messages.findLast(m => m.role === 'assistant' && !m.phase);
      if (last) results = [last];
    }
    const resultIds = new Set(results.map(m => m.id));
    return { id: group.id, status, users: group.messages.filter(m => m.role === 'user'), process: group.messages.filter(m => m.role !== 'user' && !resultIds.has(m.id)), results };
  });
}
