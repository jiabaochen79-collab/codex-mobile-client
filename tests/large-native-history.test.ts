import { expect, it, vi } from 'vitest';
import { CodexDesktop, normalizeSnapshot } from '../src/agent/desktop.js';
import { NativeIpc } from '../src/agent/ipc.js';

function frame(message: unknown) {
  const bytes = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length);
  return Buffer.concat([header, bytes]);
}
const envelope = (conversationState: any) => ({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'owner', params: { hostId: 'local', conversationId: 'task', change: { type: 'snapshot', conversationState, revision: 1 } } });

it.each(['turns', 'history'])('reads a large %s snapshot without retaining unused tool results or losing visible content', layout => {
  const turn = { turnId: 'turn', status: 'completed', items: [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Question' }, { type: 'image', url: 'data:image/png;base64,aGVsbG8=' }] },
    { id: 'tool', type: 'mcpToolCall', tool: 'inspect', arguments: { result: 'keep argument' }, status: 'completed', result: { content: [{ type: 'text', text: 'x'.repeat(65 * 1024 * 1024) }], _meta: { screenshot: 'private tool preview' } } },
    { id: 'answer', type: 'agentMessage', text: 'Visible conclusion', phase: 'final', questions: [{ title: 'Choose?', options: ['A'] }] }
  ] };
  const state = { id: 'task', requests: [{ id: 'approval', method: 'item/commandExecution/requestApproval', params: { command: 'fixture', result: 'keep request' } }], ...(layout === 'turns' ? { turns: [turn] } : { turnHistory: { history: { entitiesByKey: { 'tail:6:local:turn': turn } } } }) };
  const bytes = frame(envelope(state)), ipc = new NativeIpc(), received = vi.fn();
  ipc.on('broadcast', received);
  try {
    for (let at = 0; at < bytes.length; at += 16381) (ipc as any).read(bytes.subarray(at, at + 16381));
    expect(received).toHaveBeenCalledOnce();
    const parsed = received.mock.calls[0][0].params.change.conversationState;
    const items = (parsed.turns?.[0] ?? parsed.turnHistory.history.entitiesByKey['tail:6:local:turn']).items;
    expect(items[1].result).toBeUndefined();
    expect(items[1].arguments).toEqual({ result: 'keep argument' });
    expect(items[0].content).toEqual(turn.items[0].content);
    expect(parsed.requests).toEqual(state.requests);
    const snapshot = normalizeSnapshot(parsed, 'epoch', 20);
    expect(snapshot.messages.at(-1)?.text).toBe('Visible conclusion');
    expect(snapshot.requests.map(r => r.kind)).toEqual(['command', 'input']);
  } finally { ipc.close(); }
});

it.each(['turns', 'history'])('applies status and text patches after %s tool output was omitted', layout => {
  const desktop = new CodexDesktop('unused'), state = desktop as any;
  const turn = { turnId: 'turn', items: [{ id: 'tool', type: 'mcpToolCall', status: 'inProgress' }, { id: 'answer', type: 'agentMessage', text: 'Before' }] };
  const conversation = { id: 'task', ...(layout === 'turns' ? { turns: [turn] } : { turnHistory: { history: { entitiesByKey: { 'tail:6:local:turn': turn } } } }) };
  const prefix = layout === 'turns' ? ['turns', 0, 'items'] : ['turnHistory', 'history', 'entitiesByKey', 'tail:6:local:turn', 'items'];
  const followed = { id: 'task', owner: 'owner', state: conversation, revision: 1 };
  state.followed.set('task', followed);
  const resnapshot = vi.spyOn(state, 'requestSnapshot').mockImplementation(() => {});
  try {
    state.onBroadcast({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'owner', params: { hostId: 'local', conversationId: 'task', change: { type: 'patches', baseRevision: 1, revision: 2, patches: [
      { op: 'replace', path: [...prefix, 0, 'result', 'content', 0, 'text'], value: 'unused result update' },
      { op: 'replace', path: [...prefix, 0, 'status'], value: 'completed' },
      { op: 'replace', path: [...prefix, 1, 'text'], value: 'After' }
    ] } } });
    expect(resnapshot).not.toHaveBeenCalled();
    expect(followed.revision).toBe(2);
    expect(normalizeSnapshot(followed.state, 'epoch').messages.map(m => [m.text, m.status])).toEqual([['mcpToolCall', 'completed'], ['After', undefined]]);
  } finally { desktop.close(); vi.restoreAllMocks(); }
});

it('advances revisions for discarded output while still rejecting unsafe patch paths', () => {
  const desktop = new CodexDesktop('unused'), state = desktop as any;
  const followed = { id: 'task', owner: 'owner', state: { id: 'task', turns: [{ items: [{ id: 'tool' }] }] }, revision: 1 };
  state.followed.set('task', followed);
  const resnapshot = vi.spyOn(state, 'requestSnapshot').mockImplementation(() => {});
  const broadcast = (baseRevision: number, patches: any[]) => state.onBroadcast({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'owner', params: { hostId: 'local', conversationId: 'task', change: { type: 'patches', baseRevision, revision: baseRevision + 1, patches } } });
  try {
    broadcast(1, [{ op: 'replace', path: ['turns', 0, 'items', 0, 'result', 'content', 0, 'text'], value: 'unused' }]);
    expect(followed.revision).toBe(2);
    expect(resnapshot).not.toHaveBeenCalled();
    broadcast(2, [{ op: 'replace', path: ['turns', 0, 'items', 0, 'result', '__proto__', 'polluted'], value: true }]);
    expect(resnapshot).toHaveBeenCalledOnce();
    expect(followed.revision).toBe(2);
    expect(({} as any).polluted).toBeUndefined();
  } finally { desktop.close(); vi.restoreAllMocks(); }
});
