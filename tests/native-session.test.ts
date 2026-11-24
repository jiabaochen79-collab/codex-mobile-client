import { describe, it, expect, vi } from 'vitest';
import { NativeSession } from '../src/agent/native-session.js';
import { normalizeSnapshot } from '../src/agent/desktop.js';

const thread = { id: 'thread-a', name: '测试任务', status: { type: 'idle' }, cwd: 'C:/test', model: 'test-model' };
const settings = { thread, model: 'test-model', reasoningEffort: 'high', collaborationMode: { mode: 'plan', settings: { model: 'test-model', reasoning_effort: 'high' } }, activePermissionProfile: { id: ':workspace' }, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' } };
function fixture() {
  const request = vi.fn(async (method: string, params: any): Promise<any> => {
    if (method === 'thread/resume') return settings;
    if (method === 'thread/read') return { thread };
    if (method === 'thread/turns/list') return { data: [{ id: params.cursor ? 'turn-old' : 'turn-new', startedAt: params.cursor ? 1 : 2, status: 'completed' }], nextCursor: params.cursor ? null : 'older' };
    if (method === 'thread/items/list') return { data: [{ turnId: params.turnId, item: { id: params.turnId + '-message', type: 'agentMessage', text: 'x'.repeat(120000), phase: 'final_answer' } }], nextCursor: null };
    if (method === 'thread/goal/get') return { goal: null };
    if (method === 'bridge/pending') return [];
    if (method === 'bridge/live') return null;
    throw new Error('Unexpected method ' + method);
  });
  return { request, session: new NativeSession(request) };
}
describe('native desktop history', () => {
  it('loads full messages, settings and subsequent history pages', async () => {
    const { request, session } = fixture();
    const current = await session.read(thread.id);
    expect(current.turns[0].items[0].text).toHaveLength(120000);
    expect(current.latestThreadSettings.sandboxPolicy.type).toBe('workspaceWrite');
    expect(normalizeSnapshot(current, 'epoch').settings?.permission).toBe('ask');
    expect(session.hasMore(thread.id)).toBe(true);
    const older = await session.read(thread.id, true);
    expect(older.turns.map((t: any) => t.turnId)).toEqual(['turn-old', 'turn-new']);
    expect(session.hasMore(thread.id)).toBe(false);
    expect(request.mock.calls.filter(([method]) => method === 'thread/resume')).toHaveLength(1);
    expect(request).toHaveBeenCalledWith('thread/items/list', expect.objectContaining({ deferOutput: { commandExecution: true, mcpToolCall: true } }));
  });
  it('rejects messages attributed to another turn', async () => {
    const { session, request } = fixture(); request.mockImplementation(async method => method === 'thread/items/list' ? { data: [{ turnId: 'wrong', item: { id: 'item', type: 'agentMessage' } }] } : (method === 'thread/resume' ? settings : method === 'thread/turns/list' ? { data: [{ id: 'turn', status: 'completed' }] } : method === 'bridge/pending' ? [] : { goal: null }));
    await expect(session.read(thread.id)).rejects.toThrow('归属');
  });
  it('retains pending native question IDs, including numeric zero', async () => {
    const { session, request } = fixture();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => method === 'bridge/pending' ? [{ id: 0, method: 'item/tool/requestUserInput', params: { threadId: thread.id, questions: [{ id: 'q', question: '继续？', options: [] }] } }] : original(method, params));
    expect(normalizeSnapshot(await session.read(thread.id), 'epoch').requests[0]).toMatchObject({ id: 0, kind: 'input' });
  });
  it('keeps updated permissions received while a read is in flight', async () => {
    const { session, request } = fixture(); await session.read(thread.id); session.refresh(thread.id);
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => {
      if (method === 'thread/read') session.notification({ method: 'thread/settings/updated', params: { threadId: thread.id, threadSettings: { ...settings, activePermissionProfile: { id: ':danger-full-access' }, approvalPolicy: 'never' } } });
      return original(method, params);
    });
    expect(normalizeSnapshot(await session.read(thread.id), 'epoch').settings?.permission).toBe('full');
  });
  it('does not restore a forgotten session after an outstanding read', async () => {
    const { session, request } = fixture(); const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => { if (method === 'thread/goal/get') session.forget(thread.id); return original(method, params); });
    await expect(session.read(thread.id)).rejects.toThrow('连接已经变化');
  });
  it('restores the plan confirmation from the completed native plan', async () => {
    const { session, request } = fixture(); const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => method === 'thread/items/list' ? { data: [{ turnId: params.turnId, item: { id: 'plan', type: 'plan', text: '实施步骤' } }] } : original(method, params));
    const snapshot = normalizeSnapshot(await session.read(thread.id), 'epoch');
    expect(snapshot.requests[0]).toMatchObject({ kind: 'plan', detail: '实施步骤', plan: { turnId: 'turn-new' } });
  });
  it('overlays live execution when durable history still says interrupted', async () => {
    const { session, request } = fixture(); const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => method === 'bridge/live' ? { id: 'turn-new', status: 'inProgress', turnStartedAtMs: 2000, items: [{ id: 'stream', type: 'agentMessage', text: '正在执行' }] } : method === 'thread/turns/list' ? { data: [{ id: 'turn-new', startedAt: 2, status: 'interrupted', completedAt: null }] } : original(method, params));
    const snapshot = normalizeSnapshot(await session.read(thread.id), 'epoch');
    expect(snapshot.busy).toBe(true); expect(snapshot.turnId).toBe('turn-new');
    expect(snapshot.messages.at(-1)?.text).toBe('正在执行');
  });
  it.each(['completed', 'failed', 'interrupted'])('does not revive a %s turn from a stale live start after clearing the goal', async status => {
    const { session, request } = fixture(); const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => method === 'bridge/live' ? { id: 'turn-new', status: 'inProgress', turnStartedAtMs: 2000, items: [] }
      : method === 'thread/turns/list' ? { data: [{ id: 'turn-new', startedAt: 2, status, completedAt: 3 }] } : original(method, params));
    const snapshot = normalizeSnapshot(await session.read(thread.id), 'epoch');
    expect(snapshot).toMatchObject({ busy: false, turnId: null, lastTurnStatus: status, goal: null });
    expect(snapshot.messages.every(message => message.turnStatus === status)).toBe(true);
  });
  it('does not revive an older orphaned turn when the newest turn has finished', async () => {
    const { session, request } = fixture(); const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => method === 'thread/turns/list' && params.cursor ? { data: [{ id: 'turn-old', startedAt: 1, status: 'inProgress' }], nextCursor: null } : original(method, params));
    await session.read(thread.id);
    const snapshot = normalizeSnapshot(await session.read(thread.id, true), 'epoch');
    expect(snapshot).toMatchObject({ busy: false, turnId: null, lastTurnStatus: 'completed' });
  });
});
