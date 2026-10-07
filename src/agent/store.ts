import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { hash, privateDirectory } from '../shared/security.js';
import { RemoteError, readMethods, passwordSettingsSchema, type PasswordSettings, type Command } from '../shared/protocol.js';
import type { LocalNotificationEvent } from '../shared/notifications.js';
import { REMEMBERED_SESSION_MS } from '../shared/session.js';

export class AgentStore {
  db: DatabaseSync;
  private runningCommands = new Set<string>();
  constructor(dir: string, private nativeExe?: string) {
    privateDirectory(dir); this.db = new DatabaseSync(join(dir, 'agent.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT, created INTEGER NOT NULL);');
    const commandColumns = this.db.prepare('PRAGMA table_info(commands)').all();
    for (const name of ['session', 'conversation']) if (!commandColumns.some(c => c.name === name)) this.db.exec(`ALTER TABLE commands ADD COLUMN ${name} TEXT`);
    this.db.exec('CREATE TABLE IF NOT EXISTS remembered_grants (origin TEXT NOT NULL, id TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(origin,id));');
    this.db.exec('CREATE TABLE IF NOT EXISTS notification_cursors (path TEXT PRIMARY KEY, offset INTEGER NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL, fileId TEXT NOT NULL DEFAULT \'\', baselineAt INTEGER NOT NULL, remainder TEXT NOT NULL);');
    if (!this.db.prepare('PRAGMA table_info(notification_cursors)').all().some(c => c.name === 'fileId')) this.db.exec("ALTER TABLE notification_cursors ADD COLUMN fileId TEXT NOT NULL DEFAULT ''");
    this.db.exec('CREATE TABLE IF NOT EXISTS notification_watches (taskId TEXT PRIMARY KEY, startedAt INTEGER NOT NULL, lastWatchedAt INTEGER NOT NULL DEFAULT 0);');
    if (!this.db.prepare('PRAGMA table_info(notification_watches)').all().some(c => c.name === 'lastWatchedAt')) this.db.exec('ALTER TABLE notification_watches ADD COLUMN lastWatchedAt INTEGER NOT NULL DEFAULT 0');
    this.db.exec('UPDATE notification_watches SET lastWatchedAt=startedAt WHERE lastWatchedAt=0');
    this.db.exec('CREATE TABLE IF NOT EXISTS notification_outbox (eventId TEXT PRIMARY KEY, taskId TEXT NOT NULL, turnId TEXT NOT NULL, status TEXT NOT NULL, occurredAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lastAttempt INTEGER, createdAt INTEGER NOT NULL, ackedAt INTEGER);');
    if (!this.db.prepare('PRAGMA table_info(notification_outbox)').all().some(c => c.name === 'serverOccurredAt')) this.db.exec('ALTER TABLE notification_outbox ADD COLUMN serverOccurredAt INTEGER');
    try { this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_round_status ON notification_outbox(taskId,turnId,status);'); }
    catch {
      this.db.exec(`DELETE FROM notification_outbox WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM notification_outbox GROUP BY taskId,turnId,status
      )`);
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_round_status ON notification_outbox(taskId,turnId,status);');
    }
  }
  get(key: string): string | null { return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value as string ?? null; }
  set(key: string, value: string) { this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  protect(value: string, decrypt: boolean) {
    if (process.platform !== 'win32') return decrypt ? Buffer.from(value, 'base64').toString() : Buffer.from(value).toString('base64');
    if (!this.nativeExe) throw new Error('Windows credential protection helper is required.');
    return execFileSync(this.nativeExe, [decrypt ? '--unprotect' : '--protect'], { input: value, encoding: 'utf8', windowsHide: true, timeout: 4000 }).trim();
  }
  credentials(origin: string) {
    const saved = this.get(`credentials:${hash(origin)}`) ?? this.get('credentials'); if (!saved) return null;
    const value = JSON.parse(this.protect(saved, true));
    if (value.origin !== origin) return null;
    return value as { id: string; secret: string; origin: string };
  }
  saveCredentials(value: { id: string; secret: string; origin: string }) { this.set(`credentials:${hash(value.origin)}`, this.protect(JSON.stringify(value), false)); }
  passwordSettings(origin: string): PasswordSettings {
    const saved = this.get(`password:${hash(origin)}`);
    return saved ? passwordSettingsSchema.parse(JSON.parse(this.protect(saved, true))) : { mode: 'automatic' };
  }
  savePasswordSettings(origin: string, value: PasswordSettings) {
    const protectedValue = this.protect(JSON.stringify(value), false);
    this.db.exec('BEGIN');
    try { this.set(`password:${hash(origin)}`, protectedValue); this.clearGrants(origin); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  grants(origin: string) {
    this.db.prepare('DELETE FROM remembered_grants WHERE expires<=?').run(Date.now());
    const rows = this.db.prepare('SELECT id,expires FROM remembered_grants WHERE origin=?').all(origin) as { id: string; expires: number }[];
    return new Map(rows.map(row => [row.id, row.expires]));
  }
  saveGrant(origin: string, id: string, expires: number) { this.db.prepare('INSERT INTO remembered_grants VALUES(?,?,?)').run(origin, id, expires); }
  deleteGrant(origin: string, id: string) { this.db.prepare('DELETE FROM remembered_grants WHERE origin=? AND id=?').run(origin, id); }
  clearGrants(origin: string) { this.db.prepare('DELETE FROM remembered_grants WHERE origin=?').run(origin); }
  notificationNamespace() {
    const prior = this.get('notification:namespace'); if (prior) return prior;
    const namespace = randomUUID(); this.set('notification:namespace', namespace); return namespace;
  }
  notificationCursor(path: string) {
    return this.db.prepare('SELECT path,offset,mtime,size,fileId,baselineAt,remainder FROM notification_cursors WHERE path=?').get(path) as { path: string; offset: number; mtime: number; size: number; fileId: string; baselineAt: number; remainder: string } | undefined;
  }
  saveNotificationCursor(cursor: { path: string; offset: number; mtime: number; size: number; fileId: string; baselineAt: number; remainder: string }) {
    this.db.prepare('INSERT INTO notification_cursors(path,offset,mtime,size,fileId,baselineAt,remainder) VALUES(?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET offset=excluded.offset,mtime=excluded.mtime,size=excluded.size,fileId=excluded.fileId,baselineAt=excluded.baselineAt,remainder=excluded.remainder').run(cursor.path, cursor.offset, cursor.mtime, cursor.size, cursor.fileId, cursor.baselineAt, cursor.remainder);
  }
  watchNotificationTask(taskId: string, startedAt: number) {
    this.db.prepare('INSERT INTO notification_watches(taskId,startedAt,lastWatchedAt) VALUES(?,?,?) ON CONFLICT(taskId) DO UPDATE SET startedAt=MIN(startedAt,excluded.startedAt),lastWatchedAt=MAX(lastWatchedAt,excluded.lastWatchedAt)').run(taskId, startedAt, startedAt);
  }
  notificationWatch(taskId: string) {
    return this.db.prepare('SELECT startedAt FROM notification_watches WHERE taskId=?').get(taskId) as { startedAt: number } | undefined;
  }
  notificationWatchIds(offset = 0) { return (this.db.prepare('SELECT taskId FROM notification_watches ORDER BY lastWatchedAt DESC,taskId LIMIT 200 OFFSET ?').all(offset) as { taskId: string }[]).map(row => row.taskId); }
  recordNotifications(events: LocalNotificationEvent[], cursor: { path: string; offset: number; mtime: number; size: number; fileId: string; baselineAt: number; remainder: string }) {
    this.db.exec('BEGIN');
    try {
      const insert = this.db.prepare('INSERT OR IGNORE INTO notification_outbox(eventId,taskId,turnId,status,occurredAt,createdAt) VALUES(?,?,?,?,?,?)');
      for (const event of events) insert.run(event.eventId, event.taskId, event.turnId, event.status, event.occurredAt, Date.now());
      this.db.prepare('INSERT INTO notification_cursors(path,offset,mtime,size,fileId,baselineAt,remainder) VALUES(?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET offset=excluded.offset,mtime=excluded.mtime,size=excluded.size,fileId=excluded.fileId,baselineAt=excluded.baselineAt,remainder=excluded.remainder').run(cursor.path, cursor.offset, cursor.mtime, cursor.size, cursor.fileId, cursor.baselineAt, cursor.remainder);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recordNotification(event: LocalNotificationEvent, cursor: { path: string; offset: number; mtime: number; size: number; fileId: string; baselineAt: number; remainder: string }) { this.recordNotifications([event], cursor); }
  notificationOutbox(now = Date.now()) {
    return this.db.prepare('SELECT eventId,taskId,turnId,status,occurredAt,attempts,lastAttempt,createdAt,ackedAt FROM notification_outbox WHERE ackedAt IS NULL AND (lastAttempt IS NULL OR lastAttempt<?) ORDER BY createdAt LIMIT 20').all(now - 10000) as { eventId: string; taskId: string; turnId: string; status: 'completed' | 'failed' | 'interrupted'; occurredAt: number; attempts: number; lastAttempt: number | null; createdAt: number; ackedAt: number | null }[];
  }
  markNotificationAttempt(eventId: string) { this.db.prepare('UPDATE notification_outbox SET attempts=attempts+1,lastAttempt=? WHERE eventId=? AND ackedAt IS NULL').run(Date.now(), eventId); }
  syncNotificationClock(origin: string, serverTime: number, localTime = Date.now(), correctedEvent?: string) {
    const key = `notification:clock:${hash(origin)}`; const previous = this.get(key);
    if (previous !== null) this.db.prepare('UPDATE notification_outbox SET serverOccurredAt=MAX(0,ROUND(occurredAt+?)) WHERE serverOccurredAt IS NULL AND ackedAt IS NULL AND eventId<>?').run(Number(previous), correctedEvent ?? '');
    this.set(key, String(serverTime - localTime));
  }
  notificationTime(eventId: string, origin: string) {
    const row = this.db.prepare('SELECT occurredAt,serverOccurredAt FROM notification_outbox WHERE eventId=?').get(eventId) as { occurredAt: number; serverOccurredAt: number | null };
    if (row.serverOccurredAt !== null) return row.serverOccurredAt;
    const saved = this.get(`notification:clock:${hash(origin)}`); if (saved === null) return undefined;
    const at = Math.max(0, Math.round(row.occurredAt + Number(saved)));
    this.db.prepare('UPDATE notification_outbox SET serverOccurredAt=? WHERE eventId=?').run(at, eventId);
    return at;
  }
  ackNotification(eventId: string) { this.db.prepare('UPDATE notification_outbox SET ackedAt=? WHERE eventId=?').run(Date.now(), eventId); }
  rejectNotificationTime(eventId: string, occurredAt: number) {
    return this.db.prepare('UPDATE notification_outbox SET serverOccurredAt=NULL WHERE eventId=? AND serverOccurredAt=? AND ackedAt IS NULL').run(eventId, occurredAt).changes > 0;
  }
  pruneNotifications(before = Date.now() - 30 * 86400000) {
    this.db.prepare('DELETE FROM notification_outbox WHERE ackedAt IS NOT NULL AND createdAt<?').run(before);
    this.db.prepare('DELETE FROM notification_watches WHERE lastWatchedAt<?').run(before);
    for (const row of this.db.prepare('SELECT path FROM notification_cursors WHERE mtime<?').all(before)) {
      try { statSync(String(row.path)); }
      catch (error: any) { if (error.code === 'ENOENT') this.db.prepare('DELETE FROM notification_cursors WHERE path=?').run(row.path); }
    }
  }
  commandStatus(id: string, session: string, conversation: string) {
    const row = this.db.prepare('SELECT result FROM commands WHERE id=? AND session=? AND conversation=?').get(id, session, conversation);
    if (!row) return { state: 'unknown' };
    if (!row.result) return { state: this.runningCommands.has(id) ? 'pending' : 'unknown' };
    const saved = JSON.parse(row.result as string);
    if (['OUTCOME_UNKNOWN', 'INTERNAL'].includes(saved.error?.code)) return { state: 'unknown' };
    return saved.error ? { state: 'failed', error: saved.error } : { state: 'succeeded' };
  }
  async once(id: string, command: Command, perform: () => Promise<unknown>, session?: string) {
    if (readMethods.has(command.method) || command.method.startsWith('upload.')) return perform();
    const digest = hash(JSON.stringify(command));
    const prior = this.db.prepare('SELECT digest,result,session FROM commands WHERE id=?').get(id);
    if (prior) {
      if (prior.session && prior.session !== session) throw new RemoteError('AUTH', '操作不属于当前授权。');
      if (prior.digest !== digest) throw new RemoteError('INVALID', '操作 ID 已用于另一条请求。');
      if (!prior.result) throw new RemoteError('OUTCOME_UNKNOWN', '之前的操作结果未确认，请核对原会话，不要重复提交。');
      const saved = JSON.parse(prior.result as string);
      if (saved.error) throw new RemoteError(saved.error.code, saved.error.message);
      return saved.result;
    }
    this.db.prepare("DELETE FROM commands WHERE created < ? AND result IS NOT NULL AND id NOT LIKE 'plan:%'").run(Date.now() - REMEMBERED_SESSION_MS);
    this.db.prepare('INSERT INTO commands(id,digest,created,session,conversation) VALUES(?,?,?,?,?)').run(id, digest, Date.now(), session ?? null, 'id' in command.params ? command.params.id : null);
    this.runningCommands.add(id);
    try {
      const result = await perform();
      this.db.prepare('UPDATE commands SET result=? WHERE id=?').run(JSON.stringify({ result }), id);
      return result;
    } catch (e) {
      if (command.method === 'plan.respond' && e instanceof RemoteError && ['STALE', 'BUSY', 'QUEUE_PENDING', 'INVALID', 'AUTH', 'SUBSCRIPTION_REQUIRED', 'UNSUPPORTED', 'NOT_FOUND', 'CONTROL_LOST', 'CLIENT_REJECTED'].includes(e.code)) this.db.prepare('DELETE FROM commands WHERE id=?').run(id);
      else if (e instanceof RemoteError && !['OUTCOME_UNKNOWN', 'INTERNAL'].includes(e.code)) this.db.prepare('UPDATE commands SET result=? WHERE id=?').run(JSON.stringify({ error: { code: e.code, message: e.message } }), id);
      throw e;
    } finally { this.runningCommands.delete(id); }
  }
  close() { this.db.close(); }
}
