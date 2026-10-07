import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentStore } from '../src/agent/store.js';
import { CompletionMonitor } from '../src/agent/notifications.js';
import { CodexDesktop } from '../src/agent/desktop.js';
import { HelperUpdater } from '../src/agent/updater.js';
import type { UpdateProcess } from '../src/agent/update-process.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'maintenance-044-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
const completion = (turnId: string, at: number) => JSON.stringify({ type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type: 'task_complete', turn_id: turnId } }) + '\n';

it('renews automatically observed watches after 31 days and captures their archived completion', async () => {
  const task = randomUUID(), path = join(dir, 'log.jsonl'), store = new AgentStore(dir); let archived = false;
  const original = Date.now(); let now = original; vi.spyOn(Date, 'now').mockImplementation(() => now);
  writeFileSync(path, '{}\n'); const monitor = new CompletionMonitor(store, ids => !archived || ids?.includes(task) ? [{ id: task, path }] : []);
  try {
    await monitor.poll(); now += 31 * 86400000; await monitor.poll(); await monitor.poll();
    expect(store.notificationWatch(task)).toEqual({ startedAt: original });
    appendFileSync(path, completion('day-31', now)); archived = true; await monitor.poll();
    expect(store.notificationOutbox().map(row => row.turnId)).toEqual(['day-31']);
  } finally { monitor.close(); store.close(); }
});

it('discovers every indexed task while reading a bounded batch and retains archived sources', async () => {
  const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT,title TEXT,cwd TEXT,updated_at_ms INTEGER,updated_at INTEGER,project_id TEXT,source TEXT,archived INTEGER,rollout_path TEXT)');
  const insert = db.prepare("INSERT INTO threads VALUES(?,'task','',?,?,0,NULL,'vscode',0,?)");
  const ids: string[] = [], paths: string[] = [];
  for (let i = 0; i < 450; i++) { const id = randomUUID(), path = join(dir, `${i}.jsonl`); ids.push(id); paths.push(path); writeFileSync(path, '{}\n'); insert.run(id, dir, 450 - i, path); }
  const store = new AgentStore(dir), desktop = new CodexDesktop('fixture.exe', dir), monitor = new CompletionMonitor(store, watched => desktop.notificationSources(watched));
  const original = Date.now(); let now = original; vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    await monitor.poll(); expect(store.notificationWatch(ids[449])).toBeDefined();
    expect(Number(store.db.prepare('SELECT count(*) AS n FROM notification_cursors').get()!.n)).toBeLessThanOrEqual(400);
    now += 6000; appendFileSync(paths[449], completion('older-archived', now)); db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(ids[449]);
    for (let i = 0; i < 10 && !store.notificationOutbox().length; i++) { now += 6000; await monitor.poll(); }
    expect(store.notificationOutbox().map(row => row.turnId)).toEqual(['older-archived']);
  } finally { monitor.close(); desktop.close(); store.close(); db.close(); }
});

it('captures a rewritten completion after clock rollback without replaying old terminal records', async () => {
  const path = join(dir, 'log.jsonl'), store = new AgentStore(dir), task = randomUUID();
  const original = Date.now(); let now = original; vi.spyOn(Date, 'now').mockImplementation(() => now);
  writeFileSync(path, completion('historical', now - 10000) + JSON.stringify({ data: 'x'.repeat(500) }) + '\n');
  const monitor = new CompletionMonitor(store, () => [{ id: task, path }]);
  try {
    await monitor.poll(); expect(store.notificationOutbox()).toEqual([]);
    now -= 3600000; writeFileSync(path, completion('historical', original - 10000) + completion('fresh', now) + JSON.stringify({ data: 'y'.repeat(1000) }) + '\n');
    await monitor.poll(); await monitor.poll(); expect(store.notificationOutbox().map(row => row.turnId)).toEqual(['fresh']);
    for (const row of store.notificationOutbox()) store.ackNotification(row.eventId);
    store.pruneNotifications(original + 31 * 86400000);
    writeFileSync(path, completion('historical', original - 10000) + completion('fresh', now) + completion('later', now + 1));
    await monitor.poll(); expect(store.notificationOutbox().map(row => row.turnId)).toEqual(['later']);
  } finally { monitor.close(); store.close(); }
});

it('establishes historical IDs for a legacy byte cursor without notifying existing history', async () => {
  const path = join(dir, 'legacy.jsonl'), now = Date.now(), task = randomUUID(), store = new AgentStore(dir);
  const old = completion('historical', now - 10000); writeFileSync(path, old);
  store.saveNotificationCursor({ path, offset: Buffer.byteLength(old), size: Buffer.byteLength(old), mtime: now, fileId: '', baselineAt: now, remainder: '' });
  const monitor = new CompletionMonitor(store, () => [{ id: task, path }]);
  try {
    await monitor.poll(); expect(store.notificationOutbox()).toEqual([]); expect(store.notificationCursor(path)?.observed).toBe(1);
    writeFileSync(path, old + completion('fresh', now - 3600000)); await monitor.poll();
    expect(store.notificationOutbox().map(row => row.turnId)).toEqual(['fresh']);
  } finally { monitor.close(); store.close(); }
});

it.each(['reused', 'matching', 'unrelated', 'unavailable'])('reconciles installer identity: %s', async kind => {
  mkdirSync(join(dir, 'updates')); const identity: UpdateProcess = { pid: 12345, name: 'node.exe', path: join(dir, 'updates/runner/node.exe'), startedAt: 'original-start' };
  writeFileSync(join(dir, 'updates/result.json'), JSON.stringify({ version: '0.4.44', phase: 'failed', installerRunning: true, runnerPid: identity.pid, runnerIdentity: identity }));
  const store = new AgentStore(dir); let frozen = false;
  const processes = vi.fn(async () => { if (kind === 'unavailable') throw new Error('No process inventory'); return [{ ...identity, ...(kind === 'reused' ? { startedAt: 'new-start' } : kind === 'unrelated' ? { path: 'C:/unrelated/node.exe' } : {}) }]; });
  const updater = new HelperUpdater({ dir, root: dir + '-program', version: '0.4.43', store, request: async () => Response.json({}), blockers: async () => [], freeze: value => { frozen = value; }, processes });
  try { await updater.reportPrevious(); expect(frozen).toBe(kind === 'matching' || kind === 'unavailable'); expect(updater.state.phase === 'installing').toBe(frozen); }
  finally { updater.close(); store.close(); }
});
