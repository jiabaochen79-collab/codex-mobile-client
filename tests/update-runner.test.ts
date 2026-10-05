import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign, createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { runUpdate } from '../src/agent/update-runner.js';

const verification = vi.hoisted(() => ({ publicKey: '' }));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:timers/promises', () => ({ setTimeout: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) }));
vi.mock('../src/shared/release-signature.js', async original => {
  const real = await original<typeof import('../src/shared/release-signature.js')>();
  return { ...real, verifyRelease: (release: Parameters<typeof real.verifyRelease>[0]) => real.verifyRelease(release, verification.publicKey), fileDigest: async (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex') };
});

describe.skipIf(process.platform !== 'win32')('isolated update installation and recovery', () => {
  let dir: string;
  let root: string;
  let cache: string;
  let job: any;
  let runningVersion: string;
  let nextExit: number;
  let previousExit: number;
  let legacyRollback: boolean;
  const installs: string[] = [];
  const launches: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    dir = mkdtempSync(join(process.cwd(), '.runtime/update-runner-'));
    root = join(dir, 'app'); cache = join(dir, 'data/updates');
    mkdirSync(root, { recursive: true }); mkdirSync(cache, { recursive: true });
    writeFileSync(join(root, 'RemoteCompanion.exe'), 'synthetic helper, never executed');
    const keys = generateKeyPairSync('ed25519');
    verification.publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const release = (version: string, sequence: number) => {
      const bytes = Buffer.from('synthetic installer ' + version);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      writeFileSync(join(cache, sha256 + '.exe'), bytes);
      const payload = Buffer.from(JSON.stringify({ version, sequence, platform: 'win32-x64', size: bytes.length, sha256, path: '/api/updates/download/' + sha256, notes: 'Synthetic test release', issuedAt: Date.now() }));
      return { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') };
    };
    job = { root, dataDir: join(dir, 'data'), next: release('0.4.26', 26), previous: release('0.4.25', 25), nonce: randomUUID() };
    installs.length = 0; launches.length = 0; runningVersion = ''; nextExit = 0; previousExit = 0; legacyRollback = false;
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ mode: 'desktop' })));
    vi.mocked(spawn).mockImplementation((file, args) => {
      const parameters = args as string[];
      const child = Object.assign(new EventEmitter(), { unref: vi.fn(), pid: 12344 });
      if (String(file).endsWith('RemoteCompanion.exe')) {
        if (parameters[0] === '--update-health') {
          runningVersion = parameters[2]; launches.push(runningVersion);
          writeFileSync(join(cache, 'health-' + parameters[1] + '.json'), JSON.stringify({ nonce: parameters[1], version: runningVersion, localReady: true, ...(!legacyRollback || runningVersion !== '0.4.25' ? { port: 18899, pid: 12345 } : {}) }));
        } else launches.push('fallback');
      } else {
        const manifest = [job.next, job.previous].map(release => JSON.parse(Buffer.from(release.payload, 'base64').toString())).find(release => String(file).endsWith(release.sha256 + '.exe'));
        expect(manifest).toBeDefined(); installs.push(manifest.version);
      }
      queueMicrotask(() => { child.emit('spawn'); child.emit('exit', String(file).endsWith('RemoteCompanion.exe') ? 0 : installs.at(-1) === '0.4.26' ? nextExit : previousExit); });
      return child as unknown as ChildProcess;
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
  async function perform(ms = 110000) {
    const file = join(dir, 'job.json'); writeFileSync(file, JSON.stringify(job));
    const pending = runUpdate(file);
    void pending.catch(() => {});
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled(), { timeout: 2000 });
    await vi.advanceTimersByTimeAsync(ms); await pending;
    return JSON.parse(readFileSync(join(cache, 'result.json'), 'utf8'));
  }

  it('requires repeated local health checks before declaring the next version installed', async () => {
    const result = await perform();
    expect(result.phase).toBe('installed'); expect(installs).toEqual(['0.4.26']);
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(launches).toEqual(['0.4.26']);
  });
  it('rolls back when a new helper writes its startup marker then crashes', async () => {
    let calls = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      if (runningVersion === '0.4.26' && ++calls > 1) throw new TypeError('Synthetic local helper exited');
      return Response.json({ mode: 'desktop' });
    });
    const result = await perform();
    expect(result.phase).toBe('rolled_back'); expect(installs).toEqual(['0.4.26', '0.4.25']);
  });
  it('does not accept a stale marker when the agent process is gone', async () => {
    vi.mocked(process.kill).mockImplementation(() => { if (runningVersion === '0.4.26') throw new Error('No such process'); return true; });
    expect((await perform()).phase).toBe('rolled_back');
  });
  it('restores the previous version when the candidate installer fails', async () => {
    nextExit = 1; expect((await perform()).phase).toBe('rolled_back');
    expect(installs).toEqual(['0.4.26', '0.4.25']); expect(launches).toEqual(['0.4.25']);
  });
  it('attempts to start the remaining verified program when both installers fail', async () => {
    nextExit = 1; previousExit = 1; expect((await perform()).phase).toBe('failed');
    expect(launches).toEqual(['fallback']);
  });
  it('uses only local health checks and does not roll back for a server outage', async () => {
    expect((await perform()).phase).toBe('installed');
    for (const [url] of vi.mocked(fetch).mock.calls) expect(String(url)).toBe('http://127.0.0.1:18899/api/bootstrap');
  });
  it('verifies legacy rollback health without requiring new marker fields', async () => {
    nextExit = 1; legacyRollback = true; vi.stubEnv('LOCAL_PORT', '18898');
    vi.mocked(fetch).mockImplementation(async url => {
      if (String(url) !== 'http://127.0.0.1:18899/api/bootstrap') throw new TypeError('Unused synthetic port');
      return Response.json({ mode: 'desktop' });
    });
    expect((await perform()).phase).toBe('rolled_back');
    expect(process.kill).toHaveBeenCalledWith(12344, 0);
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(10);
  });
  it('rejects a corrupted cached installer before spawning any native process', async () => {
    const next = JSON.parse(Buffer.from(job.next.payload, 'base64').toString());
    writeFileSync(join(cache, next.sha256 + '.exe'), Buffer.alloc(next.size));
    const file = join(dir, 'job.json'); writeFileSync(file, JSON.stringify(job));
    await expect(runUpdate(file)).rejects.toThrow('Package verification failed');
    expect(spawn).not.toHaveBeenCalled();
  });
});
