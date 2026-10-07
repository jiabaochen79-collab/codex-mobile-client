import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AgentStore } from '../src/agent/store.js';
import { CompletionMonitor } from '../src/agent/notifications.js';
import { ConversationImages } from '../src/agent/images.js';
import { DesktopActivity } from '../src/agent/activity.js';
import { HelperUpdater } from '../src/agent/updater.js';
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function directory() { const dir = mkdtempSync(resolve('.runtime/fixes-040-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
it('B18 applies the corrected clock offset on the first rejected-time retry', () => {
  const dir = directory(), store = new AgentStore(dir); cleanup.push(() => store.close());
  const origin = 'https://fixture.invalid', now = Date.now(), id = randomUUID(); store.syncNotificationClock(origin, now, now);
  store.recordNotification({ eventId: id, taskId: randomUUID(), turnId: randomUUID(), status: 'completed', occurredAt: now + 600000, protocolVersion: 1 }, { path: join(dir, 'fixture.jsonl'), offset: 0, size: 0, mtime: now, fileId: '', baselineAt: now, remainder: '' });
  expect(store.rejectNotificationTime(id, store.notificationTime(id, origin)!)).toBe(true);
  store.syncNotificationClock(origin, now, now + 600000, id); expect(store.notificationTime(id, origin)).toBe(now);
});
it('B19 bounds retained inline image sources separately from the encoded cache', () => {
  const images: any = new ConversationImages(), id = randomUUID(); images.begin(id, true);
  for (let i = 0; i < 80; i++) { expect(images.register(id, 'data:image/png;base64,' + Buffer.alloc(1024 * 1024, i).toString('base64'), 'fixture')).toBeDefined(); images.begin(id, true); }
  const retained = [...images.threads.get(id).values()].reduce((n, row: any) => n + Buffer.byteLength(row.value), 0);
  expect(retained).toBeLessThanOrEqual(64 * 1024 * 1024); expect(images.cacheBytes).toBe(0);
  images.clear(); expect(images.sourceBytes).toBe(0);
});
it('B20 continues monitoring an archived task outside the first two hundred watches', async () => {
  const dir = directory(), store = new AgentStore(dir); cleanup.push(() => store.close());
  const id = randomUUID(), file = join(dir, 'archived.jsonl'), now = Date.now();
  const monitor = new CompletionMonitor(store, ids => ids?.includes(id) ? [{ id, path: file }] : []); cleanup.push(() => monitor.close());
  writeFileSync(file, ''); monitor.watch(id, now - 10000); await monitor.poll();
  for (let i = 0; i < 200; i++) monitor.watch(randomUUID(), now - 5000 + i);
  writeFileSync(file, JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'old-watch' } }) + '\n');
  await monitor.poll(); await monitor.poll(); expect(store.notificationOutbox().map(row => row.turnId)).toEqual(['old-watch']);
});
it('B08 detects a large terminal followed by another valid JSONL record', () => {
  const dir = directory(), file = join(dir, 'rollout.jsonl'), activity = new DesktopActivity(dir);
  const record = (turn: string, text = '') => JSON.stringify({ timestamp: '2026-10-07T00:00:00Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, last_agent_message: text } }) + '\n';
  writeFileSync(file, record('old')); expect(activity.read(file).completionId).toContain('old');
  writeFileSync(file, record('old') + record('new', 'x'.repeat(3 * 1024 * 1024)) + JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }) + '\n');
  expect(activity.read(file).completionId).toContain('new');
});
it('B07 restores an active installation freeze before allowing update checks', async () => {
  const dir = directory(); mkdirSync(join(dir, 'updates')); writeFileSync(join(dir, 'updates/result.json'), JSON.stringify({ phase: 'installing', version: '0.4.40', installerRunning: true }));
  let frozen = false, checks = 0;
  const updater = new HelperUpdater({ dir, root: dir, version: '0.4.39', store: { get: () => null, set() {} } as any, blockers: async () => [], freeze: value => frozen = value, request: async () => { checks++; return new Response(JSON.stringify({ release: null, current: null, rollback: null })); } }); cleanup.push(() => updater.close());
  await updater.reportPrevious(); await updater.check(); expect(updater.state.phase).toBe('installing'); expect(frozen).toBe(true); expect(checks).toBe(0);
  writeFileSync(join(dir, 'updates/result.json'), JSON.stringify({ phase: 'installed', version: '0.4.40', installerRunning: false }));
  await updater.reportPrevious(); expect(frozen).toBe(false); await updater.check(); expect(updater.state.phase).toBe('idle');
});
