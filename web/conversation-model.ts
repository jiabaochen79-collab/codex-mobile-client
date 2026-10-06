import type { Message, Snapshot } from '../src/shared/protocol';

export type DisplayTurn = { id: string; status: string; reason?: string; users: Message[]; process: Message[]; results: Message[] };
export type ProcessEntry = { id: string; kind: 'message' | 'commands' | 'images'; messages: Message[] };

export function processEntries(messages: Message[]): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  let previous: ProcessEntry | undefined;
  for (const message of messages) {
    // Finished reasoning is transient, but still separates adjacent command batches.
    if (message.phase === 'reasoning') { previous = undefined; continue; }
    const kind = message.role === 'tool' ? message.images?.length ? 'images' : 'commands' : 'message';
    if (kind !== 'message' && previous?.kind === kind) previous.messages.push(message);
    else { previous = { id: message.id, kind, messages: [message] }; entries.push(previous); }
  }
  return entries;
}

export function conversationTurns(snapshot: Snapshot | null): DisplayTurn[] {
  if (!snapshot) return [];
  const groups: { id: string; status: string; messages: Message[]; legacy: boolean }[] = [];
  for (const message of snapshot.messages) {
    let group = groups.at(-1);
    if (message.turnId) {
      if (!group || group.id !== message.turnId) { group = { id: message.turnId, status: message.turnStatus ?? 'completed', messages: [], legacy: false }; groups.push(group); }
      else if (message.turnStatus && message.turnStatus !== 'inProgress') group.status = message.turnStatus;
    } else if (!group || message.role === 'user' && group.messages.some(m => m.role === 'user')) {
      group = { id: `legacy:${message.id}`, status: 'completed', messages: [], legacy: true }; groups.push(group);
    }
    group!.messages.push(message);
  }
  if (snapshot.lastTurnId && ['failed', 'interrupted'].includes(snapshot.lastTurnStatus ?? '') && !groups.some(group => group.id === snapshot.lastTurnId)) {
    groups.push({ id: snapshot.lastTurnId, status: snapshot.lastTurnStatus!, messages: [], legacy: false });
  }
  return groups.map((group, index) => {
    const status = group.id === snapshot.turnId && snapshot.busy || group.legacy && index === groups.length - 1 && snapshot.busy ? 'inProgress' : group.id === snapshot.lastTurnId && snapshot.lastTurnStatus ? snapshot.lastTurnStatus : group.status;
    let results = group.messages.filter(m => m.role === 'assistant' && m.phase === 'final');
    if (!results.length && status === 'completed') {
      const last = group.messages.findLast(m => m.role === 'assistant' && !m.phase);
      if (last) results = [last];
    }
    const resultIds = new Set(results.map(m => m.id));
    return { id: group.id, status, reason: group.messages.find(m => m.turnReason)?.turnReason ?? (group.id === snapshot.lastTurnId ? snapshot.lastTurnReason : undefined), users: group.messages.filter(m => m.role === 'user'), process: group.messages.filter(m => m.role !== 'user' && !resultIds.has(m.id)), results };
  });
}
