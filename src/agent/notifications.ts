import { createHash } from 'node:crypto';
import { existsSync, openSync, closeSync, readSync, statSync } from 'node:fs';
import type { LocalNotificationEvent } from '../shared/notifications.js';
import { AgentStore } from './store.js';
import { setImmediate } from 'node:timers/promises';
import { readCompactRecord } from './compact-json.js';

export type NotificationSource = { id: string; path: string };
type Cursor = { path: string; offset: number; mtime: number; size: number; fileId: string; baselineAt: number; baselineEnd: number; remainder: string; fingerprint?: string; observed: number };

const MAX_DELTA_BYTES = 4 * 1024 * 1024;
const MAX_REMAINDER_BYTES = 1024 * 1024;

function fileIdentity(stat: { dev: number | bigint; ino: number | bigint }) {
  return `${stat.dev}:${stat.ino}`;
}
function cursorFingerprint(path: string, offset: number) {
  const fd = openSync(path, 'r'), bytes = Buffer.alloc(Math.min(128, offset));
  try { const count = readSync(fd, bytes, 0, bytes.length, offset - bytes.length); return createHash('sha256').update(bytes.subarray(0, count)).digest('hex'); }
  finally { closeSync(fd); }
}

function eventStatus(payload: any): LocalNotificationEvent['status'] | undefined {
  if (payload?.type === 'task_complete') return 'completed';
  if (payload?.type === 'task_failed') return 'failed';
  if (payload?.type === 'turn_aborted') {
    const reason = String(payload.reason ?? payload.stop_reason ?? '').toLowerCase();
    if (/error|fail|crash|exception/.test(reason)) return 'interrupted';
  }
}

function timestamp(value: unknown, fallback: number) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1000);
  if (typeof value === 'string') { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed; }
  return fallback;
}

export class CompletionMonitor {
  private namespace: string;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private closed = false;
  private startedAt = Date.now();
  private watchOffset = 0;
  private sourceOffset = 0;
  private discovered?: NotificationSource[];
  constructor(private store: AgentStore, private sources: (taskIds?: string[]) => Promise<NotificationSource[]> | NotificationSource[]) { this.namespace = store.notificationNamespace(); }
  start(intervalMs = 2000) {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => { void this.poll(); }, intervalMs);
    this.timer.unref();
  }
  close() { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  watch(taskId: string, startedAt = Date.now()) { this.store.watchNotificationTask(taskId, startedAt); }
  async poll() {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      const watched = this.store.notificationWatchIds(this.watchOffset);
      this.watchOffset = watched.length === 200 ? this.watchOffset + 200 : 0;
      const rows = await this.sources(watched);
      if (rows !== this.discovered) { this.store.discoverNotificationTasks(rows.map(row => row.id), this.startedAt); this.discovered = rows; }
      const ids = new Set(watched), priority = rows.filter(row => ids.has(row.id)), remaining = rows.filter(row => !ids.has(row.id));
      if (this.sourceOffset >= remaining.length) this.sourceOffset = 0;
      const discovered = remaining.slice(this.sourceOffset, this.sourceOffset + 400 - priority.length); this.sourceOffset += discovered.length;
      const batch = [...priority, ...discovered];
      for (const source of batch) if (!this.closed) {
        try { await setImmediate(); if (!this.closed) { await this.readSource(source); this.store.watchNotificationTask(source.id, this.startedAt, Date.now()); } } catch { /* Retry this file without starving other tasks. */ }
      }
      this.store.pruneNotifications();
    } catch { /* The desktop index may be replacing files while Codex starts. */ }
    finally { this.polling = false; }
  }
  private async readSource(source: NotificationSource) {
    if (!source.id || !existsSync(source.path)) return;
    const stat = statSync(source.path);
    let previous = this.store.notificationCursor(source.path);
    const initialized = !!previous;
    if (!previous) {
      const watch = this.store.notificationWatch(source.id);
      const baselineAt = watch?.startedAt ?? this.startedAt;
      previous = { path: source.path, offset: 0, mtime: stat.mtimeMs, size: 0, fileId: fileIdentity(stat), baselineAt, baselineEnd: stat.size, remainder: '', observed: 1 };
    } else if (!previous.observed) {
      // Older cursors did not retain historical terminal IDs. Establish them once without replaying history.
      previous = { ...previous, offset: 0, baselineEnd: previous.offset, remainder: '', fingerprint: '', observed: 1 };
    }
    const currentFileId = fileIdentity(stat);
    let offset = previous.offset;
    let baselineAt = previous.baselineAt;
    let baselineEnd = previous.baselineEnd;
    let remainder = previous.remainder;
    const rotated = (previous.fileId && previous.fileId !== currentFileId) || stat.size < offset || stat.size === offset && stat.mtimeMs !== previous.mtime || !!previous.fingerprint && cursorFingerprint(source.path, offset) !== previous.fingerprint;
    if (rotated) { offset = 0; remainder = ''; baselineEnd = 0; }
    if (initialized && !rotated && stat.size === offset && stat.mtimeMs === previous.mtime) return;
    const delta = Math.min(stat.size - offset, MAX_DELTA_BYTES);
    const fd = openSync(source.path, 'r');
    let data = Buffer.alloc(delta);
    let bytesRead = 0;
    try {
      if (delta) bytesRead = readSync(fd, data, 0, delta, offset);
    } finally { closeSync(fd); }
    data = data.subarray(0, bytesRead);
    const priorBytes = remainder.startsWith('b64:') ? Buffer.from(remainder.slice(4), 'base64') : Buffer.from(remainder);
    const combined = Buffer.concat([priorBytes, data]);
    const lines: { text: string; end: number }[] = [];
    let start = 0;
    for (let i = 0; i < combined.length; i++) if (combined[i] === 10) { lines.push({ text: combined.subarray(start, i).toString('utf8'), end: offset - priorBytes.length + i + 1 }); start = i + 1; }
    const tail = combined.subarray(start);
    remainder = tail.length <= MAX_REMAINDER_BYTES ? `b64:${tail.toString('base64')}` : '';
    let nextOffset = offset + bytesRead;
    if (tail.length > MAX_REMAINDER_BYTES) {
      nextOffset -= tail.length;
      const record = await readCompactRecord(source.path, nextOffset);
      if (record) { if (record.value) lines.push({ text: JSON.stringify(record.value), end: record.offset }); nextOffset = record.offset; }
    }
    if (this.closed) return;
    const next: Cursor = { path: source.path, offset: nextOffset, mtime: stat.mtimeMs, size: stat.size, fileId: currentFileId, baselineAt, baselineEnd, remainder, fingerprint: cursorFingerprint(source.path, nextOffset), observed: 1 };
    const events: LocalNotificationEvent[] = [];
    const baselines: string[] = [];
    for (const { text: line, end } of lines) {
      if (!line.trim()) continue;
      let event: any;
      try { event = JSON.parse(line); } catch { continue; }
      const payload = event?.type === 'event_msg' ? event.payload : undefined;
      const status = eventStatus(payload);
      const turnId = typeof payload?.turn_id === 'string' ? payload.turn_id : '';
      if (!status || !turnId || turnId.length > 200) continue;
      const occurredAt = timestamp(event.timestamp, 0);
      // Only bootstrap history needs a wall-clock cutoff; appended records use the durable byte boundary.
      const eventId = createHash('sha256').update(`${this.namespace}\0${source.id}\0${turnId}\0${status}`).digest('hex');
      if (end <= baselineEnd && occurredAt < baselineAt) { baselines.push(eventId); continue; }
      events.push({ eventId, taskId: source.id, turnId, status, occurredAt, protocolVersion: 1 });
    }
    this.store.recordNotifications(events, next, baselines);
  }
}
