import { describe, it, expect, vi } from 'vitest';
import { NativeSession } from '../src/agent/native-session.js';
import { nativeControl } from '../src/agent/native-control.js';
import { RemoteError, type Snapshot, type Command } from '../src/shared/protocol.js';
const snapshot = { id: 'thread', epoch: 'epoch', busy: true, turnId: 'turn-a', requests: [], messages: [], settings: { model: 'model', effort: 'high', revision: 'revision', mode: 'default' } } as unknown as Snapshot;
function fixture() { const request = vi.fn(async (method: string) => method === 'turn/steer' ? { turnId: 'turn-a' } : method === 'turn/start' ? { turn: { id: 'turn-b' } } : {}); const session = new NativeSession(request); return { request, session }; }
describe('native task controls', () => {
  it.each(['already received', 'lost acknowledgement', 'no receipt'])('never resends an async answer with %s', async kind => {
    vi.useFakeTimers();
    const { session, request } = fixture();
    const id = JSON.stringify(['request_user_input_async', 'message', 0]);
    const interaction = { id, kind: 'input' as const, title: '需要回复', detail: '', questions: [{ id, question: 'Continue?', options: [] }] };
    const question = { id: 'message', type: 'agentMessage', questions: [{ title: 'Continue?', options: [] }] };
    const answer = { id: 'answer', type: 'userMessage', content: [{ type: 'text', text: '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: id, question: 'Continue?', answer: 'Yes' }]) + '\n</send_user_message_question_reply>' }] };
    const unanswered = { turns: [{ turnId: 'turn-a', items: [question] }] }, answered = { turns: [{ turnId: 'turn-a', items: [answer, question] }] };
    const read = vi.spyOn(session, 'read').mockResolvedValue(kind === 'no receipt' ? unanswered : answered);
    if (kind === 'lost acknowledgement') { read.mockResolvedValueOnce(unanswered); request.mockRejectedValue(new RemoteError('OUTCOME_UNKNOWN', 'Acknowledgement lost')); }
    try {
      const result = nativeControl(session, { method: 'respond', params: { id: 'thread', epoch: 'epoch', requestId: id, answers: { [id]: ['Yes'] } } } as Command, 'answer-command', { ...snapshot, requests: [interaction] }, []);
      const assertion = kind === 'no receipt' ? expect(result).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' }) : expect(result).resolves.toMatchObject({ accepted: true });
      await vi.advanceTimersByTimeAsync(16000); await assertion;
      expect(request).toHaveBeenCalledTimes(kind === 'already received' ? 0 : 1);
    } finally { vi.useRealTimers(); }
  });
  it('does not acknowledge an async answer until its exact receipt appears in native history', async () => {
    vi.useFakeTimers();
    const { session, request } = fixture();
    const id = JSON.stringify(['request_user_input_async', 'message', 0]);
    const question = { id: 'message', type: 'agentMessage', questions: [{ title: 'Continue?', options: ['Yes', 'No'] }] };
    const state = { turns: [{ turnId: 'turn-a', status: 'inProgress', items: [question] as any[] }] };
    vi.spyOn(session, 'read').mockImplementation(async () => state);
    const snap = { ...snapshot, requests: [{ id, kind: 'input' as const, title: '需要回复', detail: '', questions: [{ id, question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] }] };
    let settled = false;
    try {
      const result = nativeControl(session, { method: 'respond', params: { id: 'thread', epoch: 'epoch', requestId: id, answers: { [id]: ['Yes'] } } } as Command, 'answer-command', snap, []).then(value => { settled = true; return value; });
      await vi.advanceTimersByTimeAsync(2000);
      expect(request.mock.calls.filter(([method]) => method === 'turn/steer')).toHaveLength(1);
      expect(settled).toBe(false);
      state.turns[0].items.unshift({ id: 'answer', type: 'userMessage', content: [{ type: 'text', text: '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: id, question: 'Continue?', answer: 'Yes' }]) + '\n</send_user_message_question_reply>' }] });
      await vi.advanceTimersByTimeAsync(200);
      await expect(result).resolves.toMatchObject({ accepted: true });
      expect(request.mock.calls.filter(([method]) => method === 'turn/steer')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
  it('does not send an interrupt if the requested turn has already finished', async () => {
    const { request, session } = fixture();
    await expect(nativeControl(session, { method: 'stop', params: { id: 'thread', epoch: 'epoch', turnId: 'turn-a' } } as Command, 'command', { ...snapshot, busy: false, turnId: null, lastTurnId: 'turn-a', lastTurnStatus: 'completed' }, [])).resolves.toMatchObject({ accepted: true });
    expect(request).not.toHaveBeenCalled();
  });
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
  it('treats a stop racing with task completion as already satisfied after resynchronizing', async () => {
    const { request, session } = fixture();
    request.mockRejectedValue(new Error('no active turn to interrupt'));
    vi.spyOn(session, 'read').mockResolvedValue({ id: 'thread', turns: [{ turnId: 'turn-a', status: 'completed', items: [] }], threadRuntimeStatus: { type: 'idle' } });
    await expect(nativeControl(session, { method: 'stop', params: { id: 'thread', epoch: 'epoch', turnId: 'turn-a' } } as Command, 'command', snapshot, [])).resolves.toMatchObject({ accepted: true });
    expect(request).toHaveBeenCalledExactlyOnceWith('turn/interrupt', { threadId: 'thread', turnId: 'turn-a' });
  });
  it('never stops a new turn when the original stop has become stale', async () => {
    const { request, session } = fixture(); request.mockRejectedValue(new Error('no active turn to interrupt'));
    vi.spyOn(session, 'read').mockResolvedValue({ id: 'thread', turns: [{ turnId: 'turn-b', status: 'inProgress', items: [] }], threadRuntimeStatus: { type: 'active' } });
    await expect(nativeControl(session, { method: 'stop', params: { id: 'thread', epoch: 'epoch', turnId: 'turn-a' } } as Command, 'command', snapshot, [])).rejects.toThrow('当前生成已经结束或变化');
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
