import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopRecovery, type DesktopExit } from '../src/agent/desktop-recovery.js';
import type { DesktopProcess } from '../src/shared/protocol.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean(); vi.restoreAllMocks(); });
const processIdentity = { processId: 123, startedAt: '100', version: '26.1.0' };
const crash: DesktopExit = { code: '0xc0000005', at: Date.now(), version: '26.1.0', cause: 'crash' };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(values = new Map<string, string>()) {
  let now = 0;
  const dir = mkdtempSync(join(tmpdir(), 'client-recovery-'));
  const watches: { identity: DesktopProcess; exit: (value: DesktopExit) => void; error: () => void; cancel: ReturnType<typeof vi.fn> }[] = [];
  const backend = { launch: vi.fn(async (authorize: () => void) => { authorize(); return { launched: true }; }), watch: vi.fn((identity: DesktopProcess, exit: (value: DesktopExit) => void, error: () => void) => { const row = { identity, exit, error, cancel: vi.fn() }; watches.push(row); return row.cancel; }) };
  const interrupted = vi.fn();
  const recovery = new DesktopRecovery({ dir, key: 'test', store: { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => { values.set(key, value); } }, backend, interrupted, now: () => now });
  recovery.setAllowed(true);
  cleanups.push(async () => { await recovery.close(); rmSync(dir, { recursive: true, force: true }); });
  return { recovery, backend, interrupted, watches, values, dir, advance: async (ms: number, identity?: DesktopProcess) => { now += ms; recovery.observe(identity ?? null, !!identity); recovery.tick(); await flush(); } };
}
it('starts only after an observed crash and preserves exit diagnostics without task content', async () => {
  const f = fixture(); f.recovery.observe(null, false); await f.advance(10000); expect(f.backend.launch).not.toHaveBeenCalled();
  f.recovery.observe(processIdentity, true); f.watches[0].exit({ ...crash, module: 'desktop.dll', exception: 'c0000005' });
  expect(f.interrupted).toHaveBeenCalledTimes(1); expect(f.recovery.state.phase).toBe('backoff');
  await f.advance(2999); expect(f.backend.launch).not.toHaveBeenCalled(); await f.advance(1); expect(f.backend.launch).toHaveBeenCalledTimes(1);
  expect(f.recovery.state.phase).toBe('connecting'); f.recovery.observe({ ...processIdentity, startedAt: '200' }, true);
  expect(f.recovery.state.phase).toBe('recovered'); expect(f.recovery.state.lastExit).not.toHaveProperty('module');
  const logs = readFileSync(join(f.dir, 'logs/desktop-recovery.jsonl'), 'utf8'); expect(logs).toContain('desktop.dll'); expect(logs).not.toContain('prompt');
});
it.each(['normal', 'session-ending'] as const)('does not restart after %s exit', async cause => {
  const f = fixture(); f.recovery.observe(processIdentity, true); f.watches[0].exit({ ...crash, code: '0x00000000', cause });
  await f.advance(60000); expect(f.backend.launch).not.toHaveBeenCalled(); expect(f.interrupted).not.toHaveBeenCalled();
});
it('does not restart or kill a running desktop on IPC failure or uncertain discovery', async () => {
  const f = fixture(); f.recovery.observe(processIdentity, true); f.recovery.observe(processIdentity, false); f.recovery.observe(undefined, false);
  await f.advance(120000); expect(f.backend.launch).not.toHaveBeenCalled(); expect(f.watches[0].cancel).not.toHaveBeenCalled();
});
it('uses three backoff attempts then stops, retaining the budget across helper restarts', async () => {
  const f = fixture(); f.backend.launch.mockRejectedValue(new Error('fixture failure')); f.recovery.observe(processIdentity, true); f.watches[0].exit(crash);
  await f.advance(3000); await f.advance(14999); expect(f.backend.launch).toHaveBeenCalledTimes(1); await f.advance(1); await f.advance(45000);
  expect(f.backend.launch).toHaveBeenCalledTimes(3); expect(f.recovery.state).toMatchObject({ phase: 'failed', attempts: 3 });
  await f.advance(300000); expect(f.backend.launch).toHaveBeenCalledTimes(3);
  const next = fixture(f.values); expect(next.recovery.state.attempts).toBe(3); next.recovery.observe(processIdentity, true); next.watches[0].exit(crash); await next.advance(45000); expect(next.backend.launch).not.toHaveBeenCalled();
});
it('requires readiness and compatibility, then resets the budget only after five healthy minutes', async () => {
  const f = fixture(); f.recovery.observe(processIdentity, true); f.watches[0].exit(crash); await f.advance(3000);
  const reopened = { ...processIdentity, startedAt: '200' }; f.recovery.observe(reopened, false); expect(f.recovery.state.phase).toBe('connecting');
  f.recovery.observe(reopened, true); expect(f.recovery.state.phase).toBe('recovered'); await f.advance(299999, reopened); expect(f.recovery.state.attempts).toBe(1);
  await f.advance(1, reopened); expect(f.recovery.state.attempts).toBe(0);
});
it('times out readiness and schedules the next attempt without reporting recovered', async () => {
  const f = fixture(); f.recovery.observe(processIdentity, true); f.watches[0].exit(crash); await f.advance(3000); await f.advance(60000);
  expect(f.recovery.state.phase).toBe('backoff'); expect(f.recovery.state.recoveredAt).toBeUndefined(); await f.advance(15000); expect(f.backend.launch).toHaveBeenCalledTimes(2);
});
it('cancels a pending retry when the user opens the desktop independently', async () => {
  const f = fixture(); f.recovery.observe(processIdentity, true); f.watches[0].exit(crash); f.recovery.observe({ ...processIdentity, startedAt: '200' }, true); await f.advance(3000);
  expect(f.backend.launch).not.toHaveBeenCalled(); expect(f.recovery.state.nextRetryAt).toBeUndefined();
});
it('ignores an old watcher after a new process with the same PID appears', () => {
  const f = fixture(); f.recovery.observe(processIdentity, true); f.recovery.observe({ ...processIdentity, startedAt: '200' }, true); f.watches[0].exit(crash);
  expect(f.watches[0].cancel).toHaveBeenCalledTimes(1); expect(f.interrupted).not.toHaveBeenCalled(); expect(f.recovery.state.phase).toBe('watching');
});
it('does not treat cached readiness of an exited process as recovery', () => {
  const f = fixture(); f.recovery.observe(processIdentity, true); f.watches[0].exit(crash); f.recovery.observe(processIdentity, true);
  expect(f.recovery.state.phase).toBe('backoff'); expect(f.recovery.state.recoveredAt).toBeUndefined();
});
it.each(['pause', 'revoke', 'close'] as const)('rechecks %s before deferred activation', async action => {
  const f = fixture(); let dispatch!: () => void; const activated = vi.fn();
  f.backend.launch.mockImplementation(authorize => new Promise(resolve => { dispatch = () => { try { authorize(); activated(); resolve({ launched: true }); } catch { resolve({ launched: false }); } }; }));
  f.recovery.observe(processIdentity, true); f.watches[0].exit(crash); await f.advance(3000);
  let closing: Promise<void> | undefined;
  if (action === 'pause') f.recovery.request('pause', () => {}); else if (action === 'revoke') f.recovery.setAllowed(false); else closing = f.recovery.close();
  dispatch(); await flush(); await closing;
  expect(activated).not.toHaveBeenCalled(); expect(f.recovery.state.phase).toBe('paused');
});
it('blocks double manual clicks and keeps the automatic retry budget when enabling again', async () => {
  const f = fixture(); f.recovery.request('launch', () => {}); f.recovery.request('launch', () => {}); await flush(); expect(f.backend.launch).toHaveBeenCalledTimes(1);
  f.recovery.request('pause', () => {}); f.recovery.request('enable', () => {}); expect(f.recovery.state.attempts).toBe(1);
  expect(() => f.recovery.request('launch', () => {})).toThrow('30 秒');
  const next = fixture(f.values); expect(next.recovery.state.autoEnabled).toBe(true);
});
it('retries a failed watcher without assuming a crash', async () => {
  const f = fixture(); f.recovery.observe(processIdentity, true); f.watches[0].error(); f.recovery.observe({ ...processIdentity }, true);
  expect(f.watches).toHaveLength(2); await f.advance(60000); expect(f.backend.launch).not.toHaveBeenCalled();
  f.watches[1].exit(crash); await f.advance(3000); expect(f.backend.launch).toHaveBeenCalledTimes(1);
});
it('cancels automatic retry when a relaunched desktop closes normally', async () => {
  const f = fixture(); f.recovery.observe(processIdentity, true); f.watches[0].exit(crash); await f.advance(3000); f.recovery.observe({ ...processIdentity, startedAt: '200' }, false);
  f.watches[1].exit({ ...crash, cause: 'normal', code: '0x00000000' }); await f.advance(60000); expect(f.backend.launch).toHaveBeenCalledTimes(1);
});
it('does not turn a failed manual request into unapproved automatic launches', async () => {
  const f = fixture(); f.backend.launch.mockRejectedValue(new Error('permission revoked'));
  f.recovery.request('launch', () => {}); await flush(); await f.advance(120000);
  expect(f.backend.launch).toHaveBeenCalledTimes(1); expect(f.recovery.state.phase).toBe('failed');
});
it('keeps diagnostics across restart without recovering a historical crash automatically', async () => {
  const f = fixture(); f.recovery.observe(processIdentity, true); f.watches[0].exit(crash);
  const next = fixture(f.values); expect(next.recovery.state.lastExit).toMatchObject(crash); await next.advance(120000); expect(next.backend.launch).not.toHaveBeenCalled();
});
