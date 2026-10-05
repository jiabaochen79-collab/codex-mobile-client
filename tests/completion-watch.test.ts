import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentStore } from '../src/agent/store.js';
import { CompletionMonitor } from '../src/agent/notifications.js';

describe('durable completion watches', () => {
  let dir: string, store: AgentStore, monitor: CompletionMonitor;
  const taskId = randomUUID();
  const completion = (turnId: string, at: number) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } }) + '\n';
  const sources = (ids: string[] = []) => ids.includes(taskId) ? [{ id: taskId, path: join(dir, 'archived.jsonl') }] : [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'completion-watch-')); store = new AgentStore(dir);
    writeFileSync(join(dir, 'archived.jsonl'), ''); monitor = new CompletionMonitor(store, sources);
  });
  afterEach(() => { vi.useRealTimers(); monitor.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

  it('captures a new desktop completion before the first scan without notifying historical turns', async () => {
    const path = join(dir, 'archived.jsonl'); const now = Date.now();
    writeFileSync(path, completion('historical', now - 10000)); utimesSync(path, new Date(now - 10000), new Date(now - 10000));
    vi.useFakeTimers(); vi.setSystemTime(now);
    monitor.close(); monitor = new CompletionMonitor(store, () => [{ id: taskId, path }]);
    vi.setSystemTime(now + 1000); appendFileSync(path, completion('after-start', now + 1000)); utimesSync(path, new Date(now + 1000), new Date(now + 1000));
    await monitor.poll(); await monitor.poll();
    expect(store.notificationOutbox().map(event => event.turnId)).toEqual(['after-start']);
  });

  it.each([-300000, 300000])('normalizes a %i ms computer clock skew and pins the timestamp through retries and restarts', async skew => {
    const serverTime = Date.now(), localTime = serverTime + skew, origin = 'https://fixture.invalid';
    monitor.watch(taskId, localTime); appendFileSync(join(dir, 'archived.jsonl'), completion('skewed', localTime + 1000)); await monitor.poll();
    const event = store.notificationOutbox()[0];
    expect(store.notificationTime(event.eventId, origin)).toBeUndefined();
    store.syncNotificationClock(origin, serverTime, localTime);
    expect(store.notificationTime(event.eventId, origin)).toBe(serverTime + 1000);
    monitor.close(); store.close(); store = new AgentStore(dir); monitor = new CompletionMonitor(store, sources);
    store.syncNotificationClock(origin, serverTime + 100000, localTime);
    expect(store.notificationTime(event.eventId, origin)).toBe(serverTime + 1000);
  });

  it('renews an old watch and captures an archived task after monitor and store restart', async () => {
    const now = Date.now(), startedAt = now - 31 * 86400000;
    monitor.watch(taskId, startedAt); monitor.watch(taskId, now); await monitor.poll();
    const retained = store.notificationWatch(taskId);
    monitor.close(); store.close(); store = new AgentStore(dir); monitor = new CompletionMonitor(store, sources);
    appendFileSync(join(dir, 'archived.jsonl'), completion('new-turn', now + 100));
    await monitor.poll(); await monitor.poll();
    expect(retained).toEqual({ startedAt }); expect(store.notificationWatch(taskId)).toEqual({ startedAt });
    expect(store.notificationOutbox()).toEqual([expect.objectContaining({ taskId, turnId: 'new-turn', status: 'completed' })]);
    store.pruneNotifications(now + 1); expect(store.notificationWatch(taskId)).toBeUndefined();
  });

  it('preserves the earliest capture baseline when another watch arrives before the first poll', async () => {
    const now = Date.now(); monitor.watch(taskId, now - 2000);
    appendFileSync(join(dir, 'archived.jsonl'), completion('earlier-turn', now - 1000));
    monitor.watch(taskId, now); await monitor.poll();
    expect(store.notificationOutbox()).toEqual([expect.objectContaining({ turnId: 'earlier-turn' })]);
  });

  it('prioritizes recently reused tasks within the bounded watch list', () => {
    const now = Date.now(); monitor.watch(taskId, now - 31 * 86400000);
    for (let i = 0; i < 200; i++) monitor.watch(randomUUID(), now - 1000 + i);
    monitor.watch(taskId, now);
    expect(store.notificationWatchIds()).toHaveLength(200); expect(store.notificationWatchIds()[0]).toBe(taskId);
  });

  it('accepts legacy watch inserts during rollback and backfills their freshness on reopening', () => {
    const startedAt = Date.now();
    store.db.prepare('INSERT INTO notification_watches(taskId,startedAt) VALUES(?,?)').run(taskId, startedAt);
    monitor.close(); store.close(); store = new AgentStore(dir); monitor = new CompletionMonitor(store, sources);
    store.pruneNotifications(); expect(store.notificationWatch(taskId)).toEqual({ startedAt });
  });

  it('migrates legacy watches without resetting their capture baseline or keeping expired watches', () => {
    const now = Date.now(), startedAt = now - 31 * 86400000, expiredId = randomUUID();
    monitor.close(); store.close();
    const db = new DatabaseSync(join(dir, 'agent.sqlite'));
    db.exec('DROP TABLE notification_watches; CREATE TABLE notification_watches (taskId TEXT PRIMARY KEY, startedAt INTEGER NOT NULL);');
    for (const id of [taskId, expiredId]) db.prepare('INSERT INTO notification_watches VALUES(?,?)').run(id, startedAt);
    db.close(); store = new AgentStore(dir); monitor = new CompletionMonitor(store, sources);
    monitor.watch(taskId, now); store.pruneNotifications();
    expect(store.notificationWatch(taskId)).toEqual({ startedAt }); expect(store.notificationWatch(expiredId)).toBeUndefined();
  });
});
