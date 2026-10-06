import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexDesktop, normalizeSnapshot } from '../src/agent/desktop.js';
import { Agent } from '../src/agent/agent.js';
import { AgentStore } from '../src/agent/store.js';
import { commandSchema, isSafetyCommand, RemoteError } from '../src/shared/protocol.js';
import { desktopModels } from '../src/agent/models.js';

vi.mock('../src/agent/models.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/agent/models.js')>(), desktopModels: vi.fn() }));
const cleanup: (() => void)[] = [];
afterEach(() => { for (const cb of cleanup.splice(0).reverse()) cb(); vi.restoreAllMocks(); });
function directory() { const dir = mkdtempSync(resolve('.runtime/fixes-039-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function deferred() { let resolve!: (v?: any) => void; return { promise: new Promise<any>(r => resolve = r), resolve: (v?: any) => resolve(v) }; }
it('A02 rechecks authorization after tools connect and before creating a task', async () => {
  const d: any = Object.create(CodexDesktop.prototype), entered = deferred(), gate = deferred(); let allowed = true;
  d.ready = async () => {}; d.contextId = () => randomUUID(); d.projects = async () => [{ id: 'project' }]; d.discovery = { toolsPipe: 'fixture' };
  const request = vi.fn(); d.tools = { connect: async () => { entered.resolve(); await gate.promise; }, request };
  const pending = d.execute({ method: 'create', params: { projectId: 'project', text: 'fixture' } }, randomUUID(), () => { if (!allowed) throw new RemoteError('AUTH', 'revoked'); });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'AUTH' });
  await entered.promise; allowed = false; gate.resolve(); await rejected; expect(request).not.toHaveBeenCalled();
});
it('A05 rejects a model update when desktop settings change during model lookup', async () => {
  const d: any = Object.create(CodexDesktop.prototype), entered = deferred(), gate = deferred(), task = randomUUID(); let revision = 'old';
  d.ready = async () => {}; d.follow = async () => {}; d.discovery = {}; d.current = { state: {}, owner: 'owner' };
  d.snapshot = () => ({ id: task, epoch: 'epoch', settings: { revision, model: revision, mode: 'default' } }); d.updateSettings = vi.fn();
  vi.mocked(desktopModels).mockImplementation(async () => { entered.resolve(); return gate.promise; });
  const pending = d.execute({ method: 'settings.update', params: { id: task, epoch: 'epoch', revision: 'old', model: 'chosen', effort: 'high' } }, randomUUID(), () => {});
  const rejected = expect(pending).rejects.toMatchObject({ code: 'STALE' }); await entered.promise;
  revision = 'desktop-new'; gate.resolve([{ id: 'chosen', efforts: ['high'] }]); await rejected; expect(d.updateSettings).not.toHaveBeenCalled();
});
it('A03 redacts secrets from both task and message failure reasons', () => {
  const reason = 'sk-DUMMY_AUDIT_NOT_A_REAL_KEY Bearer dummy-token Cookie: dummy-cookie password=fixture';
  const state = normalizeSnapshot({ id: randomUUID(), turns: [{ turnId: 'turn', status: 'failed', error: { message: reason }, items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'fixture' }] }] }] }, 'epoch');
  for (const value of [state.lastTurnReason, state.messages[0].turnReason]) { expect(value).not.toMatch(/DUMMY|dummy-token|dummy-cookie|password=fixture/); expect(value).toContain('[redacted]'); }
});
it('A10 retains expandable tool parameters, with a bounded detail size', () => {
  const script = 'console.log("fixture script body");';
  const snapshot = (input: unknown) => normalizeSnapshot({ id: randomUUID(), turns: [{ turnId: 'turn', status: 'completed', items: [{ id: 'tool', type: 'mcpToolCall', tool: 'js', arguments: input }] }] }, 'epoch');
  expect(JSON.parse(snapshot({ code: script }).messages[0].text.split('\n').slice(1).join('\n')).code).toBe(script);
  expect(snapshot('x'.repeat(64000)).messages[0].text.length).toBeLessThan(32100);
});
it('A07 expired subscriptions retain queue read and removal, not creation', () => {
  const id = randomUUID(); expect(isSafetyCommand({ method: 'queue.list', params: { id } })).toBe(true);
  expect(isSafetyCommand({ method: 'queue.remove', params: { id, queuedId: randomUUID() } })).toBe(true);
  expect(isSafetyCommand({ method: 'queue.add', params: { id, text: 'fixture' } } as any)).toBe(false);
});
it('A18 accepts archive continuations above ten thousand and bounds targeted lookups', () => {
  expect(commandSchema.safeParse({ method: 'list', params: { offset: 10020, cursor: randomUUID() } }).success).toBe(true);
  expect(commandSchema.safeParse({ method: 'list', params: { ids: Array.from({ length: 31 }, () => randomUUID()) } }).success).toBe(false);
});
it('A21 paused and unknown queue heads do not read the desktop', async () => {
  const a: any = Object.create(Agent.prototype), execute = vi.fn(); a.options = { adapter: { execute } };
  for (const state of ['paused','unknown']) { const entry = { id: randomUUID(), conversation: randomUUID(), state, attempt: randomUUID() }; a.sends = { get: () => entry }; for (let i = 0; i < 10; i++) await a.dispatchQueued(entry); }
  expect(execute).not.toHaveBeenCalled();
});
it('A30 prunes only missing-file cursors and retains live recovery fragments', () => {
  const dir = directory(), store = new AgentStore(dir); cleanup.push(() => store.close());
  const live = join(dir, 'live.jsonl'), missing = join(dir, 'deleted.jsonl'); writeFileSync(live, '{}\n'); writeFileSync(missing, '{}\n');
  for (const path of [live, missing]) store.saveNotificationCursor({ path, offset: 0, mtime: 0, size: 0, fileId: 'fixture', baselineAt: 1, remainder: 'b64:fragment' });
  unlinkSync(missing); store.pruneNotifications(Date.now() + 86400000);
  expect(store.notificationCursor(missing)).toBeUndefined(); expect(store.notificationCursor(live)?.remainder).toBe('b64:fragment');
});
it('A22 project responses do no synchronous history scan; background lookup is bounded and includes unknown history', async () => {
  const dir = directory(), path = join(dir, 'fixture.jsonl'); writeFileSync(path, '{}\n');
  const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT,title TEXT,cwd TEXT,updated_at_ms INTEGER,updated_at INTEGER,project_id TEXT,source TEXT,archived INTEGER,rollout_path TEXT)');
  const insert = db.prepare("INSERT INTO threads VALUES(?,'fixture','','C:/fixture',?,0,NULL,'vscode',0,?)");
  for (let i = 0; i < 1000; i++) insert.run(randomUUID(), i, path); db.close();
  const d: any = new CodexDesktop('unused', dir); cleanup.push(() => d.close()); d.ready = async () => ({}); d.contextId = () => randomUUID(); d.projects = async () => [{ id: 'project', roots: ['C:/fixture'], nativeIds: [] }];
  const read = vi.spyOn(d.activity, 'read').mockReturnValue({ pending: undefined });
  const runtime = vi.spyOn(d.runtimeActivity, 'read').mockImplementation(async (ids: unknown) => new Map((ids as string[]).map(id => [id, true])));
  const result = await d.execute({ method: 'projects', params: {} }); expect(read).not.toHaveBeenCalled(); expect(result.projects[0].running).toBeUndefined();
  await vi.waitFor(() => expect(runtime).toHaveBeenCalled()); expect(runtime.mock.calls.every(([ids]) => (ids as string[]).length <= 20)).toBe(true);
  const updated = await d.execute({ method: 'projects', params: {} }); expect(updated.projects[0].running).toBe(true);
});
