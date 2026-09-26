import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DesktopRuntimeActivity, runtimeRunning } from '../src/agent/activity.js';
import { CodexDesktop } from '../src/agent/desktop.js';

afterEach(() => vi.restoreAllMocks());
const row = (id: string, status: unknown, hostId = 'local') => ({ id, kind: 'codex', hostId, status });
describe('authoritative desktop activity', () => {
  it('uses explicit live statuses and rejects unrecognized values', () => {
    expect(runtimeRunning('active')).toBe(true); expect(runtimeRunning({ type: 'idle' })).toBe(false);
    expect(runtimeRunning('notLoaded')).toBe(false); expect(runtimeRunning({ type: 'systemError' })).toBe(false);
    expect(runtimeRunning('inProgress')).toBeUndefined(); expect(runtimeRunning(undefined)).toBeUndefined();
  });
  it('reads pinned and recent local Codex tasks without relying on history timestamps', async () => {
    const lookup = vi.fn().mockResolvedValue({ pinnedThreads: [row('long-task', 'active')], threads: [row('orphan', 'idle'), row('unloaded', 'notLoaded')] });
    const activity = new DesktopRuntimeActivity(lookup); const result = await activity.read(['long-task','orphan','unloaded']);
    expect(result.get('long-task')).toBe(true); expect(result.get('orphan')).toBe(false); expect(result.get('unloaded')).toBe(false);
    expect(lookup).toHaveBeenCalledExactlyOnceWith('list_threads', { limit: 50 }, 'long-task');
  });
  it('checks tasks outside the recent window individually without activating them', async () => {
    const lookup = vi.fn(async (name: string) => name === 'list_threads' ? { pinnedThreads: [], threads: [] } : { thread: row('older-active', { type: 'active' }) });
    const activity = new DesktopRuntimeActivity(lookup);
    expect((await activity.read(['older-active'])).get('older-active')).toBe(true);
    expect(lookup).toHaveBeenLastCalledWith('read_thread', { threadId: 'older-active', hostId: 'local', turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 1 }, 'older-active');
  });
  it('does not use a remote-host or other-kind task as local running evidence', async () => {
    const lookup = vi.fn(async (name: string) => name === 'list_threads' ? { pinnedThreads: [], threads: [row('same-id','active','remote'), { ...row('other-kind','active'), kind: 'chatgpt' }] } : { thread: row('same-id', { type: 'active' }, 'remote') });
    const activity = new DesktopRuntimeActivity(lookup); const result = await activity.read(['same-id','other-kind']);
    expect(result.get('same-id')).toBeUndefined(); expect(result.get('other-kind')).toBeUndefined();
  });
  it('does not invent running state when native lookups fail or return malformed data', async () => {
    const failed = new DesktopRuntimeActivity(vi.fn().mockRejectedValue(new Error('unavailable')));
    expect((await failed.read(['task'])).get('task')).toBeUndefined();
    const malformed = new DesktopRuntimeActivity(vi.fn().mockResolvedValue({ threads: 'invalid' }));
    expect((await malformed.read(['task'])).get('task')).toBeUndefined();
  });
  it('expires short-lived status evidence and clears it after a desktop reconnect', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000); let status = 'active';
    const lookup = vi.fn(async () => ({ pinnedThreads: [], threads: [row('task', status)] }));
    const activity = new DesktopRuntimeActivity(lookup); expect((await activity.read(['task'])).get('task')).toBe(true);
    status = 'idle'; clock.mockReturnValue(1500); expect((await activity.read(['task'])).get('task')).toBe(true); expect(lookup).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(3001); expect((await activity.read(['task'])).get('task')).toBe(false);
    activity.clear(); status = 'active'; expect((await activity.read(['task'])).get('task')).toBe(true); expect(lookup).toHaveBeenCalledTimes(3);
  });
  it('discards a live-status response from a disconnected desktop generation', async () => {
    let resolve!: (value: any) => void; const lookup = vi.fn(() => new Promise(r => { resolve = r; }));
    const activity = new DesktopRuntimeActivity(lookup); const pending = activity.read(['task']); activity.clear(); resolve({ pinnedThreads: [], threads: [row('task','active')] });
    expect((await pending).size).toBe(0);
  });
  it('bounds individual lookups and caches their results between adjacent pages', async () => {
    let inFlight = 0; let maximum = 0;
    const lookup = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'list_threads') return { pinnedThreads: [], threads: [] };
      inFlight++; maximum = Math.max(maximum, inFlight); await new Promise(r => setTimeout(r, 5)); inFlight--;
      return { thread: row(String(args.threadId), { type: 'idle' }) };
    });
    const activity = new DesktopRuntimeActivity(lookup); const ids = Array.from({ length: 12 }, (_, i) => `task-${i}`);
    expect((await activity.read(ids)).size).toBe(12); await activity.read(ids);
    expect(maximum).toBeLessThanOrEqual(4); expect(lookup).toHaveBeenCalledTimes(13);
  });
  it('projects the same idle result through both task lists and activity polling', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-activity-')); const id = randomUUID();
    const file = join(dir, 'orphan.jsonl'); writeFileSync(file, JSON.stringify({ timestamp: '2020-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'abandoned' } }) + '\n');
    const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT,name TEXT,title TEXT,cwd TEXT,updated_at_ms INTEGER,updated_at INTEGER,archived INTEGER,source TEXT,project_id TEXT,rollout_path TEXT)');
    db.prepare("INSERT INTO threads VALUES(?,NULL,'Fixture','C:/fixture',1,1,0,'vscode',NULL,?)").run(id, file); db.close();
    const adapter = new CodexDesktop('unused', dir);
    vi.spyOn(adapter as any, 'ready').mockResolvedValue(undefined); vi.spyOn(adapter as any, 'projects').mockResolvedValue([]);
    vi.spyOn(adapter as any, 'appTool').mockResolvedValue({ pinnedThreads: [], threads: [row(id,'idle')] });
    try {
      const list: any = await adapter.execute({ method: 'list', params: { offset: 0 } }, randomUUID());
      const poll: any = await adapter.execute({ method: 'activity', params: { ids: [id] } }, randomUUID());
      expect(list.conversations[0].running).toBe(false); expect(poll.activities[0].running).toBe(false);
    } finally { adapter.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
