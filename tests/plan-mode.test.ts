import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexDesktop, normalizeSnapshot } from '../src/agent/desktop.js';
import { NativeIpc } from '../src/agent/ipc.js';
import { AgentStore } from '../src/agent/store.js';
import { commandSchema, isSafetyCommand, supportsDesktopCommand, RemoteError } from '../src/shared/protocol.js';

afterEach(() => vi.restoreAllMocks());
function planState() {
  const id = randomUUID(); const turnId = randomUUID(); const planContent = '# Plan\n\n1. Check the input.\n2. Add focused tests.';
  return { id, title: 'Planning task', latestModel: 'fixture-model', latestReasoningEffort: 'high',
    latestCollaborationMode: { mode: 'plan', settings: { model: 'fixture-model', reasoning_effort: 'high', developer_instructions: 'plan-only instructions' } },
    threadRuntimeStatus: { type: 'idle' },
    turns: [{ turnId, status: 'completed', items: [{ id: 'plan-item', type: 'plan', text: planContent }, { id: `implement-plan:${turnId}`, type: 'planImplementation', turnId, planContent, isCompleted: false }] }],
    requests: [{ id: `implement-plan:${turnId}`, method: 'item/plan/requestImplementation', params: { threadId: id, turnId, planContent } }] };
}
function fixture() {
  const state = planState(); const adapter = new CodexDesktop('unused', resolve('fixture-codex-home'));
  vi.spyOn(adapter as any, 'ready').mockResolvedValue(undefined); vi.spyOn(adapter as any, 'follow').mockResolvedValue(undefined);
  vi.spyOn(adapter as any, 'snapshot').mockImplementation(() => normalizeSnapshot(state, 'epoch'));
  Reflect.set(adapter, 'current', { id: state.id, owner: 'desktop-owner', state, revision: 1 });
  const ipc = vi.spyOn(NativeIpc.prototype, 'request').mockResolvedValue({ resultType: 'success' });
  const snapshot = normalizeSnapshot(state, 'epoch'); const request = snapshot.requests[0];
  const command = { method: 'plan.respond', params: { id: state.id, epoch: snapshot.epoch, requestId: request.id, revision: (request as any).plan?.revision ?? '0'.repeat(64), action: 'implement' } };
  return { adapter, state, ipc, snapshot, command };
}
describe('plan mode and implementation', () => {
  it('projects a completed native plan as a final result and an explicit versioned confirmation', () => {
    const state = planState(); const snapshot = normalizeSnapshot(state, 'epoch');
    expect(snapshot.settings).toMatchObject({ model: 'fixture-model', effort: 'high', mode: 'plan' });
    expect(snapshot.messages).toHaveLength(1); expect(snapshot.messages[0]).toMatchObject({ phase: 'final', text: state.requests[0].params.planContent });
    expect(snapshot.requests[0]).toMatchObject({ kind: 'plan', detail: state.requests[0].params.planContent, plan: { turnId: state.turns[0].turnId, revision: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(JSON.stringify(snapshot)).not.toContain('plan-only instructions');
  });
  it.each(['wrong-thread', 'wrong-id', 'empty-plan', 'oversized-plan', 'completed-item'])('fails closed for %s instead of silently executing a different plan', variant => {
    const state = planState();
    if (variant === 'wrong-thread') state.requests[0].params.threadId = randomUUID();
    if (variant === 'wrong-id') state.requests[0].id = 'unrelated';
    if (variant === 'empty-plan') state.requests[0].params.planContent = '';
    if (variant === 'oversized-plan') state.requests[0].params.planContent = 'x'.repeat(64001);
    if (variant === 'completed-item') (state.turns[0].items[1] as any).isCompleted = true;
    expect(normalizeSnapshot(state, 'epoch').requests.some(request => request.kind === 'plan')).toBe(false);
  });
  it('starts the exact visible plan in default mode through a single native call and preserves permissions', async () => {
    const { adapter, state, ipc, command } = fixture(); const authorize = vi.fn(); const commandId = randomUUID();
    try {
      await adapter.execute(commandSchema.parse(command), commandId, authorize);
      expect(ipc).toHaveBeenCalledTimes(1); expect(authorize).toHaveBeenCalledTimes(1);
      expect(ipc).toHaveBeenCalledWith('thread-follower-start-turn', {
        conversationId: state.id, turnStart: { request: { threadId: state.id, clientUserMessageId: commandId,
          input: [{ type: 'text', text: 'PLEASE IMPLEMENT THIS PLAN:\n' + state.requests[0].params.planContent, text_elements: [] }],
          collaborationMode: { mode: 'default', settings: { model: 'fixture-model', reasoning_effort: 'high', developer_instructions: null } } },
          context: { inheritThreadSettings: true, attachments: [], commentAttachments: [] } }
      }, 2, 'desktop-owner');
      expect(state.requests).toHaveLength(1);
    } finally { adapter.close(); }
  });
  it('sends feedback in plan mode instead of implementing, approving, or interrupting anything', async () => {
    const { adapter, ipc, command } = fixture();
    try {
      await adapter.execute(commandSchema.parse({ ...command, params: { ...command.params, action: 'revise', feedback: 'Keep the database unchanged.' } }), randomUUID());
      expect(ipc).toHaveBeenCalledTimes(1);
      expect(ipc.mock.calls[0][1]).toMatchObject({ turnStart: { request: { collaborationMode: { mode: 'plan' }, input: [{ type: 'text', text: 'Keep the database unchanged.' }] } } });
    } finally { adapter.close(); }
  });
  it.each(['content', 'mode', 'resolved', 'active', 'other-request', 'new-turn'])('rejects a stale or conflicting plan after %s changes', async change => {
    const { adapter, state, ipc, command } = fixture();
    if (change === 'content') state.requests[0].params.planContent += '\nChanged.';
    if (change === 'mode') state.latestCollaborationMode.mode = 'default';
    if (change === 'resolved') state.requests = [];
    if (change === 'active') state.threadRuntimeStatus.type = 'active';
    if (change === 'other-request') state.requests.push({ id: 'approval', method: 'unknown', params: {} } as any);
    if (change === 'new-turn') state.turns.push({ turnId: randomUUID(), status: 'completed', items: [] });
    try { await expect(adapter.execute(commandSchema.parse(command), randomUUID())).rejects.toBeInstanceOf(RemoteError); expect(ipc).not.toHaveBeenCalled(); }
    finally { adapter.close(); }
  });
  it('changes only the next-turn mode while a task is active and rejects a stale settings revision', async () => {
    const { adapter, state, snapshot, ipc } = fixture(); state.threadRuntimeStatus.type = 'active';
    const command = commandSchema.parse({ method: 'mode.update', params: { id: state.id, epoch: 'epoch', revision: snapshot.settings!.revision, mode: 'default' } });
    try {
      await adapter.execute(command, randomUUID());
      expect(ipc).toHaveBeenCalledWith('thread-follower-update-thread-settings', { conversationId: state.id, threadSettings: { collaborationMode: { mode: 'default', settings: { model: 'fixture-model', reasoning_effort: 'high', developer_instructions: null } } } }, 1, 'desktop-owner');
      ipc.mockClear(); state.latestReasoningEffort = 'low'; state.latestCollaborationMode.settings.reasoning_effort = 'low';
      await expect(adapter.execute(command, randomUUID())).rejects.toMatchObject({ code: 'STALE' }); expect(ipc).not.toHaveBeenCalled();
    } finally { adapter.close(); }
  });
  it('requires explicit capabilities and never treats either plan action as a safety-only operation', () => {
    const { adapter, command, snapshot } = fixture();
    try {
      for (const action of ['implement', 'revise']) {
        const value = commandSchema.parse({ ...command, params: { ...command.params, action, ...(action === 'revise' ? { feedback: 'Revise this.' } : {}) } });
        expect(isSafetyCommand(value)).toBe(false); expect(supportsDesktopCommand(undefined, value)).toBe(false); expect(supportsDesktopCommand(['plan-implementation'], value)).toBe(true);
      }
      expect(commandSchema.safeParse({ ...command, params: { ...command.params, action: 'revise', feedback: ' ' } }).success).toBe(false);
      expect(commandSchema.safeParse({ ...command, params: { ...command.params, planContent: 'Forged plan', decision: 'decline' } }).success).toBe(false);
      const mode = commandSchema.parse({ method: 'mode.update', params: { id: snapshot.id, epoch: snapshot.epoch, revision: snapshot.settings!.revision, mode: 'plan' } });
      expect(isSafetyCommand(mode)).toBe(false); expect(supportsDesktopCommand(undefined, mode)).toBe(false); expect(supportsDesktopCommand(['task-mode'], mode)).toBe(true);
    } finally { adapter.close(); }
  });
  it('retains uncertain plan submissions across helper restart and allows retry after a proven pre-dispatch failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-once-')); let store = new AgentStore(dir); const { adapter, command } = fixture(); const parsed = command as any;
    try {
      await expect(store.once('plan:uncertain', parsed, async () => { throw new RemoteError('OUTCOME_UNKNOWN', 'unknown'); })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
      store.close(); store = new AgentStore(dir); const send = vi.fn(async () => ({ accepted: true }));
      await expect(store.once('plan:uncertain', parsed, send)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' }); expect(send).not.toHaveBeenCalled();
      await expect(store.once('plan:retry', parsed, async () => { throw new RemoteError('STALE', 'not sent'); })).rejects.toMatchObject({ code: 'STALE' });
      await store.once('plan:retry', parsed, send); await store.once('plan:retry', parsed, send); expect(send).toHaveBeenCalledTimes(1);
      store.db.prepare('UPDATE commands SET created=?').run(Date.now() - 30 * 86400000);
      await store.once(randomUUID(), { method: 'mode.update', params: { id: randomUUID(), epoch: 'epoch', revision: 'revision', mode: 'plan' } }, async () => ({ accepted: true }));
      await expect(store.once('plan:uncertain', parsed, send)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' }); expect(send).toHaveBeenCalledTimes(1);
    } finally { adapter.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
