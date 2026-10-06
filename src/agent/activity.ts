import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

type Entry = { size: number; mtime: number; completionId: string };
export class DesktopActivity {
  private cache = new Map<string, Entry>();
  private seen = new Map<string, string>();
  private unread = new Set<string>();
  private globalMtime = -1;
  constructor(private home: string) {}
  read(file: string) {
    const stat = statSync(file); const previous = this.cache.get(file);
    if (previous?.size === stat.size && previous.mtime === stat.mtimeMs) return previous;
    const entry: Entry = { size: stat.size, mtime: stat.mtimeMs, completionId: previous?.completionId ?? '' };
    const fd = openSync(file, 'r');
    try {
      let size = Math.min(stat.size, 2 * 1024 * 1024); let data = Buffer.alloc(size);
      readSync(fd, data, 0, size, stat.size - size);
      // A terminal record can contain a long final answer. Widen only when the
      // entire tail is one incomplete record, preserving the normal fast path.
      while (size < stat.size && data.subarray(0, Math.max(0, data.length - 1)).indexOf(10) < 0 && size < 64 * 1024 * 1024) {
        size = Math.min(stat.size, size * 2, 64 * 1024 * 1024); data = Buffer.alloc(size); readSync(fd, data, 0, size, stat.size - size);
      }
      const lines = data.toString('utf8').split('\n'); if (size < stat.size) lines.shift();
      for (const line of lines.reverse()) {
        let event: any; try { event = JSON.parse(line); } catch { continue; }
        if (event.type !== 'event_msg') continue;
        const p = event.payload;
        if (['task_complete', 'turn_aborted', 'task_failed'].includes(p?.type)) { entry.completionId = `${p.turn_id ?? ''}:${event.timestamp ?? ''}`; break; }
      }
    } finally { closeSync(fd); }
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(file, entry); return entry;
  }
  isUnread(id: string, completionId: string) {
    try {
      const file = join(this.home, '.codex-global-state.json'); const mtime = statSync(file).mtimeMs;
      if (mtime !== this.globalMtime) {
        const state = JSON.parse(readFileSync(file, 'utf8'));
        const ids = state['electron-persisted-atom-state']?.['unread-thread-ids-by-host-v1']?.local;
        if (Array.isArray(ids)) this.unread = new Set(ids.filter(id => typeof id === 'string'));
        this.globalMtime = mtime;
      }
    } catch { /* The desktop can be replacing its state file atomically. */ }
    return this.unread.has(id) && this.seen.get(id) !== completionId;
  }
  changed(id: string, unread: boolean) { if (unread) { this.unread.add(id); this.seen.delete(id); } else this.unread.delete(id); }
  markSeen(id: string, completionId: string) { this.seen.set(id, completionId); this.unread.delete(id); }
}

export function runtimeRunning(status: unknown): boolean | undefined {
  const type = typeof status === 'string' ? status : (status as { type?: unknown } | null)?.type;
  if (type === 'active') return true;
  if (type === 'idle' || type === 'notLoaded' || type === 'systemError') return false;
}

type RuntimeLookup = (name: 'list_threads' | 'read_thread', args: Record<string, unknown>, contextId: string) => Promise<any>;
export class DesktopRuntimeActivity {
  private generation = 0;
  private catalog?: { checked: number; values: Map<string, boolean> };
  private checks = new Map<string, { checked: number; running: boolean | undefined }>();
  constructor(private lookup: RuntimeLookup) {}
  clear() { this.generation++; this.catalog = undefined; this.checks.clear(); }
  async read(ids: string[]) {
    const result = new Map<string, boolean | undefined>(); if (!ids.length) return result;
    const generation = this.generation; const now = performance.now();
    try {
      if (!this.catalog || now - this.catalog.checked >= 2000) {
        const listed = await this.lookup('list_threads', { limit: 50 }, ids[0]);
        if (!Array.isArray(listed?.pinnedThreads) || !Array.isArray(listed?.threads)) return result;
        const values = new Map<string, boolean>();
        for (const row of [...listed.pinnedThreads, ...listed.threads]) {
          const running = runtimeRunning(row?.status);
          if (row?.kind === 'codex' && row.hostId === 'local' && typeof row.id === 'string' && running !== undefined) values.set(row.id, running);
        }
        if (generation !== this.generation) return result;
        this.catalog = { checked: performance.now(), values };
      }
      const catalog = this.catalog.values; let cursor = 0;
      // A task outside the recent catalog needs an exact lookup, not an age-based guess.
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
        for (;;) {
          const id = ids[cursor++]; if (!id || generation !== this.generation) return;
          if (catalog.has(id)) { result.set(id, catalog.get(id)); continue; }
          const previous = this.checks.get(id);
          if (previous && performance.now() - previous.checked < 2000) { result.set(id, previous.running); continue; }
          let running: boolean | undefined;
          try {
            const answer = await this.lookup('read_thread', { threadId: id, hostId: 'local', turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 1 }, id);
            if (answer?.thread?.id === id && answer.thread.kind === 'codex' && answer.thread.hostId === 'local') running = runtimeRunning(answer.thread.status);
          } catch { /* Unavailable status is not evidence that a task is running. */ }
          if (generation !== this.generation) return;
          if (this.checks.size >= 2000) this.checks.clear();
          this.checks.set(id, { checked: performance.now(), running }); result.set(id, running);
        }
      }));
    } catch { /* Never revive an unfinished historical turn when the live lookup fails. */ }
    return generation === this.generation ? result : new Map<string, boolean | undefined>();
  }
}
