import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AgentStore } from './store.js';
import { RemoteError, uid, type QueuedMessage } from '../shared/protocol.js';

const payloadSchema = z.object({ text: z.string().max(32000), attachments: z.array(z.object({ id: uid, name: z.string().max(180) })).max(5) }).strict();
export type QueueEntry = { id: string; origin: string; conversation: string; session: string; attachmentOwner: string; epoch: string; attempt: string; state: QueuedMessage['state']; reason: string | null; created: number; payload: string; resumeAfter: string | null };
export class SendQueue {
  private cache = new Map<string, { cipher: string; value: z.infer<typeof payloadSchema> }>();
  constructor(private store: AgentStore, readonly origin: string) {
    store.db.exec('CREATE TABLE IF NOT EXISTS send_queue(id TEXT PRIMARY KEY,origin TEXT NOT NULL,conversation TEXT NOT NULL,session TEXT NOT NULL,attachmentOwner TEXT NOT NULL,epoch TEXT NOT NULL,attempt TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,created INTEGER NOT NULL,payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS queued_conversation ON send_queue(origin,conversation,created);');
    store.db.exec('CREATE TABLE IF NOT EXISTS upload_holds(queue_id TEXT NOT NULL,attachment_id TEXT NOT NULL,PRIMARY KEY(queue_id,attachment_id));');
    if (!store.db.prepare('PRAGMA table_info(send_queue)').all().some(c => c.name === 'resumeAfter')) store.db.exec('ALTER TABLE send_queue ADD COLUMN resumeAfter TEXT');
    store.db.prepare("UPDATE send_queue SET state='uncertain',reason=? WHERE origin=? AND state='sending'").run('助手在发送确认前退出，请核对原任务，不会自动重发。', origin);
  }
  entries(conversation?: string) { return this.store.db.prepare('SELECT * FROM send_queue WHERE origin=?' + (conversation ? ' AND conversation=?' : '') + ' ORDER BY rowid').all(this.origin, ...(conversation ? [conversation] : [])) as QueueEntry[]; }
  get(id: string, conversation: string) { const row = this.store.db.prepare('SELECT * FROM send_queue WHERE id=? AND origin=? AND conversation=?').get(id, this.origin, conversation) as QueueEntry | undefined; if (!row) throw new RemoteError('NOT_FOUND', '待发送消息已移除或已经发送。'); return row; }
  payload(row: QueueEntry) { const cached = this.cache.get(row.id); if (cached?.cipher === row.payload) return cached.value; const value = payloadSchema.parse(JSON.parse(this.store.protect(row.payload, true))); this.cache.set(row.id, { cipher: row.payload, value }); return value; }
  list(conversation: string): QueuedMessage[] { return this.entries(conversation).map(row => { try { return { id: row.id, ...this.payload(row), state: row.state, reason: row.reason, created: row.created }; } catch { return { id: row.id, text: '', attachments: [], state: 'paused', reason: '待发送内容无法读取，可移除此项。', created: row.created }; } }); }
  add(id: string, conversation: string, session: string, epoch: string, value: z.infer<typeof payloadSchema>) {
    const existing = this.entries(); const prior = existing.find(r => r.id === id); if (prior) return prior;
    if (existing.length >= 30 || existing.filter(r => r.conversation === conversation).length >= 10 || !existing.some(r => r.conversation === conversation) && new Set(existing.map(r => r.conversation)).size >= 3) throw new RemoteError('QUEUE_LIMIT', '待发送队列已满：每任务最多 10 条，最多 3 个任务。');
    const payload = this.store.protect(JSON.stringify(payloadSchema.parse(value)), false);
    this.store.db.exec('BEGIN IMMEDIATE');
    try { this.store.db.prepare("INSERT INTO send_queue(id,origin,conversation,session,attachmentOwner,epoch,attempt,state,reason,created,payload) VALUES(?,?,?,?,?,?,?,'pending',NULL,?,?)").run(id, this.origin, conversation, session, session, epoch, randomUUID(), Date.now(), payload); for (const file of value.attachments) this.store.db.prepare('INSERT INTO upload_holds VALUES(?,?)').run(id, file.id); this.store.db.exec('COMMIT'); }
    catch (e) { this.store.db.exec('ROLLBACK'); throw e; }
    this.cache.set(id, { cipher: payload, value }); return this.get(id, conversation);
  }
  remove(id: string, conversation: string) { const row = this.entries(conversation).find(r => r.id === id); if (row?.state === 'sending') throw new RemoteError('OUTCOME_UNKNOWN', '该消息已进入发送阶段，请先核对原任务。'); if (row) this.finish(row); return { removed: true }; }
  finish(row: QueueEntry) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try { this.store.db.prepare('DELETE FROM send_queue WHERE id=? AND origin=?').run(row.id, this.origin); this.store.db.prepare('DELETE FROM upload_holds WHERE queue_id=?').run(row.id); this.store.db.exec('COMMIT'); } catch (e) { this.store.db.exec('ROLLBACK'); throw e; }
    this.cache.delete(row.id);
  }
  mark(row: QueueEntry, state: QueuedMessage['state'], reason: string | null = null) { this.store.db.prepare('UPDATE send_queue SET state=?,reason=? WHERE id=? AND origin=?').run(state, reason, row.id, this.origin); }
  pause(reason: string, conversation?: string, session?: string) {
    const rows = this.entries(conversation).filter(r => (!session || r.session === session) && r.state === 'pending');
    for (const row of rows) this.mark(row, 'paused', reason); return [...new Set(rows.map(r => r.conversation))];
  }
  resume(id: string, conversation: string, session: string, epoch: string, resumeAfter: string | null = null) {
    const row = this.get(id, conversation); if (row.state !== 'paused') throw new RemoteError('INVALID', '只有已暂停且结果明确的消息可以继续；结果待核对的消息不会重发。');
    this.store.db.prepare("UPDATE send_queue SET state='pending',reason=NULL,session=?,epoch=?,attempt=?,resumeAfter=? WHERE id=? AND origin=?").run(session, epoch, randomUUID(), resumeAfter, id, this.origin);
    return { resumed: true };
  }
}
