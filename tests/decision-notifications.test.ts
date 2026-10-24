import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentStore } from '../src/agent/store.js';
import { DecisionMonitor } from '../src/agent/decision-notifications.js';
import { CodexDesktop } from '../src/agent/desktop.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'decision-notification-')), store = new AgentStore(dir), taskId = randomUUID(), path = join(dir, 'rollout.jsonl');
  writeFileSync(path, '');
  const snapshot = vi.fn(async () => ({ taskId, turnId: 'turn-1', requestIds: ['question-1'] }));
  const sources = async () => [{ id: taskId, path }];
  const monitor = new DecisionMonitor(store, sources, snapshot);
  cleanups.push(() => { monitor.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, monitor, snapshot, sources, taskId };
}
it('captures questions with no mobile connection, deduplicates and records resolution durably', async () => {
  const f = fixture(); await f.monitor.poll();
  const first = f.monitor.outbox()[0]; expect(first).toMatchObject({ taskId: f.taskId, turnId: 'turn-1', state: 'required' });
  expect(JSON.stringify(first)).not.toContain('question-1');
  f.monitor.ack(first.requestKey, 'required'); await f.monitor.poll(); expect(f.monitor.outbox()).toEqual([]);
  f.snapshot.mockResolvedValue({ taskId: f.taskId, turnId: 'turn-1', requestIds: [] }); await f.monitor.poll();
  expect(f.monitor.outbox()).toEqual([expect.objectContaining({ requestKey: first.requestKey, state: 'resolved' })]);
  f.monitor.ack(first.requestKey, 'required'); expect(f.monitor.outbox()).toHaveLength(1);
  f.monitor.ack(first.requestKey, 'resolved'); expect(f.monitor.outbox()).toEqual([]);
});
it('keeps separate questions and rounds and does not resurrect answered requests', () => {
  const f = fixture();
  f.monitor.record({ taskId: f.taskId, turnId: 'one', requestIds: ['approval', 'input'] }); expect(f.monitor.outbox()).toHaveLength(2);
  f.monitor.record({ taskId: f.taskId, turnId: 'one', requestIds: [] });
  f.monitor.record({ taskId: f.taskId, turnId: 'one', requestIds: ['input'] }); expect(f.monitor.outbox().every(row => row.state === 'resolved')).toBe(true);
  f.monitor.record({ taskId: f.taskId, turnId: 'two', requestIds: ['input'] }); expect(f.monitor.outbox().filter(row => row.state === 'required')).toHaveLength(1);
});
it('does not infer resolution from desktop read errors and reconfirms before retrying after restart', async () => {
  const f = fixture(); await f.monitor.poll(); f.monitor.close();
  const next = new DecisionMonitor(f.store, f.sources, f.snapshot); cleanups.unshift(() => next.close());
  f.snapshot.mockRejectedValueOnce(new Error('disconnected')); await next.poll();
  expect(next.outbox()).toEqual([]);
  expect(f.store.db.prepare("SELECT state FROM notification_decisions").get()?.state).toBe('required');
  expect(next.outbox(Date.now() + 20000)).toEqual([]);
  f.snapshot.mockResolvedValue({ taskId: f.taskId, turnId: 'turn-1', requestIds: [] }); await next.poll();
  expect(next.outbox()).toEqual([expect.objectContaining({ state: 'resolved' })]);
});
it('reads native approval, plan and asynchronous questions without navigating or sending', async () => {
  const desktop = new CodexDesktop('unused'), taskId = randomUUID();
  const ready = vi.spyOn(desktop as any, 'ready').mockResolvedValue(undefined);
  const follow = vi.spyOn(desktop as any, 'follow').mockResolvedValue(undefined);
  const appTool = vi.spyOn(desktop as any, 'appTool');
  const state = { id: taskId, turns: [{ turnId: 'turn', status: 'completed', items: [{ id: 'plan', type: 'planImplementation', isCompleted: false }, { id: 'question', type: 'agentMessage', questions: [{ title: 'Private question', options: ['A'] }] }] }], requests: [{ id: 'approval', method: 'item/commandExecution/requestApproval', params: { command: 'secret command' } }, { id: 'implement-plan:turn', method: 'item/plan/requestImplementation', params: { threadId: taskId, turnId: 'turn', planContent: 'private plan' } }] };
  Reflect.set(desktop, 'current', { state });
  try {
    const result = await desktop.notificationSnapshot(taskId);
    expect(result).toMatchObject({ taskId, turnId: 'turn' }); expect(result.requestIds).toHaveLength(3);
    expect(JSON.stringify(result)).not.toMatch(/Private question|secret command|private plan/);
    expect(ready).toHaveBeenCalledWith({ method: 'read', params: { id: taskId, limit: 1, activate: false } });
    expect(follow).toHaveBeenCalledWith(taskId, false); expect(appTool).not.toHaveBeenCalled();
  } finally { desktop.close(); }
});

it('keeps a running desktop stream observed after the phone closes, including a question with no file change', async () => {
  const desktop = new CodexDesktop('unused'), taskId = randomUUID(), changed = vi.fn(); desktop.onChange = changed;
  vi.spyOn(desktop as any, 'ready').mockResolvedValue(undefined); vi.spyOn(desktop as any, 'follow').mockResolvedValue(undefined);
  const followed = { id: taskId, owner: 'desktop', revision: 1, state: { id: taskId, turns: [{ turnId: 'turn', status: 'inProgress', items: [] }] } };
  Reflect.set(desktop, 'current', followed); (desktop as any).followed.set(taskId, followed);
  try {
    expect((await desktop.notificationSnapshot(taskId)).requestIds).toEqual([]);
    desktop.setSubscriptions([]); expect((desktop as any).followed.has(taskId)).toBe(true);
    (desktop as any).onBroadcast({ method: 'thread-stream-state-changed', sourceClientId: 'desktop', params: { hostId: 'local', conversationId: taskId, change: { type: 'snapshot', revision: 2, conversationState: { ...followed.state, requests: [{ id: 'input', method: 'item/tool/requestUserInput', params: { questions: [] } }] } } } });
    expect(changed).toHaveBeenCalledWith(taskId);
    expect((await desktop.notificationSnapshot(taskId)).requestIds).toEqual(['input']);
  } finally { desktop.close(); }
});
