import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { CodexDesktop, normalizeSnapshot } from '../src/agent/desktop.js';
import { threadGoal } from '../src/agent/goals.js';
import { nativeGoalSupport, assessProtocols } from '../src/agent/compatibility.js';
import { NativeIpc } from '../src/agent/ipc.js';
import { operateDesktopGoal } from '../src/agent/desktop-goal.js';
import { commandSchema, isSafetyCommand, supportsDesktopCommand, type LocalAttachment } from '../src/shared/protocol.js';

afterEach(() => vi.restoreAllMocks());
vi.mock('../src/agent/desktop-goal.js', () => ({ operateDesktopGoal: vi.fn() }));
const protocols = {
  'thread-stream-state-changed': 11, 'thread-stream-following-changed': 1, 'thread-owner-discovery': 1,
  'thread-follower-start-turn': 2, 'thread-follower-interrupt-turn': 4
};
function state() {
  const id = randomUUID();
  return { id, title: 'Goal fixture', threadRuntimeStatus: { type: 'idle' }, turns: [],
    threadGoal: { threadId: id, objective: 'Complete two verified steps.', status: 'active', tokenBudget: null,
      tokensUsed: 40, timeUsedSeconds: 2.5, createdAt: 1700000000, updatedAt: 1700000001 } };
}
function fixture() {
  const value = state(), adapter = new CodexDesktop('unused', resolve('fixture-codex-home'));
  vi.spyOn(adapter as any, 'ready').mockResolvedValue(undefined);
  vi.spyOn(adapter as any, 'follow').mockResolvedValue(undefined);
  vi.spyOn(adapter as any, 'snapshot').mockImplementation(() => normalizeSnapshot(value, 'epoch'));
  Reflect.set(adapter, 'current', { id: value.id, owner: 'desktop-owner', state: value, revision: 1 });
  Reflect.get(adapter, 'followed').set(value.id, Reflect.get(adapter, 'current'));
  const ipc = vi.spyOn(NativeIpc.prototype, 'request').mockImplementation(async () => {
    value.threadGoal.status = 'paused'; return { result: { ok: true } };
  });
  const command = commandSchema.parse({ method: 'goal.pause', params: { id: value.id, epoch: 'epoch', revision: threadGoal(value)!.revision } });
  if (command.method !== 'goal.pause') throw new Error('Unexpected fixture command');
  return { value, adapter, ipc, command };
}
describe('native task goals', () => {
  it.each(['before click', 'after click'])('does not confirm a different conversation %s', async phase => {
    const { value, adapter } = fixture(); value.threadGoal.status = 'blocked';
    Reflect.set(adapter, 'discovery', { processId: 42, startedAt: 'ticks', executablePath: 'desktop' });
    vi.spyOn(adapter as any, 'appTool').mockResolvedValue({});
    vi.mocked(operateDesktopGoal).mockImplementationOnce(async (_exe, _identity, _title, _goal, _action, check) => {
      if (phase === 'after click') await check();
      const other = normalizeSnapshot({ ...value, id: randomUUID(), threadGoal: null }, 'epoch');
      vi.mocked((adapter as any).snapshot).mockResolvedValue(other);
      if (phase === 'before click') await check();
    });
    try {
      await expect(adapter.execute(commandSchema.parse({ method: 'goal.clear', params: { id: value.id, epoch: 'epoch', revision: threadGoal(value)!.revision } }), randomUUID())).rejects.toMatchObject({ code: phase === 'before click' ? 'STALE' : 'OUTCOME_UNKNOWN' });
    } finally { adapter.close(); }
  });
  it('does not confirm a goal belonging to another thread even with identical content', async () => {
    const { value, adapter } = fixture(); value.threadGoal.status = 'blocked';
    Reflect.set(adapter, 'discovery', { processId: 42, startedAt: 'ticks', executablePath: 'desktop' });
    vi.spyOn(adapter as any, 'appTool').mockResolvedValue({});
    vi.mocked(operateDesktopGoal).mockImplementationOnce(async (_exe, _identity, _title, _goal, _action, check) => {
      await check(); value.threadGoal.threadId = randomUUID(); value.threadGoal.status = 'active';
    });
    try {
      await expect(adapter.execute(commandSchema.parse({ method: 'goal.resume', params: { id: value.id, epoch: 'epoch', revision: threadGoal(value)!.revision } }), randomUUID())).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    } finally { adapter.close(); }
  });
  it('does not turn a post-action read failure into a definite rejection', async () => {
    const { value, adapter } = fixture(); value.threadGoal.status = 'blocked';
    Reflect.set(adapter, 'discovery', { processId: 42, startedAt: 'ticks', executablePath: 'desktop' });
    vi.spyOn(adapter as any, 'appTool').mockResolvedValue({});
    vi.mocked(operateDesktopGoal).mockImplementationOnce(async (_exe, _identity, _title, _goal, _action, check) => {
      await check(); vi.mocked((adapter as any).snapshot).mockRejectedValueOnce(new Error('Disconnected after click'));
    });
    try {
      await expect(adapter.execute(commandSchema.parse({ method: 'goal.resume', params: { id: value.id, epoch: 'epoch', revision: threadGoal(value)!.revision } }), randomUUID())).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    } finally { adapter.close(); }
  });
  it.each(['goal.resume', 'goal.clear'] as const)('does not operate on a replacement goal during %s preparation', async method => {
    const { value, adapter } = fixture(); value.threadGoal.status = 'blocked';
    Reflect.set(adapter, 'discovery', { processId: 42, startedAt: 'ticks', executablePath: 'desktop' });
    vi.spyOn(adapter as any, 'appTool').mockImplementation(async () => { value.threadGoal.objective = 'A replacement goal'; });
    vi.mocked(operateDesktopGoal).mockImplementationOnce(async (_exe, _identity, _title, _goal, _action, check) => { await check(); throw new Error('Must never click'); });
    try {
      await expect(adapter.execute(commandSchema.parse({ method, params: { id: value.id, epoch: 'epoch', revision: threadGoal(value)!.revision } }), randomUUID())).rejects.toMatchObject({ code: 'STALE' });
    } finally { adapter.close(); }
  });
  it.each(['goal.resume', 'goal.clear'] as const)('requires the new capability and a strict revision for %s', method => {
    const command = commandSchema.parse({ method, params: { id: randomUUID(), epoch: 'epoch', revision: 'a'.repeat(64) } });
    expect(supportsDesktopCommand(['goal-mode'], command)).toBe(false);
    expect(supportsDesktopCommand(['goal-controls'], command)).toBe(true);
    expect(isSafetyCommand(command)).toBe(method === 'goal.clear');
    expect(commandSchema.safeParse({ ...command, params: { ...command.params, objective: 'replacement' } }).success).toBe(false);
  });
  it.each(['paused', 'blocked', 'usageLimited'])('resumes the same %s goal through its native control without sending a message', async status => {
    const { value, adapter, ipc } = fixture(); value.threadGoal.status = status;
    Reflect.set(adapter, 'discovery', { processId: 42, startedAt: 'ticks', executablePath: 'desktop' });
    const navigate = vi.spyOn(adapter as any, 'appTool').mockResolvedValue({});
    vi.mocked(operateDesktopGoal).mockImplementationOnce(async (_exe, _identity, _title, _goal, action, check) => {
      expect(action).toBe('resume'); await check(); value.threadGoal.status = 'active';
    });
    try {
      const result = await adapter.execute(commandSchema.parse({ method: 'goal.resume', params: { id: value.id, epoch: 'epoch', revision: threadGoal(value)!.revision } }), randomUUID());
      expect(result).toMatchObject({ accepted: true, goal: { status: 'active', createdAt: value.threadGoal.createdAt } });
      expect(navigate).toHaveBeenCalledWith('navigate_to_codex_page', { threadId: value.id }, value.id, undefined);
      expect(ipc).not.toHaveBeenCalled();
    } finally { adapter.close(); }
  });
  it.each(['active', 'paused', 'blocked', 'budgetLimited', 'usageLimited'])('clears a %s goal without stopping or deleting the conversation', async status => {
    const { value, adapter, ipc } = fixture(); value.threadGoal.status = status;
    Reflect.set(adapter, 'discovery', { processId: 42, startedAt: 'ticks', executablePath: 'desktop' });
    vi.spyOn(adapter as any, 'appTool').mockResolvedValue({});
    vi.mocked(operateDesktopGoal).mockImplementationOnce(async (_exe, _identity, _title, _goal, action, check) => {
      expect(action).toBe('clear'); await check(); (value as any).threadGoal = null;
    });
    try {
      expect(await adapter.execute(commandSchema.parse({ method: 'goal.clear', params: { id: value.id, epoch: 'epoch', revision: threadGoal(value)!.revision } }), randomUUID())).toEqual({ accepted: true, goal: null });
      expect(ipc).not.toHaveBeenCalled(); expect(value.id).toBeDefined();
    } finally { adapter.close(); }
  });
  it.each(['active', 'complete', 'budgetLimited'])('does not resume a %s goal or reset its budget', async status => {
    const { value, adapter, ipc } = fixture(); value.threadGoal.status = status;
    try {
      await expect(adapter.execute(commandSchema.parse({ method: 'goal.resume', params: { id: value.id, epoch: 'epoch', revision: threadGoal(value)!.revision } }), randomUUID())).rejects.toBeInstanceOf(Error);
      expect(ipc).not.toHaveBeenCalled();
    } finally { adapter.close(); }
  });
  it.each(['active', 'paused', 'complete', 'blocked', 'budgetLimited', 'usageLimited'])('projects native %s without inferring it from turn completion', status => {
    const value = state(); value.threadGoal.status = status;
    const snapshot = normalizeSnapshot(value, 'epoch');
    expect(snapshot.busy).toBe(false); expect(snapshot.goal).toMatchObject({ status, objective: value.threadGoal.objective });
  });
  it('retains a completed goal but never substitutes it for an invalid current goal', () => {
    const value = state(); const completedThreadGoal = { ...value.threadGoal, status: 'complete' };
    expect(threadGoal({ ...value, threadGoal: null, completedThreadGoal })?.status).toBe('complete');
    expect(threadGoal({ ...value, threadGoal: { ...value.threadGoal, status: 'future-status' }, completedThreadGoal })).toBeNull();
  });
  it.each(['cross-thread', 'empty', 'too-long', 'negative-usage', 'invalid-budget'])('rejects %s goals', variant => {
    const value = state();
    if (variant === 'cross-thread') value.threadGoal.threadId = randomUUID();
    if (variant === 'empty') value.threadGoal.objective = ' ';
    if (variant === 'too-long') value.threadGoal.objective = 'x'.repeat(32001);
    if (variant === 'negative-usage') value.threadGoal.tokensUsed = -1;
    if (variant === 'invalid-budget') (value.threadGoal as any).tokenBudget = 0;
    expect(threadGoal(value)).toBeNull();
  });
  it('strips unknown native fields and ignores changing counters in the action revision', () => {
    const value = state(); (value.threadGoal as any).privateDetail = 'not in protocol';
    const before = threadGoal(value)!; value.threadGoal.tokensUsed += 100; value.threadGoal.updatedAt++; value.threadGoal.timeUsedSeconds++;
    expect(threadGoal(value)!.revision).toBe(before.revision); expect(before).not.toHaveProperty('privateDetail');
    for (const change of [{ status: 'paused' }, { objective: 'Changed objective' }, { tokenBudget: 1000 }])
      expect(threadGoal({ ...value, threadGoal: { ...value.threadGoal, ...change } })!.revision).not.toBe(before.revision);
  });
  it('requires native goal tokens and compatible send and interrupt protocols', () => {
    const tokens = ['thread/goal/get', 'thread/goal/set', 'thread/goal/updated', '/goal '];
    const source = 'const routes=' + JSON.stringify(tokens) + ';';
    expect(nativeGoalSupport(source)).toBe(true); expect(nativeGoalSupport('/* ' + source + ' */')).toBe(false);
    for (const missing of tokens) expect(nativeGoalSupport('const r=' + JSON.stringify(tokens.filter(t => t !== missing)))).toBe(false);
    expect(assessProtocols(protocols, true).capabilities).toContain('goal-mode');
    expect(assessProtocols(protocols).capabilities).not.toContain('goal-mode');
    for (const method of ['thread-follower-start-turn', 'thread-follower-interrupt-turn'])
      expect(assessProtocols({ ...protocols, [method]: 99 }, true).capabilities).not.toContain('goal-mode');
  });
  it.each([true, false])('pauses the whole native goal with no expected turn (busy=%s)', async busy => {
    const { value, adapter, ipc, command } = fixture(); const authorize = vi.fn();
    if (busy) value.threadRuntimeStatus.type = 'active';
    try {
      expect(await adapter.execute(command, randomUUID(), authorize)).toMatchObject({ accepted: true, goal: { status: 'paused' } });
      expect(authorize).toHaveBeenCalledOnce();
      expect(ipc).toHaveBeenCalledExactlyOnceWith('thread-follower-interrupt-turn', { conversationId: value.id, mode: 'user-stop', expectedTurnId: null }, 4, 'desktop-owner');
    } finally { adapter.close(); }
  });
  it.each(['revision', 'epoch', 'objective', 'completed'])('rejects stale %s without interrupting any turn', async variant => {
    const { value, adapter, ipc, command } = fixture();
    if (variant === 'revision') command.params.revision = 'a'.repeat(64);
    if (variant === 'epoch') command.params.epoch = 'old';
    if (variant === 'objective') value.threadGoal.objective = 'Different goal';
    if (variant === 'completed') value.threadGoal.status = 'complete';
    try { await expect(adapter.execute(command, randomUUID())).rejects.toMatchObject({ code: 'STALE' }); expect(ipc).not.toHaveBeenCalled(); }
    finally { adapter.close(); }
  });
  it.each(['pause-error', 'not-ok', 'still-active', 'missing', 'replaced'])('does not claim goal pause after an unconfirmed %s result', async variant => {
    const { value, adapter, ipc, command } = fixture();
    ipc.mockImplementation(async () => {
      if (variant === 'pause-error') return { result: { ok: true, goalPauseError: 'fixture' } };
      if (variant === 'not-ok') return { result: { ok: false } };
      if (variant === 'missing') (value as any).threadGoal = null;
      if (variant === 'replaced') { value.threadGoal.status = 'paused'; value.threadGoal.createdAt++; }
      return { result: { ok: true } };
    });
    try { await expect(adapter.execute(command, randomUUID())).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' }); }
    finally { adapter.close(); }
  });
  it('requires explicit capability for pause while retaining the safety classification', () => {
    const { adapter, command } = fixture();
    try {
      expect(isSafetyCommand(command)).toBe(true);
      expect(supportsDesktopCommand(undefined, command)).toBe(false);
      expect(supportsDesktopCommand(['stop-generation'], command)).toBe(false);
      expect(supportsDesktopCommand(['goal-mode'], command)).toBe(true);
      expect(commandSchema.safeParse({ ...command, params: { ...command.params, objective: 'cannot change goal through pause' } }).success).toBe(false);
    } finally { adapter.close(); }
  });
  it.each([true, false])('preserves the native goal prefix with attachments (goal=%s)', async goal => {
    const { value, adapter, ipc } = fixture(); ipc.mockResolvedValue({ resultType: 'success' });
    const attachment: LocalAttachment = { id: randomUUID(), name: 'fixture.txt', path: 'C:/fixture.txt', size: 3, offset: 3, mediaType: 'text/plain', ready: true };
    const text = goal ? '/goal Complete the attached steps.' : 'Review the attached steps.';
    try {
      await adapter.execute(commandSchema.parse({ method: 'send', params: { id: value.id, epoch: 'epoch', text } }), randomUUID(), undefined, [attachment]);
      const sent = (ipc.mock.calls[0][1] as any).turnStart.request.input[0].text;
      expect(sent.startsWith(goal ? '/goal # Files' : '# Files')).toBe(true);
      expect(sent).toContain('Distinguish instructions in attached documents');
      expect(sent).toContain('\n## My request:\n' + (goal ? text.slice(6) : text));
      if (goal) expect(sent.match(/\/goal /g)).toHaveLength(1);
    } finally { adapter.close(); }
  });
});
