import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Agent, createLocalServer } from '../src/agent/agent.js';
import { TERMS_VERSION } from '../src/shared/subscription.js';
import { CodexDesktop, normalizeSnapshot } from '../src/agent/desktop.js';
import { NativeIpc } from '../src/agent/ipc.js';
import { randomUUID } from 'node:crypto';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cb of cleanup.splice(0).reverse()) await cb(); vi.restoreAllMocks(); });
function fixture() {
  const dir = mkdtempSync(resolve('.runtime/current-audit-agent-'));
  const agent = new Agent({ dir, origin: 'https://fixture.test', adapter: { close() {} } as any });
  (agent as any).credentials = { id: '123456789', secret: 'fixture-only' };
  cleanup.push(async () => { await agent.close(); rmSync(dir, { recursive: true, force: true }); }); return agent;
}
it('C01 desktop feedback preserves an interrupted write as retryable unknown outcome', async () => {
  const agent = fixture(); const app = await createLocalServer(agent, { port: 8791 }); cleanup.push(() => app.close());
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
  const result = await app.inject({ method: 'POST', url: '/local/feedback/uploads/11111111-1111-4111-8111-111111111111/chunks', headers: { host: '127.0.0.1:8791', authorization: 'Bearer ' + agent.localToken }, payload: { offset: 0, data: 'AQ==' } });
  expect(result.json().error.code).toBe('OUTCOME_UNKNOWN');
  expect(result.json().error.message).toContain('无需重启助手');
});
it('C02 an old HTTP subscription response cannot overwrite newer WebSocket state', async () => {
  const agent = fixture(); let finish!: (result: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(resolve => finish = resolve));
  const prior = { mode: 'licensed', status: 'active', access: true, expiresAt: Date.now() + 86400000, planId: 'month', serverTime: Date.now(), revision: 'old', termsVersion: TERMS_VERSION };
  const reading = agent.subscriptionInfo(); await vi.waitFor(() => expect(finish).toBeDefined());
  await (agent as any).message(JSON.stringify({ type: 'subscription', subscription: { ...prior, disabled: true, access: false, revision: 'new' } }));
  expect(agent.state().subscription?.disabled).toBe(true);
  finish(Response.json({ subscription: prior })); expect((await reading).subscription.disabled).toBe(true);
  expect(agent.state().subscription?.access).toBe(false); expect(agent.state().subscription?.disabled).toBe(true);
});
it('C04 native plan rejection is visible and safe to retry without caching success', async () => {
  const agent = fixture(); const turnId = randomUUID(); const id = randomUUID(); const planContent = 'Fixture plan';
  const state = { id, latestModel: 'fixture', latestCollaborationMode: { mode: 'plan', settings: { model: 'fixture', reasoning_effort: 'high' } }, threadRuntimeStatus: { type: 'idle' }, turns: [{ turnId, status: 'completed', items: [{ id: 'plan', type: 'plan', text: planContent }, { id: 'implement-plan:' + turnId, type: 'planImplementation', turnId, planContent, isCompleted: false }] }], requests: [{ id: 'implement-plan:' + turnId, method: 'item/plan/requestImplementation', params: { threadId: id, turnId, planContent } }] };
  const adapter = new CodexDesktop('unused', resolve('.runtime/current-audit-codex-home')); cleanup.push(async () => adapter.close());
  const snap = { ...normalizeSnapshot(state, 'epoch'), nativeQueuedCount: 0 };
  vi.spyOn(adapter as any, 'ready').mockResolvedValue(undefined); vi.spyOn(adapter as any, 'follow').mockResolvedValue(undefined); vi.spyOn(adapter as any, 'snapshot').mockReturnValue(snap);
  (adapter as any).current = { id, owner: 'fixture', state };
  const ipc = vi.spyOn(NativeIpc.prototype, 'request').mockResolvedValue({ resultType: 'error', error: { message: 'Native rejection' } });
  const request = snap.requests[0]; const command = { method: 'plan.respond', params: { id, epoch: 'epoch', requestId: request.id, revision: request.plan!.revision, action: 'implement' } } as any;
  const execute = () => adapter.execute(command, randomUUID()); const store = (agent as any).store;
  await expect(store.once('plan:fixture', command, execute)).rejects.toMatchObject({ code: 'CLIENT_REJECTED' });
  ipc.mockResolvedValue({ resultType: 'success' });
  expect(await store.once('plan:fixture', command, execute)).toEqual({ accepted: true });
  expect(await store.once('plan:fixture', command, execute)).toEqual({ accepted: true }); expect(ipc).toHaveBeenCalledTimes(2);
});
it('C06 unsubscribing a pending approval retains the installation blocker until resolved', async () => {
  const adapter = new CodexDesktop('unused', resolve('.runtime/current-audit-codex-home')); cleanup.push(async () => adapter.close());
  const id = randomUUID(), followed = { id, owner: 'fixture', state: { requests: [{ id: 'approval', method: 'item/commandExecution/requestApproval' }] } };
  (adapter as any).followed.set(id, followed);
  expect(await adapter.updateBlockers()).toEqual(['有待处理的审批或计划确认']);
  adapter.setSubscriptions([]); expect(followed.state.requests).toHaveLength(1); expect(await adapter.updateBlockers()).toEqual(['有待处理的审批或计划确认']);
  followed.state.requests = []; adapter.setSubscriptions([]); expect(await adapter.updateBlockers()).toEqual([]);
});
