import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import type { DecisionEvent, DecisionSnapshot } from '../shared/notifications.js';
import type { AgentStore } from './store.js';
import type { NotificationSource } from './notifications.js';

type Decision = Omit<DecisionEvent, 'deviceId' | 'protocolVersion'> & { confirmedAt: number; ackedState: string | null };

export class DecisionMonitor {
  private polling = false;
  private closed = false;
  private offset = 0;
  private observed = new Map<string, string>();
  private dirty = new Set<string>();
  private confirmed = new Set<string>();
  constructor(private store: AgentStore, private sources: () => Promise<NotificationSource[]>, private snapshot: (taskId: string) => Promise<DecisionSnapshot>) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS notification_decisions (
      requestKey TEXT PRIMARY KEY, taskId TEXT NOT NULL, turnId TEXT NOT NULL,
      state TEXT NOT NULL, occurredAt INTEGER NOT NULL, confirmedAt INTEGER NOT NULL, ackedState TEXT
    );`);
  }
  close() { this.closed = true; }
  watch(taskId: string) { this.dirty.add(taskId); }
  async poll() {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      const pending = this.store.db.prepare("SELECT DISTINCT taskId FROM notification_decisions WHERE state='required'").all().map(row => String(row.taskId));
      const rows = await this.sources();
      const candidates = new Map<string, string>();
      for (const row of rows) {
        try {
          const stat = statSync(row.path), signature = `${stat.mtimeMs}:${stat.size}`;
          if (this.dirty.has(row.id) || stat.mtimeMs >= Date.now() - 86400000 && this.observed.get(row.id) !== signature) candidates.set(row.id, signature);
        } catch { /* A rotating file is retried on the next scan. */ }
      }
      for (const id of pending) if (!candidates.has(id)) candidates.set(id, this.observed.get(id) ?? '');
      const entries = [...candidates];
      if (this.offset >= entries.length) this.offset = 0;
      for (const [id, signature] of entries.slice(this.offset, this.offset + 4)) {
        if (this.closed) break;
        try {
          this.dirty.delete(id);
          const snapshot = await this.snapshot(id);
          if (this.closed) break;
          if (snapshot.taskId !== id || !snapshot.turnId) continue;
          this.record(snapshot);
          this.observed.set(id, signature);
        } catch { /* Missing or disconnected desktop state cannot resolve a question. */ }
      }
      this.offset += 4;
      this.store.db.prepare("DELETE FROM notification_decisions WHERE state='resolved' AND ackedState='resolved' AND confirmedAt<?").run(Date.now() - 30 * 86400000);
    } finally { this.polling = false; }
  }
  record(snapshot: DecisionSnapshot, now = Date.now()) {
    const keys = new Set(snapshot.requestIds.map(id => createHash('sha256').update(`${this.store.notificationNamespace()}\0${snapshot.taskId}\0${snapshot.turnId}\0${id}`).digest('hex')));
    this.store.db.exec('BEGIN');
    try {
      const previous = this.store.db.prepare("SELECT requestKey FROM notification_decisions WHERE taskId=? AND state='required'").all(snapshot.taskId);
      for (const row of previous) if (!keys.has(String(row.requestKey))) this.store.db.prepare("UPDATE notification_decisions SET state='resolved',confirmedAt=? WHERE requestKey=?").run(now, row.requestKey);
      for (const key of keys) this.store.db.prepare("INSERT INTO notification_decisions(requestKey,taskId,turnId,state,occurredAt,confirmedAt) VALUES(?,?,?,'required',?,?) ON CONFLICT(requestKey) DO UPDATE SET confirmedAt=excluded.confirmedAt").run(key, snapshot.taskId, snapshot.turnId, now, now);
      this.store.db.exec('COMMIT');
      this.confirmed.add(snapshot.taskId);
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  outbox(now = Date.now()) {
    // Reconfirm outstanding requests after restart before sending a delayed reminder.
    const rows = this.store.db.prepare("SELECT * FROM notification_decisions WHERE (ackedState IS NULL OR ackedState<>state) AND (state='resolved' OR confirmedAt>=?) ORDER BY CASE WHEN state='resolved' THEN 0 ELSE 1 END,occurredAt LIMIT 20").all(now - 10000) as Decision[];
    return rows.filter(row => row.state === 'resolved' || this.confirmed.has(row.taskId));
  }
  ack(requestKey: string, state: Decision['state']) { this.store.db.prepare('UPDATE notification_decisions SET ackedState=? WHERE requestKey=? AND state=?').run(state, requestKey, state); }
}
