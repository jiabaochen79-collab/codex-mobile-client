import { createHash } from 'node:crypto';
import { existsSync, openSync, closeSync, readSync, statSync } from 'node:fs';
import type { LocalNotificationEvent } from '../shared/notifications.js';
import { AgentStore } from './store.js';

export type NotificationSource = { id: string; path: string };
type Cursor = { path: string; offset: number; mtime: number; size: number; fileId: string; baselineAt: number; remainder: string };

const MAX_DELTA_BYTES = 4 * 1024 * 1024;
const MAX_REMAINDER_BYTES = 1024 * 1024;

function fileIdentity(stat: { dev: number | bigint; ino: number | bigint }) {
  return `${stat.dev}:${stat.ino}`;
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
  private timer?: NodeJS.Timeout;
  private polling = false;
  private closed = false;
  private startedAt = Date.now();
  constructor(private store: AgentStore, private sources: (taskIds?: string[]) => Promise<NotificationSource[]> | NotificationSource[]) {}
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
      const rows = await this.sources(this.store.notificationWatchIds());
      for (const source of rows.slice(0, 400)) if (!this.closed) {
        try { this.readSource(source); } catch { /* Retry this file without starving other tasks. */ }
      }
      this.store.pruneNotifications();
    } catch { /* The desktop index may be replacing files while Codex starts. */ }
    finally { this.polling = false; }
  }
  private readSource(source: NotificationSource) {
    if (!source.id || !existsSync(source.path)) return;
    const stat = statSync(source.path);
    let previous = this.store.notificationCursor(source.path);
    if (!previous) {
      const watch = this.store.notificationWatch(source.id);
      const baselineAt = watch?.startedAt ?? this.startedAt;
      if (!watch && stat.birthtimeMs < this.startedAt) {
        this.store.saveNotificationCursor({ path: source.path, offset: stat.size, mtime: stat.mtimeMs, size: stat.size, fileId: fileIdentity(stat), baselineAt, remainder: '' });
        return;
      }
      previous = { path: source.path, offset: 0, mtime: stat.mtimeMs, size: 0, fileId: fileIdentity(stat), baselineAt, remainder: '' };
    }
    const currentFileId = fileIdentity(stat);
    let offset = previous.offset;
    let baselineAt = previous.baselineAt;
    let remainder = previous.remainder;
    const rotated = (previous.fileId && previous.fileId !== currentFileId) || stat.size < offset || stat.size === offset && stat.mtimeMs !== previous.mtime;
    if (rotated) { offset = 0; remainder = ''; }
    if (!rotated && stat.size === offset && stat.mtimeMs === previous.mtime) return;
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
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < combined.length; i++) if (combined[i] === 10) { lines.push(combined.subarray(start, i).toString('utf8')); start = i + 1; }
    const tail = combined.subarray(start);
    remainder = tail.length <= MAX_REMAINDER_BYTES ? `b64:${tail.toString('base64')}` : '';
    const next: Cursor = { path: source.path, offset: offset + bytesRead, mtime: stat.mtimeMs, size: stat.size, fileId: currentFileId, baselineAt, remainder };
    const events: LocalNotificationEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: any;
      try { event = JSON.parse(line); } catch { continue; }
      const payload = event?.type === 'event_msg' ? event.payload : undefined;
      const status = eventStatus(payload);
      const turnId = typeof payload?.turn_id === 'string' ? payload.turn_id : '';
      if (!status || !turnId || turnId.length > 200) continue;
      const occurredAt = timestamp(event.timestamp, 0);
      if (occurredAt < baselineAt) continue;
      const eventId = createHash('sha256').update(`${source.id}\0${turnId}\0${status}`).digest('hex');
      events.push({ eventId, taskId: source.id, turnId, status, occurredAt, protocolVersion: 1 });
    }
    this.store.recordNotifications(events, next);
  }
}
