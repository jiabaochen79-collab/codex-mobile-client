import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Agent } from '../src/agent/agent.js';
import { CodexDesktop } from '../src/agent/desktop.js';
import { RemoteError } from '../src/shared/protocol.js';

describe('queue recovery during rollout replacement', () => {
  it.each(['CLIENT_REJECTED', 'OUTCOME_UNKNOWN', 'UNAVAILABLE', 'STALE', 'CLIENT_UNAVAILABLE'])('recovers a %s read without replaying a dispatched send', async code => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-read-error-')); const task = randomUUID(), session = randomUUID();
    let healthy = false, dispatched = false, sends = 0;
    const adapter: any = { close() {}, execute: async (command: any, _id: string, authorize?: () => void) => {
      if (command.method === 'read') { if (!healthy) throw new RemoteError(code, 'transient read failure'); return { id: task, epoch: 'epoch', busy: false, requests: [], nativeQueuedCount: 0, messages: [] }; }
      sends++; authorize?.(); dispatched = true; throw new RemoteError('OUTCOME_UNKNOWN', 'send acknowledgement lost');
    } };
    const agent = new Agent({ origin: 'http://127.0.0.1:8790', dir, adapter }); const state = agent as any;
    vi.spyOn(state.store, 'protect').mockImplementation((value: any) => value);
    state.notifyQueue = () => {}; state.updateSubscriptions = () => {};
    state.queueAuthorization = async () => ({ allowed: true, validForMs: 10000 });
    state.enabled = true; state.connection = 'online'; state.grants.set(session, Date.now() + 60000);
    try {
      const row = state.sends.add(randomUUID(), task, session, 'epoch', { text: 'queued', attachments: [] });
      await state.dispatchQueued(row); expect(state.sends.get(row.id, task).state).toBe('pending'); expect(sends).toBe(0);
      expect(state.sends.get(row.id, task).reason).toBe('transient read failure');
      healthy = true; await state.dispatchQueued(state.sends.get(row.id, task));
      expect(dispatched).toBe(true); expect(sends).toBe(1); expect(state.sends.get(row.id, task).state).toBe('uncertain');
      await state.dispatchQueued(state.sends.get(row.id, task)); expect(sends).toBe(1);
    } finally { await agent.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['epoch', 'authorization', 'send'])('keeps the queue paused after a real %s failure', async failure => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-read-guard-')); const task = randomUUID(), session = randomUUID();
    const execute = vi.fn(async (command: any) => {
      if (command.method === 'read') return { id: task, epoch: failure === 'epoch' ? 'new-epoch' : 'epoch', busy: false, requests: [], nativeQueuedCount: 0, messages: [] };
      throw new RemoteError('STALE', 'send rejected');
    });
    const agent = new Agent({ origin: 'http://127.0.0.1:8790', dir, adapter: { execute, close() {} } as any }); const state = agent as any;
    vi.spyOn(state.store, 'protect').mockImplementation((value: any) => value);
    state.notifyQueue = () => {}; state.updateSubscriptions = () => {};
    state.queueAuthorization = async () => ({ allowed: failure !== 'authorization', validForMs: 10000 });
    state.enabled = true; state.connection = 'online'; state.grants.set(session, Date.now() + 60000);
    try {
      const row = state.sends.add(randomUUID(), task, session, 'epoch', { text: 'keep paused', attachments: [] });
      await state.dispatchQueued(row);
      expect(state.sends.get(row.id, task).state).toBe('paused');
      expect(execute.mock.calls.filter(([command]) => command.method === 'send')).toHaveLength(failure === 'send' ? 1 : 0);
      const calls = execute.mock.calls.length;
      await state.dispatchQueued(state.sends.get(row.id, task)); expect(execute).toHaveBeenCalledTimes(calls);
    } finally { await agent.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('clears a transient read error after automatically sending the original queued message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-read-resume-')); const task = randomUUID(), session = randomUUID();
    let healthy = false;
    const execute = vi.fn(async (command: any, _id: string, authorize?: () => void) => {
      if (command.method === 'read') {
        if (!healthy) throw new RemoteError('STALE', 'transient read failure');
        return { id: task, epoch: 'epoch', busy: false, requests: [], nativeQueuedCount: 0, messages: [] };
      }
      authorize?.(); return { accepted: true };
    });
    const agent = new Agent({ origin: 'http://127.0.0.1:8790', dir, adapter: { execute, close() {} } as any }); const state = agent as any;
    vi.spyOn(state.store, 'protect').mockImplementation((value: any) => value);
    state.notifyQueue = () => {}; state.updateSubscriptions = () => {};
    state.queueAuthorization = async () => ({ allowed: true, validForMs: 10000 });
    state.enabled = true; state.connection = 'online'; state.grants.set(session, Date.now() + 60000);
    try {
      const row = state.sends.add(randomUUID(), task, session, 'epoch', { text: 'original queued message', attachments: [] });
      await state.dispatchQueued(row); healthy = true;
      await state.dispatchQueued(state.sends.get(row.id, task));
      expect(state.sends.list(task)).toEqual([]);
      const sends = execute.mock.calls.filter(([command]) => command.method === 'send');
      expect(sends).toHaveLength(1); expect(sends[0][0].params).toMatchObject({ id: task, text: 'original queued message' });
      expect(sends[0][1]).toBe(row.attempt);
    } finally { await agent.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('cleans only expired unheld reservations before checking update blockers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-upload-cleanup-'));
    const agent = new Agent({ origin: 'http://127.0.0.1:8790', dir, adapter: { close() {} } as any }); const state = agent as any;
    const begin = () => state.uploads.begin(randomUUID(), 'owner', { id: randomUUID(), name: 'fixture.txt', size: 10, sha256: 'a'.repeat(64) });
    try {
      const expired = begin(); state.store.db.prepare('UPDATE uploads SET created=? WHERE id=?').run(Date.now() - 2 * 86400000, expired.id);
      expect(await state.updateBlockers()).toEqual([]); expect(() => state.uploads.status(expired.id, 'owner')).toThrow();
      const held = begin(); state.store.db.prepare('INSERT INTO upload_holds VALUES(?,?)').run('queue-fixture', held.id);
      state.store.db.prepare('UPDATE uploads SET created=? WHERE id=?').run(Date.now() - 2 * 86400000, held.id);
      expect(await state.updateBlockers()).toContain('有尚未完成的附件上传'); expect(state.uploads.status(held.id, 'owner')).toBeDefined();
    } finally { await agent.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('preserves queued messages while a live task rollout is temporarily missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-read-recovery-'));
    const task = randomUUID(), session = randomUUID(), file = join(dir, 'task.jsonl');
    const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT,archived INTEGER,source TEXT,rollout_path TEXT)');
    db.prepare('INSERT INTO threads VALUES(?,0,?,?)').run(task, 'vscode', file); db.close();
    const desktop = new CodexDesktop('unused', dir);
    const agent = new Agent({ origin: 'http://127.0.0.1:8790', dir: join(dir, 'agent'), adapter: desktop });
    const state = agent as any;
    const ready = vi.spyOn(desktop as any, 'ready').mockResolvedValue(undefined);
    const protect = vi.spyOn(state.store, 'protect').mockImplementation((value: any) => value);
    try {
      state.grants.set(session, Date.now() + 60000);
      const queued = state.sends.add(randomUUID(), task, session, 'epoch', { text: 'keep this message', attachments: [] });
      await state.dispatchQueued(queued);
      expect(state.sends.list(task)).toEqual([expect.objectContaining({ text: 'keep this message', state: 'pending' })]);
      writeFileSync(file, '');
      expect(() => (desktop as any).known(task)).not.toThrow();
      expect(state.sends.entries(task)).toHaveLength(1);
    } finally { ready.mockRestore(); protect.mockRestore(); await agent.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
