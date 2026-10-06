import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Agent } from '../src/agent/agent.js';
import { AgentStore } from '../src/agent/store.js';
import { UploadStore } from '../src/agent/uploads.js';
import { CompletionMonitor } from '../src/agent/notifications.js';
import { CodexDesktop } from '../src/agent/desktop.js';
import { NativeIpc } from '../src/agent/ipc.js';
import { RemoteError, commandSchema, type Command } from '../src/shared/protocol.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-audit-regression-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function fixture() {
  const dir = directory(), sessionId = randomUUID(), clientId = randomUUID(), epoch = randomUUID(), taskId = randomUUID();
  const execute = vi.fn(async (_command: Command, _id: string, authorize?: () => void) => { authorize?.(); return { accepted: true }; });
  const agent = new Agent({ origin: 'http://127.0.0.1:8790', dir, adapter: { execute, close() {}, status: async () => ({ available: true, version: null, reason: null }) } });
  const state = agent as any;
  cleanups.push(() => agent.close());
  vi.spyOn(state.store, 'protect').mockImplementation((value: any) => value);
  state.enabled = true; state.connection = 'online'; state.client = { available: true };
  state.grants.set(sessionId, Date.now() + 60000);
  state.control = { sessionId, clientId, epoch, expires: Date.now() + 60000 };
  state.notifyQueue = vi.fn(); state.updateSubscriptions = vi.fn();
  vi.spyOn(state.sends, 'pause');
  const frames: any[] = []; state.send = (frame: any) => frames.push(frame);
  const submit = async (command: Command, id = randomUUID()) => {
    await state.message(JSON.stringify({ type: 'command', id, sessionId, clientId, controlEpoch: epoch, command }));
    return id;
  };
  const stop: Command = { method: 'stop', params: { id: taskId, epoch: 'fixture', turnId: 'turn' } };
  return { agent, state, dir, sessionId, taskId, execute, frames, submit, stop };
}
async function attachment(f: ReturnType<typeof fixture>) {
  const id = randomUUID(), bytes = Buffer.from('fixture document');
  f.state.uploads.begin(id, f.sessionId, { id: f.taskId, name: 'fixture.txt', size: bytes.length, mediaType: 'text/plain', sha256: createHash('sha256').update(bytes).digest('hex') });
  f.state.uploads.write(id, f.sessionId, 0, bytes); await f.state.uploads.complete(id, f.sessionId);
  return id;
}

describe('B10: bounded safety admission', () => {
  it('admits an authorized stop ahead of 16 ordinary requests and bounds the reserved lane', async () => {
    const f = fixture(), gate = deferred<void>(), entered = deferred<void>();
    f.execute.mockImplementation(async (command, _id, authorize) => {
      if (f.execute.mock.calls.length === 1) { entered.resolve(); await gate.promise; }
      authorize?.(); return { accepted: true };
    });
    await f.submit({ method: 'models', params: {} }); await entered.promise;
    for (let i = 0; i < 15; i++) await f.submit({ method: 'models', params: {} });
    const overflow = await f.submit({ method: 'models', params: {} });
    const stopId = await f.submit(f.stop);
    for (let i = 0; i < 5; i++) await f.submit({ method: 'safety.status', params: { id: f.taskId } });
    const safetyOverflow = await f.submit(f.stop);
    try {
      expect(f.frames.find(r => r.id === overflow)?.error.code).toBe('BUSY');
      expect(f.frames.some(r => r.id === stopId)).toBe(false);
      expect(f.frames.find(r => r.id === safetyOverflow)?.error.code).toBe('BUSY');
    } finally { gate.resolve(); await f.state.queue; }
    expect(f.execute.mock.calls[1][0].method).toBe('stop');
    expect(f.frames.find(r => r.id === stopId)?.result).toEqual({ accepted: true });
    expect(f.state.queued).toBe(0); expect(f.state.safetyQueued).toBe(0);
  });
  it.each(['AUTH', 'CONTROL_LOST', 'UNSUPPORTED'])('does not bypass %s when ordinary capacity is exhausted', async code => {
    const f = fixture(); f.state.queued = 16;
    if (code === 'AUTH') f.state.grants.delete(f.sessionId);
    if (code === 'CONTROL_LOST') f.state.control = undefined;
    if (code === 'UNSUPPORTED') f.state.client.capabilities = ['compatibility-checked'];
    const id = await f.submit(f.stop); await f.state.queue;
    expect(f.frames.find(r => r.id === id)?.error.code).toBe(code); expect(f.execute).not.toHaveBeenCalled();
    if (code !== 'UNSUPPORTED') expect(f.state.sends.pause).not.toHaveBeenCalled();
  });
  it('rechecks revocation before a queued safety command executes', async () => {
    const f = fixture(), gate = deferred<void>(); f.state.queue = gate.promise; f.state.queued = 16;
    const id = await f.submit(f.stop); f.state.grants.delete(f.sessionId); gate.resolve(); await f.state.queue;
    expect(f.frames.find(r => r.id === id)?.error.code).toBe('AUTH'); expect(f.execute).not.toHaveBeenCalled();
  });
  it('keeps safety stops available after subscription expiry', async () => {
    const f = fixture(); f.state.queued = 16; f.state.subscription = { access: false };
    const id = await f.submit(f.stop); await f.state.queue;
    expect(f.frames.find(r => r.id === id)?.result).toEqual({ accepted: true }); expect(f.execute).toHaveBeenCalledOnce();
  });
});

describe('A03: native acceptance and attachment retention', () => {
  it.each(['CLIENT_REJECTED', 'BUSY', 'CLIENT_DENIED'])('keeps an explicitly %s send removable without repeating it', async code => {
    const f = fixture(), id = await attachment(f), requestId = randomUUID();
    f.execute.mockImplementation(async (_command, _id, authorize) => { authorize?.(); throw new RemoteError(code, 'fixture rejection'); });
    const command: Command = { method: 'send', params: { id: f.taskId, epoch: 'fixture', text: 'fixture', attachmentIds: [id] } };
    await f.submit(command, requestId); await f.state.queue;
    expect(f.frames[0].error.code).toBe(code);
    expect(f.state.uploads.remove(id, f.sessionId)).toEqual({ removed: true });
    expect(f.state.store.db.prepare('SELECT count(*) AS n FROM upload_holds').get().n).toBe(0);
    await f.submit(command, requestId); await f.state.queue; expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it.each(['OUTCOME_UNKNOWN', 'INTERNAL', 'exception'])('retains attachments and refuses replay after %s', async code => {
    const f = fixture(), id = await attachment(f), requestId = randomUUID();
    f.execute.mockImplementation(async (_command, _id, authorize) => { authorize?.(); throw code === 'exception' ? new Error('lost acknowledgement') : new RemoteError(code, 'lost acknowledgement'); });
    const command: Command = { method: 'send', params: { id: f.taskId, epoch: 'fixture', text: 'fixture', attachmentIds: [id] } };
    await f.submit(command, requestId); await f.state.queue;
    expect(() => f.state.uploads.remove(id, f.sessionId)).toThrow();
    expect(f.state.store.commandStatus(requestId, f.sessionId, f.taskId)).toEqual({ state: 'unknown' });
    await f.submit(command, requestId); await f.state.queue; expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('holds in-flight attachments, then commits only after native success', async () => {
    const f = fixture(), id = await attachment(f), gate = deferred<void>(), entered = deferred<void>();
    f.execute.mockImplementation(async (_command, _id, authorize) => { authorize?.(); entered.resolve(); await gate.promise; return { accepted: true }; });
    await f.submit({ method: 'send', params: { id: f.taskId, epoch: 'fixture', text: 'fixture', attachmentIds: [id] } }); await entered.promise;
    try {
      expect(f.state.store.db.prepare('SELECT committed FROM uploads WHERE id=?').get(id).committed).toBe(0);
      expect(() => f.state.uploads.remove(id, f.sessionId)).toThrow();
      f.state.store.db.prepare('UPDATE uploads SET created=? WHERE id=?').run(Date.now() - 2 * 86400000, id);
      f.state.uploads.cleanup(); expect(existsSync(f.state.uploads.resolve([id], f.sessionId, f.taskId)[0].path)).toBe(true);
    } finally { gate.resolve(); await f.state.queue; }
    expect(f.state.store.db.prepare('SELECT committed FROM uploads WHERE id=?').get(id).committed).toBe(1);
    expect(f.state.store.db.prepare('SELECT count(*) AS n FROM upload_holds').get().n).toBe(0);
  });
  it('preserves durable in-flight holds and refuses an unconfirmed command after reopening the store', async () => {
    const f = fixture(), id = await attachment(f), requestId = randomUUID(), gate = deferred<void>(), entered = deferred<void>();
    f.execute.mockImplementation(async (_command, _id, authorize) => { authorize?.(); entered.resolve(); await gate.promise; return { accepted: true }; });
    const command: Command = { method: 'send', params: { id: f.taskId, epoch: 'fixture', text: 'fixture', attachmentIds: [id] } };
    await f.submit(command, requestId); await entered.promise;
    let reopened: AgentStore | undefined;
    try {
      f.state.store.db.prepare('UPDATE uploads SET created=? WHERE id=?').run(Date.now() - 2 * 86400000, id);
      reopened = new AgentStore(f.dir); const uploads = new UploadStore(f.dir, reopened.db), perform = vi.fn();
      expect(uploads.status(id, f.sessionId).ready).toBe(true);
      expect(() => uploads.remove(id, f.sessionId)).toThrow();
      await expect(reopened.once(requestId, commandSchema.parse(command), perform, f.sessionId)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
      expect(perform).not.toHaveBeenCalled();
    } finally { reopened?.close(); gate.resolve(); await f.state.queue; }
  });
  it('releases an attachment after the actual desktop adapter receives a native rejection', async () => {
    const f = fixture(), id = await attachment(f), desktop = new CodexDesktop('unused', f.dir);
    cleanups.push(() => desktop.close()); f.state.options.adapter = desktop;
    vi.spyOn(desktop as any, 'ready').mockResolvedValue(undefined); vi.spyOn(desktop as any, 'follow').mockResolvedValue(undefined);
    vi.spyOn(desktop as any, 'snapshot').mockReturnValue({ id: f.taskId, epoch: 'fixture', busy: false, messages: [], requests: [] });
    (desktop as any).current = { id: f.taskId, owner: 'fixture', state: {} };
    const native = vi.spyOn(NativeIpc.prototype, 'request').mockResolvedValue({ resultType: 'error' });
    const requestId = await f.submit({ method: 'send', params: { id: f.taskId, epoch: 'fixture', text: 'fixture', attachmentIds: [id] } }); await f.state.queue;
    expect(f.frames.find(frame => frame.id === requestId)?.error.code).toBe('CLIENT_REJECTED');
    expect(native).toHaveBeenCalledOnce(); expect(f.state.uploads.remove(id, f.sessionId)).toEqual({ removed: true });
  });
  it('rechecks authorization at native dispatch without retaining an unattempted attachment', async () => {
    const f = fixture(), id = await attachment(f), gate = deferred<void>(), entered = deferred<void>();
    f.execute.mockImplementation(async (_command, _id, authorize) => { entered.resolve(); await gate.promise; authorize?.(); return { accepted: true }; });
    const requestId = await f.submit({ method: 'send', params: { id: f.taskId, epoch: 'fixture', text: 'fixture', attachmentIds: [id] } }); await entered.promise;
    f.state.grants.delete(f.sessionId); gate.resolve(); await f.state.queue;
    expect(f.frames.find(frame => frame.id === requestId)?.error.code).toBe('AUTH');
    expect(f.state.uploads.remove(id, f.sessionId)).toEqual({ removed: true });
    expect(f.state.store.db.prepare('SELECT count(*) AS n FROM upload_holds').get().n).toBe(0);
  });
  it.each(['CLIENT_REJECTED', 'OUTCOME_UNKNOWN', 'INTERNAL'])('applies %s semantics to durable queued attachments', async code => {
    const f = fixture(), id = await attachment(f);
    f.state.queueAuthorization = async () => ({ allowed: true, validForMs: 10000 });
    f.execute.mockImplementation(async (command, _id, authorize) => {
      if (command.method === 'read') return { id: f.taskId, epoch: 'fixture', busy: false, requests: [], nativeQueuedCount: 0 } as any;
      authorize?.(); throw new RemoteError(code, 'fixture native outcome');
    });
    const row = f.state.sends.add(randomUUID(), f.taskId, f.sessionId, 'fixture', { text: 'queued', attachments: [{ id, name: 'fixture.txt' }] });
    await f.state.dispatchQueued(row);
    expect(f.state.sends.get(row.id, f.taskId).state).toBe(code === 'CLIENT_REJECTED' ? 'paused' : 'uncertain');
    await f.state.dispatchQueued(f.state.sends.get(row.id, f.taskId));
    expect(f.execute.mock.calls.filter(([command]) => command.method === 'send')).toHaveLength(1);
    f.state.sends.remove(row.id, f.taskId);
    if (code === 'CLIENT_REJECTED') expect(f.state.uploads.remove(id, f.sessionId)).toEqual({ removed: true });
    else expect(() => f.state.uploads.remove(id, f.sessionId)).toThrow();
  });
});

describe('A01/A05: durable notification identity and clock rejection', () => {
  it('uses distinct stable identities for copied task histories on two installations', async () => {
    const taskId = randomUUID(), now = Date.now(), event = JSON.stringify({ type: 'event_msg', timestamp: new Date(now).toISOString(), payload: { type: 'task_complete', turn_id: 'copied-turn' } }) + '\n';
    const ids: string[] = [];
    for (const root of [directory(), directory()]) {
      let store = new AgentStore(root); cleanups.push(() => store.close());
      const path = join(directory(), 'copied.jsonl'); writeFileSync(path, event);
      let monitor = new CompletionMonitor(store, () => [{ id: taskId, path }]); monitor.watch(taskId, now - 1000); await monitor.poll(); monitor.close();
      ids.push(store.notificationOutbox()[0].eventId);
      store.close(); store = new AgentStore(root);
      store.db.prepare('DELETE FROM notification_cursors').run();
      monitor = new CompletionMonitor(store, () => [{ id: taskId, path }]); await monitor.poll(); monitor.close();
      expect(store.notificationOutbox()).toHaveLength(1); expect(store.notificationOutbox()[0].eventId).toBe(ids.at(-1));
    }
    expect(ids[0]).not.toBe(ids[1]);
  });
  it('does not resend a legacy outbox round after adopting the new namespace', async () => {
    const store = new AgentStore(directory()); cleanups.push(() => store.close());
    const taskId = randomUUID(), now = Date.now(), file = join(directory(), 'rollout.jsonl'), cursor = { path: file, offset: 0, mtime: 0, size: 0, fileId: '', baselineAt: now - 1000, remainder: '' };
    const eventId = createHash('sha256').update(`${taskId}\0legacy-turn\0completed`).digest('hex');
    store.recordNotification({ eventId, taskId, turnId: 'legacy-turn', status: 'completed', occurredAt: now, protocolVersion: 1 }, cursor); store.ackNotification(eventId);
    writeFileSync(file, JSON.stringify({ type: 'event_msg', timestamp: new Date(now).toISOString(), payload: { type: 'task_complete', turn_id: 'legacy-turn' } }) + '\n');
    const monitor = new CompletionMonitor(store, () => [{ id: taskId, path: file }]); await monitor.poll(); monitor.close();
    expect(store.notificationOutbox()).toEqual([]);
    expect(store.db.prepare('SELECT count(*) AS n FROM notification_outbox').get()!.n).toBe(1);
  });
  it('corrects only a definitively rejected matching timestamp and preserves accepted or ambiguous events', async () => {
    const f = fixture(), now = Date.now(), eventId = 'a'.repeat(64), cursor = { path: 'fixture', offset: 0, mtime: 0, size: 0, fileId: 'fixture', baselineAt: 0, remainder: '' };
    f.state.store.recordNotification({ eventId, taskId: f.taskId, turnId: 'fixture', status: 'completed', occurredAt: now + 3600000, protocolVersion: 1 }, cursor);
    f.state.store.syncNotificationClock(f.agent.origin, now, now);
    const rejectedAt = f.state.store.notificationTime(eventId, f.agent.origin);
    vi.spyOn(Date, 'now').mockReturnValue(now + 3600000);
    await f.state.message(JSON.stringify({ type: 'notification-ack', eventId, accepted: false }));
    f.state.store.syncNotificationClock(f.agent.origin, now);
    expect(f.state.store.notificationTime(eventId, f.agent.origin)).toBe(rejectedAt);
    await f.state.message(JSON.stringify({ type: 'notification-ack', eventId, accepted: false, errorCode: 'NOTIFICATION_TIME', occurredAt: rejectedAt, serverTime: now }));
    expect(f.state.store.notificationTime(eventId, f.agent.origin)).toBe(now);
    await f.state.message(JSON.stringify({ type: 'notification-ack', eventId, accepted: false, errorCode: 'NOTIFICATION_TIME', occurredAt: rejectedAt, serverTime: now - 1000 }));
    expect(f.state.store.notificationTime(eventId, f.agent.origin)).toBe(now);
    await f.state.message(JSON.stringify({ type: 'notification-ack', eventId, accepted: true }));
    await f.state.message(JSON.stringify({ type: 'notification-ack', eventId, accepted: false, errorCode: 'NOTIFICATION_TIME', occurredAt: now, serverTime: now - 1000 }));
    expect(f.state.store.notificationTime(eventId, f.agent.origin)).toBe(now); expect(f.state.store.notificationOutbox()).toEqual([]);
  });
});

describe('A06: completion revalidation after runtime lookup', () => {
  it.each([false, true])('does not clear a newer completion (new live turn: %s)', async running => {
    const root = directory(), taskId = randomUUID(), file = join(root, 'rollout.jsonl');
    const line = (turn: string) => JSON.stringify({ type: 'event_msg', timestamp: '2026-10-06T04:00:00Z', payload: { type: 'task_complete', turn_id: turn } }) + '\n';
    writeFileSync(file, line('old-turn'));
    writeFileSync(join(root, '.codex-global-state.json'), JSON.stringify({ 'electron-persisted-atom-state': { 'unread-thread-ids-by-host-v1': { local: [taskId] } } }));
    const db = new DatabaseSync(join(root, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT, rollout_path TEXT, archived INTEGER, source TEXT)'); db.prepare('INSERT INTO threads VALUES(?,?,0,?)').run(taskId, file, 'vscode'); db.close();
    const desktop = new CodexDesktop('unused', root), state = desktop as any; cleanups.push(() => desktop.close());
    vi.spyOn(state, 'ready').mockResolvedValue(undefined);
    const gate = deferred<Map<string, boolean>>(), entered = deferred<void>();
    vi.spyOn(state.runtimeActivity, 'read').mockImplementation(async () => { entered.resolve(); return gate.promise; });
    const broadcast = vi.spyOn(NativeIpc.prototype, 'broadcast').mockImplementation(() => {}), changed = vi.fn(); desktop.onChange = changed;
    state.contract = { protocols: { 'thread-read-state-changed': 2 } };
    const checking = desktop.execute({ method: 'seen', params: { id: taskId, completionId: 'old-turn:2026-10-06T04:00:00Z', turnId: 'old-turn' } }, randomUUID()); await entered.promise;
    appendFileSync(file, line('new-turn')); state.activity.changed(taskId, true);
    if (running) state.followed.set(taskId, { id: taskId, owner: 'fixture', state: { threadRuntimeStatus: { type: 'active' } } });
    gate.resolve(new Map([[taskId, false]]));
    expect(await checking).toEqual({ seen: false });
    const latest = state.activity.read(file); expect(state.activity.isUnread(taskId, latest.completionId)).toBe(true);
    expect(broadcast).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
    state.followed.clear();
    await expect(desktop.execute({ method: 'seen', params: { id: taskId, completionId: latest.completionId, turnId: 'new-turn' } }, randomUUID())).resolves.toEqual({ seen: true });
    expect(state.activity.isUnread(taskId, latest.completionId)).toBe(false); expect(changed).toHaveBeenCalledOnce();
  });
});
