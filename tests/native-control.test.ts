import { describe, it, expect, vi } from 'vitest';
import { NativeSession } from '../src/agent/native-session.js';
import { nativeControl } from '../src/agent/native-control.js';
import type { Snapshot, Command } from '../src/shared/protocol.js';
const snapshot = { id: 'thread', epoch: 'epoch', busy: true, turnId: 'turn-a', requests: [], messages: [], settings: { model: 'model', effort: 'high', revision: 'revision', mode: 'default' } } as unknown as Snapshot;
function fixture() { const request = vi.fn(async (method: string) => method === 'turn/steer' ? { turnId: 'turn-a' } : method === 'turn/start' ? { turn: { id: 'turn-b' } } : {}); const session = new NativeSession(request); return { request, session }; }
describe('native task controls', () => {
  it('steers the actual expected turn and preserves the command identity', async () => {
    const { request, session } = fixture();
    await nativeControl(session, { method: 'send', params: { id: 'thread', epoch: 'epoch', mode: 'steer', turnId: 'turn-a', text: '调整方向' } } as Command, 'command', snapshot, []);
    expect(request).toHaveBeenCalledWith('turn/steer', expect.objectContaining({ threadId: 'thread', expectedTurnId: 'turn-a', clientUserMessageId: 'command' }));
    expect(request).not.toHaveBeenCalledWith('turn/start', expect.anything());
  });
  it('rejects an obsolete turn without sending an operation', async () => {
    const { request, session } = fixture();
    await expect(nativeControl(session, { method: 'stop', params: { id: 'thread', epoch: 'epoch', turnId: 'old-turn' } } as Command, 'command', snapshot, [])).rejects.toThrow('变化');
    expect(request).not.toHaveBeenCalled();
  });
  it('never retries an operation after loss of its confirmation', async () => {
    const { request, session } = fixture(); request.mockRejectedValue(new Error('Disconnected after send'));
    await expect(nativeControl(session, { method: 'stop', params: { id: 'thread', epoch: 'epoch', turnId: 'turn-a' } } as Command, 'command', snapshot, [])).rejects.toThrow('Disconnected');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('changes permission settings without stopping the current turn', async () => {
    const { request, session } = fixture();
    await nativeControl(session, { method: 'permissions.update', params: { id: 'thread', epoch: 'epoch', revision: 'revision', permission: 'approve' } } as Command, 'command', snapshot, []);
    expect(request).toHaveBeenCalledExactlyOnceWith('thread/settings/update', { threadId: 'thread', permissions: ':workspace', approvalPolicy: 'on-request', approvalsReviewer: 'guardian_subagent' });
  });
  it('rechecks authorization before dispatch', async () => {
    const { request, session } = fixture();
    await expect(nativeControl(session, { method: 'stop', params: { id: 'thread', epoch: 'epoch', turnId: 'turn-a' } } as Command, 'command', snapshot, [], () => { throw new Error('Revoked'); })).rejects.toThrow('Revoked');
    expect(request).not.toHaveBeenCalled();
  });
  it('answers a native question through its original RPC request', async () => {
    const { request, session } = fixture(); vi.spyOn(session, 'read').mockResolvedValue({ turns: [] });
    await nativeControl(session, { method: 'respond', params: { id: 'thread', epoch: 'epoch', requestId: 0, answers: { q: ['继续'] } } } as Command, 'command', { ...snapshot, requests: [{ id: 0, kind: 'input', title: '需要回复', detail: '', questions: [{ id: 'q', question: '继续？', options: [] }] }] }, []);
    expect(request).toHaveBeenCalledExactlyOnceWith('bridge/respond', { threadId: 'thread', requestId: 0, result: { answers: { q: { answers: ['继续'] } } } });
  });
});
