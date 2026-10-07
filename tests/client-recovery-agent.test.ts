import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Agent, createLocalServer } from '../src/agent/agent.js';
import { TERMS_VERSION } from '../src/shared/subscription.js';
import type { DesktopExit } from '../src/agent/desktop-recovery.js';
import { RemoteError } from '../src/shared/protocol.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean(); vi.restoreAllMocks(); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-agent-')); let exit!: (value: DesktopExit) => void;
  const execute = vi.fn(), launch = vi.fn(async (authorize: () => void) => { authorize(); return { launched: true }; });
  const adapter = { execute, status: async () => ({ available: false, version: null, reason: 'fixture unavailable' }), desktopProcess: () => ({ processId: 1, startedAt: '100', version: '26.1' }), close() {} };
  const agent = new Agent({ dir, origin: 'http://127.0.0.1:8790', adapter, recoveryBackend: { launch, watch: (_identity, onExit) => { exit = onExit; return () => {}; } } });
  const a = agent as any; a.enabled = true; a.notifyQueue = vi.fn(); a.updateSubscriptions = vi.fn(); await a.refresh();
  const frames: any[] = []; a.send = (frame: any) => frames.push(frame);
  const sessionId = randomUUID(), clientId = randomUUID(), epoch = randomUUID();
  a.grants.set(sessionId, Date.now() + 60000); a.control = { sessionId, clientId, epoch, expires: Date.now() + 60000 };
  const command = async (action: 'launch' | 'enable' | 'pause', override = {}) => { const id = randomUUID(); await a.message(JSON.stringify({ type: 'command', id, sessionId, clientId, controlEpoch: epoch, command: { method: 'client.recover', params: { action } }, ...override })); await a.queue; return frames.find(f => f.id === id); };
  cleanups.push(async () => { await agent.close(); rmSync(dir, { recursive: true, force: true }); });
  return { agent, a, dir, frames, execute, launch, command, sessionId, clientId, epoch, exit: () => exit({ cause: 'crash', code: '0xc0000005', at: Date.now(), version: '26.1' }) };
}
it('allows the controller to recover an unavailable desktop without forwarding desktop or task commands', async () => {
  const f = await fixture(); const result = await f.command('launch'); expect(result.error).toBeUndefined(); expect(result.result.phase).toBe('launching');
  await new Promise(resolve => setImmediate(resolve)); expect(f.launch).toHaveBeenCalledTimes(1); expect(f.execute).not.toHaveBeenCalled();
  expect(f.agent.state().client.recovery?.phase).toBe('connecting');
});
it.each(['viewer', 'revoked', 'expired', 'unsupported', 'updating'] as const)('rejects %s recovery without activation', async variant => {
  const f = await fixture();
  if (variant === 'viewer') f.a.control.clientId = randomUUID();
  if (variant === 'revoked') f.a.grants.delete(f.sessionId);
  if (variant === 'expired') f.a.subscription = { access: false };
  if (variant === 'unsupported') f.a.client.capabilities = [];
  if (variant === 'updating') f.a.updateFrozen = true;
  const result = await f.command('launch'); expect(result.error.code).toBe({ viewer: 'CONTROL_LOST', revoked: 'AUTH', expired: 'SUBSCRIPTION_REQUIRED', unsupported: 'UNSUPPORTED', updating: 'UPDATING' }[variant]);
  expect(f.launch).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
});
it('persists an administrator ban across a disconnected subscription snapshot', async () => {
  const f = await fixture();
  await f.a.message(JSON.stringify({ type: 'subscription', subscription: { mode: 'licensed', status: 'unlicensed', disabled: true, access: false, expiresAt: null, planId: null, serverTime: Date.now(), revision: 'fixture', termsVersion: TERMS_VERSION } }));
  f.a.subscription = undefined; await f.a.refresh(); expect(() => f.agent.recoverClient('launch')).toThrow('设备已停用');
  f.exit(); expect(f.agent.state().client.recovery?.phase).toBe('paused'); expect(f.launch).not.toHaveBeenCalled();
  expect(f.a.store.get('recovery:' + (await import('../src/shared/security.js')).hash('http://127.0.0.1:8790') + ':disabled')).toBe('true');
});
it('pauses durable queue entries after a crash but preserves uncertain send outcomes and task identity', async () => {
  const f = await fixture(); vi.spyOn(f.a.store, 'protect').mockImplementation(value => value);
  const task = randomUUID(), pending = f.a.sends.add(randomUUID(), task, f.sessionId, 'desktop-before-crash', { text: 'Preserve pending task', attachments: [] });
  const uncertain = f.a.sends.add(randomUUID(), task, f.sessionId, 'desktop-before-crash', { text: 'Do not replay uncertain send', attachments: [] });
  f.a.sends.mark(uncertain, 'uncertain', 'Awaiting confirmation'); f.exit();
  expect(f.a.sends.get(pending.id, task)).toMatchObject({ state: 'paused', conversation: task, epoch: 'desktop-before-crash' });
  expect(f.a.sends.get(uncertain.id, task).state).toBe('uncertain'); expect(f.execute).not.toHaveBeenCalled();
});
it('rechecks a revoked controller before an asynchronous native launch dispatch', async () => {
  const f = await fixture(); let dispatch!: () => void, denied = false;
  f.launch.mockImplementation(authorize => new Promise(resolve => { dispatch = () => { try { authorize(); } catch (e) { denied = e instanceof RemoteError; } resolve({ launched: !denied }); }; }));
  await f.command('launch'); f.a.grants.delete(f.sessionId); dispatch(); await new Promise(resolve => setImmediate(resolve)); expect(denied).toBe(true);
});
it('requires loopback authentication and matching Origin for local recovery and refuses extra launch arguments', async () => {
  const f = await fixture(), port = 18897; const app = await createLocalServer(f.agent, { port }); cleanups.unshift(async () => app.close());
  const path = '/local/client/recovery', headers = { host: '127.0.0.1:' + port, authorization: 'Bearer ' + f.agent.localToken };
  expect((await app.inject({ method: 'POST', url: path, headers: { host: headers.host }, payload: { action: 'launch' } })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: path, headers: { ...headers, origin: 'https://evil.invalid' }, payload: { action: 'launch' } })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: path, headers, payload: { action: 'launch', executable: 'arbitrary.exe' } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: path, headers, payload: { action: 'pause' } })).statusCode).toBe(200); expect(f.launch).not.toHaveBeenCalled();
});
it('invalidates cached desktop readiness immediately on a crash and exposes only an exit error code', async () => {
  const f = await fixture(); f.a.client.available = true; f.exit(); expect(f.agent.state().client.available).toBe(false);
  expect(f.agent.diagnostics()).toMatchObject({ source: 'desktop', errorCode: 'DESKTOP_EXIT_C0000005' }); expect(f.agent.diagnostics()).not.toHaveProperty('logs');
});
