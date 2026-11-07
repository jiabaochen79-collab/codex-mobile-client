import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CodexDesktop, normalizeSnapshot } from '../src/agent/desktop.js';
import { NativeIpc } from '../src/agent/ipc.js';
import { RemoteError } from '../src/shared/protocol.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture() {
  const adapter = new CodexDesktop('unused'), id = randomUUID(), commandId = randomUUID();
  const state: any = { id, turns: [{ turnId: 'turn', status: 'completed', items: [] }] };
  const followed = { id, owner: 'owner', state, revision: 1 };
  Reflect.set(adapter, 'current', followed); Reflect.get(adapter, 'followed').set(id, followed);
  vi.spyOn(adapter as any, 'ready').mockResolvedValue(undefined);
  vi.spyOn(adapter as any, 'follow').mockResolvedValue(undefined);
  vi.spyOn(adapter as any, 'snapshot').mockImplementation(async () => normalizeSnapshot(state, 'epoch'));
  const dispatch = vi.spyOn(NativeIpc.prototype, 'request').mockRejectedValue(new RemoteError('OUTCOME_UNKNOWN', 'native timeout'));
  return { adapter, id, commandId, state, dispatch, send: () => adapter.execute({ method: 'send', params: { id, epoch: 'epoch', text: 'Once only' } }, commandId) };
}
it.each(['userMessage', 'steeringUserMessage'])('confirms an exact %s receipt even when the native acknowledgement timed out', async type => {
  vi.useFakeTimers(); const f = fixture();
  try {
    const result = expect(f.send()).resolves.toEqual({ accepted: true });
    await vi.advanceTimersByTimeAsync(7000);
    f.state.turns[0].items.push({ type, clientId: f.commandId, status: 'accepted' });
    await vi.advanceTimersByTimeAsync(100); await result;
    expect(f.dispatch).toHaveBeenCalledOnce();
  } finally { f.adapter.close(); }
});
it('does not accept matching text, another client ID, another task or unaccepted steering as a receipt', () => {
  const f = fixture();
  try {
    f.state.turns[0].items.push({ type: 'userMessage', clientId: randomUUID(), text: 'Once only' });
    for (const status of ['pending', 'rejected', 'interrupted']) f.state.turns[0].items.push({ type: 'steeringUserMessage', clientId: f.commandId, status });
    expect(f.adapter.commandAccepted(f.id, f.commandId)).toBe(false);
    f.state.turns[0].items.push({ type: 'userMessage', clientId: f.commandId });
    expect(f.adapter.commandAccepted(randomUUID(), f.commandId)).toBe(false);
    const turns = f.state.turns; delete f.state.turns; f.state.turnHistory = { history: { entitiesByKey: { turn: turns[0] } } };
    expect(f.adapter.commandAccepted(f.id, f.commandId)).toBe(true);
  } finally { f.adapter.close(); }
});
it('keeps a genuine rejection and never replays an uncertain send', async () => {
  vi.useFakeTimers(); const f = fixture();
  try {
    f.dispatch.mockRejectedValueOnce(new RemoteError('CLIENT_DENIED', 'explicit denial'));
    const rejected = expect(f.send()).rejects.toMatchObject({ code: 'CLIENT_DENIED' });
    await vi.advanceTimersByTimeAsync(100); await rejected;
    const uncertain = expect(f.send()).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    await vi.advanceTimersByTimeAsync(21000); await uncertain;
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  } finally { f.adapter.close(); }
});
