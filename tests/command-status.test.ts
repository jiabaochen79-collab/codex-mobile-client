import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentStore } from '../src/agent/store.js';
import { RemoteError, type Command } from '../src/shared/protocol.js';

const dir = mkdtempSync(join(tmpdir(), 'command-status-'));
let store: AgentStore;
afterEach(() => { store?.close(); rmSync(dir, { recursive: true, force: true }); });
describe('durable command confirmation', () => {
  it('retains confirmed outcomes across restart and isolates task and session', async () => {
    store = new AgentStore(dir);
    const id = randomUUID(), task = randomUUID(), session = randomUUID();
    const command: Command = { method: 'send', params: { id: task, text: 'private', epoch: 'fixture' } };
    await store.once(id, command, async () => ({ accepted: true }), session);
    expect(store.commandStatus(id, session, task)).toEqual({ state: 'succeeded' });
    expect(store.commandStatus(id, randomUUID(), task)).toEqual({ state: 'unknown' });
    expect(store.commandStatus(id, session, randomUUID())).toEqual({ state: 'unknown' });
    store.close(); store = new AgentStore(dir);
    expect(store.commandStatus(id, session, task)).toEqual({ state: 'succeeded' });
    await expect(store.once(id, command, async () => { throw new Error('must not execute'); }, session)).resolves.toEqual({ accepted: true });
    await expect(store.once(id, command, async () => ({}), randomUUID())).rejects.toMatchObject({ code: 'AUTH' });
  });
  it('distinguishes in-flight work, rejection and an uncertain native outcome', async () => {
    store = new AgentStore(dir);
    const task = randomUUID(), session = randomUUID(), id = randomUUID();
    const command: Command = { method: 'send', params: { id: task, text: 'fixture', epoch: 'fixture' } };
    let release!: () => void;
    const work = store.once(id, command, () => new Promise<void>(r => { release = r; }), session);
    expect(store.commandStatus(id, session, task)).toEqual({ state: 'pending' }); release(); await work;
    const rejected = randomUUID(), unknown = randomUUID();
    await expect(store.once(rejected, command, async () => { throw new RemoteError('BUSY', 'fixture busy'); }, session)).rejects.toMatchObject({ code: 'BUSY' });
    expect(store.commandStatus(rejected, session, task)).toEqual({ state: 'failed', error: { code: 'BUSY', message: 'fixture busy' } });
    await expect(store.once(unknown, command, async () => { throw new RemoteError('OUTCOME_UNKNOWN', 'lost native ack'); }, session)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(store.commandStatus(unknown, session, task)).toEqual({ state: 'unknown' });
  });
  it('does not treat an internal exception after execution as a confirmed rejection', async () => {
    store = new AgentStore(dir);
    const task = randomUUID(), session = randomUUID(), id = randomUUID();
    const command: Command = { method: 'send', params: { id: task, text: 'fixture', epoch: 'fixture' } };
    let performed = 0;
    await expect(store.once(id, command, async () => { performed++; throw new RemoteError('INTERNAL', 'ack failed'); }, session)).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(store.commandStatus(id, session, task)).toEqual({ state: 'unknown' });
    await expect(store.once(id, command, async () => { performed++; }, session)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(performed).toBe(1);
  });
});
