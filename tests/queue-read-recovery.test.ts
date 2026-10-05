import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Agent } from '../src/agent/agent.js';
import { CodexDesktop } from '../src/agent/desktop.js';

describe('queue recovery during rollout replacement', () => {
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
