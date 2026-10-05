import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStore } from '../src/agent/store.js';
import { RemoteError } from '../src/shared/protocol.js';

describe('durable create reconciliation', () => {
  it('returns the original created task without repeating creation after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'remote-create-test-')); let store = new AgentStore(dir); let calls = 0;
    const command = { method: 'create' as const, params: { projectId: 'fixture-project', text: 'Create once' } };
    const perform = async () => { calls++; return { threadId: '11111111-1111-4111-8111-111111111111' }; };
    try {
      const original = await store.once('request-id', command, perform, 'session'); store.close(); store = new AgentStore(dir);
      expect(await store.once('request-id', command, perform, 'session')).toEqual(original); expect(calls).toBe(1);
      await expect(store.once('request-id', command, perform, 'another-session')).rejects.toMatchObject({ code: 'AUTH' });
      expect(calls).toBe(1);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('never repeats creation when the first dispatch has an unknown result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'remote-create-test-')); const store = new AgentStore(dir); let calls = 0;
    const command = { method: 'create' as const, params: { projectId: 'fixture-project', text: 'Uncertain creation' } };
    const perform = async () => { calls++; throw new RemoteError('OUTCOME_UNKNOWN', 'Lost confirmation'); };
    try {
      await expect(store.once('request-id', command, perform, 'session')).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
      await expect(store.once('request-id', command, perform, 'session')).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
      expect(calls).toBe(1);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
