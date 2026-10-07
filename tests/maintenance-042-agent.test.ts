import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Agent } from '../src/agent/agent.js';
import { AgentStore } from '../src/agent/store.js';
import { CompletionMonitor } from '../src/agent/notifications.js';
it('clock rollback captures a new completion exactly once across restart', async () => {
  const dir = mkdtempSync(join(process.cwd(), '.runtime/audit-clock-'));
  const store = new AgentStore(dir), path = join(dir, 'rollout.jsonl'), id = randomUUID();
  const before = Date.now();
  const monitor = new CompletionMonitor(store, () => [{ id, path }]);
  try {
    writeFileSync(path, ''); monitor.watch(id, before); await monitor.poll();
    appendFileSync(path, JSON.stringify({ timestamp: new Date(before - 60000).toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'new-round-after-clock-correction' } }) + '\n');
    await monitor.poll();
    expect(store.notificationCursor(path)!.offset).toBeGreaterThan(0);
    expect(store.notificationOutbox()).toEqual([expect.objectContaining({ turnId: 'new-round-after-clock-correction' })]);
    monitor.close(); const recovered = new CompletionMonitor(store, () => [{ id, path }]);
    try { await recovered.poll(); expect(store.notificationOutbox()).toHaveLength(1); } finally { recovered.close(); }
  } finally { monitor.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
it('temporary computer fingerprint failure is retried by bounded helper refreshes', async () => {
  const dir = mkdtempSync(join(process.cwd(), '.runtime/audit-fingerprint-'));
  const agent = new Agent({ origin: 'http://127.0.0.1:8790', dir, adapter: { async status() { return { available: true, version: 'fixture', reason: null }; }, execute: vi.fn(), close() {} } }), state = agent as any;
  const frames: any[] = [];
  state.socket = { readyState: 1, bufferedAmount: 0, send: (value: string) => frames.push(JSON.parse(value)), ping() {}, close() {} };
  state.lastPong = Date.now(); state.lastPing = Date.now();
  const fingerprint = vi.spyOn(state, 'readComputerFingerprint').mockResolvedValueOnce(undefined).mockResolvedValue('f'.repeat(64));
  try {
    await state.announceComputer();
    for (let i = 0; i < 3; i++) await state.refresh();
    expect(fingerprint).toHaveBeenCalledTimes(1);
    state.computerIdentityRetryAt = 0; await state.refresh(); await Promise.resolve();
    expect(fingerprint).toHaveBeenCalledTimes(2); expect(frames.filter(frame => frame.type === 'computer')).toHaveLength(1);
    await state.refresh(); expect(fingerprint).toHaveBeenCalledTimes(2);
  } finally { await agent.close(); rmSync(dir, { recursive: true, force: true }); }
});
