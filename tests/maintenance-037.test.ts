import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { Agent } from '../src/agent/agent.js';
import { AgentStore } from '../src/agent/store.js';
import { CompletionMonitor } from '../src/agent/notifications.js';
import { UploadStore } from '../src/agent/uploads.js';
import { CodexDesktop, normalizeSnapshot } from '../src/agent/desktop.js';
import { DesktopActivity } from '../src/agent/activity.js';
import { HelperUpdater } from '../src/agent/updater.js';
import { sign } from 'node:crypto';
import { NativeIpc } from '../src/agent/ipc.js';
import { compactJson } from '../src/agent/compact-json.js';

const cleanup: (() => void | Promise<void>)[] = [];
function dir() { const d = mkdtempSync(resolve('.runtime/maintenance-037-')); cleanup.push(() => rmSync(d, { recursive: true, force: true })); return d; }
afterEach(async () => { for (const cb of cleanup.splice(0).reverse()) await cb(); vi.restoreAllMocks(); });

it('Regression: an authenticated viewer cannot send activate=true through the read-only authorization path', async () => {
  const execute = vi.fn().mockResolvedValue({ id: randomUUID(), messages: [], requests: [], queued: [] });
  const agent = new Agent({ dir: dir(), origin: 'https://fixture.invalid', adapter: { execute, close() {} } as any });
  cleanup.push(() => agent.close());
  const p = agent as any, sessionId = randomUUID(), taskId = randomUUID();
  p.enabled = true; p.grants.set(sessionId, Date.now() + 60000); p.client = { capabilities: ['history-pages'], available: true }; p.control = undefined;
  const authorize = vi.spyOn(p, 'authorizeControl');
  await p.message(JSON.stringify({ type: 'command', id: randomUUID(), sessionId, clientId: randomUUID(), command: { method: 'read', params: { id: taskId, activate: true } } }));
  await p.queue;
  expect(authorize).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
});
it('Regression: the safety-status response retains only safe pending approval fields', async () => {
  const desktop = new CodexDesktop('unused', dir()); cleanup.push(() => desktop.close());
  const snapshot = { id: randomUUID(), epoch: 'epoch', busy: true, turnId: 'turn', requests: [{ id: 'approval', kind: 'command' }] };
  vi.spyOn(desktop as any, 'ready').mockResolvedValue(undefined); vi.spyOn(desktop as any, 'follow').mockResolvedValue(undefined);
  vi.spyOn(desktop as any, 'snapshot').mockReturnValue(snapshot);
  const result = await desktop.execute({ method: 'safety.status', params: { id: snapshot.id } }, randomUUID());
  expect(result.requests).toEqual([{ id: 'approval', kind: 'command', title: undefined, detail: '' }]);
});
it('Regression: a single long final answer is retained in ordered chunks with hasMore=false', () => {
  const text = 'x'.repeat(64000) + 'IMPORTANT END';
  const snap = normalizeSnapshot({ id: randomUUID(), turns: [{ turnId: 'turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text, phase: 'final' }] }], requests: [] }, 'epoch');
  expect(snap.messages.map(m => m.text).join('')).toBe(text); expect(snap.hasMore).toBe(false);
});
it('Regression: a large split task_complete record is captured exactly once', async () => {
  const d = dir(), store = new AgentStore(d); cleanup.push(() => store.close());
  const id = randomUUID(), path = join(d, 'task.jsonl'), monitor = new CompletionMonitor(store, () => [{ id, path }]); cleanup.push(() => monitor.close());
  monitor.watch(id, Date.now() - 1000);
  const line = JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'terminal', last_agent_message: 'x'.repeat(1200000) } }) + '\n';
  writeFileSync(path, line.slice(0, 1100000)); await monitor.poll();
  appendFileSync(path, line.slice(1100000)); await monitor.poll(); await monitor.poll();
  expect(store.notificationOutbox()).toHaveLength(1); expect(store.notificationCursor(path)?.offset).toBe(Buffer.byteLength(line));
});
it('Regression: a corrupt chat upload resets offset so retry retransmits', async () => {
  const d = dir(), db = new DatabaseSync(':memory:'); cleanup.push(() => db.close());
  const uploads = new UploadStore(d, db), id = randomUUID(), good = Buffer.from('correct'), wrong = Buffer.from('corrupt');
  uploads.begin(id, 'owner', { id: randomUUID(), name: 'fixture.txt', size: good.length, sha256: createHash('sha256').update(good).digest('hex'), mediaType: 'text/plain' });
  uploads.write(id, 'owner', 0, wrong);
  await expect(uploads.complete(id, 'owner')).rejects.toMatchObject({ code: 'UPLOAD_CORRUPT' });
  expect(uploads.status(id, 'owner')).toMatchObject({ offset: 0, ready: false }); uploads.write(id, 'owner', 0, good); await uploads.complete(id, 'owner'); expect(uploads.status(id, 'owner').ready).toBe(true);
});
it('Regression: monitoring a bounded backlog yields to event-loop scheduling', async () => {
  const d = dir(), store = new AgentStore(d); cleanup.push(() => store.close());
  const sources: { id: string; path: string }[] = [];
  // Only local synthetic logs, 120 MiB total; no task or user data.
  const line = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1024 * 1024 - 100) } }) + '\n';
  for (let i = 0; i < 120; i++) { const source = { id: randomUUID(), path: join(d, `${i}.jsonl`) }; writeFileSync(source.path, line); sources.push(source); }
  const monitor = new CompletionMonitor(store, () => sources); cleanup.push(() => monitor.close());
  for (const source of sources) monitor.watch(source.id, Date.now() - 1000);
  let fired = false; const start = performance.now(); const timer = setTimeout(() => { fired = true; }, 0);
  await monitor.poll(); const duration = performance.now() - start; clearTimeout(timer);
  console.log('A05 local monitor blocked timer for ms=', Math.round(duration));
  expect(fired).toBe(true);
});

it('Regression: a complete terminal record larger than the activity tail preserves the new completion identity', async () => {
  const d = dir(), file = join(d, 'task.jsonl'), activity = new DesktopActivity(d);
  writeFileSync(file, JSON.stringify({ timestamp: 'first', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'first' } }) + '\n');
  expect(activity.read(file).completionId).toBe('first:first');
  appendFileSync(file, JSON.stringify({ timestamp: 'second', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'second', last_agent_message: 'x'.repeat(2100000) } }) + '\n');
  expect((await activity.readAsync(file)).completionId).toBe('second:second');
});

it('Regression: downloaded update is advertised ready while pending telemetry does not prevent the installation safety check', async () => {
  const d = dir(), store = new AgentStore(d); cleanup.push(() => store.close());
const envelope = (version: string, sequence: number) => { const bytes = Buffer.from(version); const sha256 = createHash('sha256').update(bytes).digest('hex'); return { version, sequence, platform: 'win32-x64', size: bytes.length, sha256, path: '/api/updates/download/' + sha256, notes: 'fixture', issuedAt: Date.now() }; };
  let resolve!: (value: Response) => void; const report = new Promise<Response>(r => resolve = r);
  const request = vi.fn(async (path: string) => path.includes('/check') ? Response.json({ current: envelope('0.4.36', 36), release: envelope('0.4.37', 37) }) : path.endsWith('/result') ? report : new Response(path.includes(createHash('sha256').update('0.4.36').digest('hex')) ? '0.4.36' : '0.4.37', { headers: { 'Content-Length': '6' } }));
  const updater = new HelperUpdater({ dir: d, root: d, version: '0.4.36', store, request, blockers: async () => ['fixture pending approval'], freeze: () => {} }); cleanup.push(() => updater.close());
  const checking = updater.check();
  await vi.waitFor(() => expect(updater.state).toMatchObject({ phase: 'ready', progress: 100 }));
  await checking; await expect(updater.install()).rejects.toMatchObject({ code: 'UPDATE_BLOCKED' });
  resolve(Response.json({})); await checking;
});

it('Regression: a fragmented valid history response uses linear buffering', () => {
  const ipc = new NativeIpc(); cleanup.push(() => ipc.close());
  const payload = Buffer.from(JSON.stringify({ type: 'broadcast', method: 'fixture', params: { text: 'x'.repeat(8 * 1024 * 1024) } }));
  const header = Buffer.alloc(4); header.writeUInt32LE(payload.length); const bytes = Buffer.concat([header, payload]);
  const received = vi.fn(); ipc.on('broadcast', received);
  const concat = Buffer.concat; let copied = 0;
  vi.spyOn(Buffer, 'concat').mockImplementation((chunks, length) => { copied += chunks.reduce((n, chunk) => n + chunk.length, 0); return concat(chunks, length); });
  for (let offset = 0; offset < bytes.length; offset += 16384) (ipc as any).read(bytes.subarray(offset, offset + 16384));
  expect(received).toHaveBeenCalledOnce(); expect(copied).toBeLessThan(payload.length * 2);
  console.log('A09 buffer-copy bytes=', copied, 'payload bytes=', payload.length);
});

it('oversized native history streams output away and preserves subsequent snapshot ordering', async () => {
  const desktop = new CodexDesktop('unused', dir()); cleanup.push(() => desktop.close()); const p = desktop as any, id = randomUUID();
  const state = { id, turns: [{ turnId: 'finished', status: 'completed', items: [{ id: 'tool', type: 'commandExecution', command: 'fixture', aggregatedOutput: 'x'.repeat(65 * 1024 * 1024) }, { id: 'answer', type: 'agentMessage', text: 'visible conclusion', phase: 'final' }] }], requests: [] };
  const frame = (change: any) => { const bytes = Buffer.from(JSON.stringify({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'fixture-owner', params: { hostId: 'local', conversationId: id, change } })); const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); return Buffer.concat([header, bytes]); };
  const bytes = frame({ type: 'snapshot', conversationState: state, revision: 1 });
  vi.spyOn(p, 'known').mockImplementation(() => {}); vi.spyOn(p.ipc, 'request').mockResolvedValue({ handledByClientId: 'fixture-owner' });
  vi.spyOn(p, 'requestSnapshot').mockImplementation(() => { for (let offset = 0; offset < bytes.length; offset += 16384) p.ipc.read(bytes.subarray(offset, offset + 16384)); p.ipc.read(frame({ type: 'snapshot', conversationState: { ...state, turns: [] }, revision: 2 })); });
  await p.follow(id); expect(p.followed.get(id).revision).toBe(2); expect(p.followed.get(id).state.turns).toEqual([]);
});

it('retains every part of a long message across bounded history pages', () => {
  const text = '# Conclusion\n\n' + 'content '.repeat(200000) + '\nImportant final paragraph';
  const state = { id: randomUUID(), turns: [{ turnId: 'turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text, phase: 'final' }] }], requests: [] };
  let page = normalizeSnapshot(state, 'epoch', 20); let messages = page.messages;
  while (page.hasMore) { page = normalizeSnapshot(state, 'epoch', 20, undefined, page.historyCursor); messages = [...page.messages, ...messages]; }
  expect(new Set(messages.map(m => m.id)).size).toBe(messages.length); expect(messages.map(m => m.text).join('')).toBe(text);
});
it('skips a malformed large line without losing the following completion across restart', async () => {
  const d = dir(), store = new AgentStore(d); cleanup.push(() => store.close()); const id = randomUUID(), path = join(d, 'broken.jsonl');
  writeFileSync(path, '{"broken":' + 'x'.repeat(4200000) + '\n' + JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'after-bad-line' } }) + '\n');
  const monitor = new CompletionMonitor(store, () => [{ id, path }]); monitor.watch(id, Date.now() - 1000); await monitor.poll(); monitor.close();
  const restored = new CompletionMonitor(store, () => [{ id, path }]); cleanup.push(() => restored.close()); await restored.poll(); await restored.poll();
  expect(store.notificationOutbox().map(e => e.turnId)).toEqual(['after-bad-line']);
});
it('streaming JSON preserves fragmented UTF-8 while enforcing retained size, depth and unsafe-key limits', () => {
  const parse = (text: string, limit = 1024) => { let result: any, error: Error | undefined; const p = compactJson(/^discard$/, limit, value => result = value, reason => error = reason); const bytes = Buffer.from(text); for (const byte of bytes) p.write(Buffer.from([byte])); p.end(); return { result, error }; };
  expect(parse(JSON.stringify({ title: '照片', discard: 'x'.repeat(10000) })).result).toEqual({ title: '照片' });
  expect(parse(JSON.stringify({ keep: 'x'.repeat(10000) })).error).toBeInstanceOf(Error);
  expect(parse('{"__proto__":{"polluted":true}}').error).toBeInstanceOf(Error);
  expect(parse('['.repeat(130) + '0' + ']'.repeat(130)).error).toBeInstanceOf(Error);
});
