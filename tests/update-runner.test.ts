import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { runUpdate } from '../src/agent/update-runner.js';
import { HelperUpdater } from '../src/agent/updater.js';
import { setTimeout as realTimeout } from 'node:timers';
import { updateProcesses } from '../src/agent/update-process.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('../src/agent/update-process.js', () => ({ updateProcesses: vi.fn(async () => []) }));
vi.mock('node:timers/promises', () => ({ setTimeout: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) }));
vi.mock('../src/shared/release-metadata.js', async original => {
  const real = await original<typeof import('../src/shared/release-metadata.js')>();
  return { ...real, fileDigest: async (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex') };
});

describe.skipIf(process.platform !== 'win32')('isolated update installation and recovery', () => {
  let dir: string;
  let root: string;
  let cache: string;
  let job: any;
  let runningVersion: string;
  let nextExit: number;
  let damageBackup: boolean;
  let legacyRollback: boolean;
  let hungVersion: string;
  let hungChild: EventEmitter;
  const installs: string[] = [];
  const launches: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    dir = mkdtempSync(join(process.cwd(), '.runtime/update-runner-'));
    root = join(dir, 'app'); cache = join(dir, 'data/updates');
    mkdirSync(root, { recursive: true }); mkdirSync(cache, { recursive: true });
    writeFileSync(join(root, 'RemoteCompanion.exe'), 'synthetic helper, never executed');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'codex-mobile', version: '0.4.25' }));
    writeFileSync(join(root, 'node.exe'), 'synthetic node');
    mkdirSync(join(root, 'dist')); writeFileSync(join(root, 'dist/agent.mjs'), 'old agent');
    writeFileSync(join(root, 'relay.json'), JSON.stringify({ origin: 'https://example.test' }));
    const release = (version: string, sequence: number) => {
      const bytes = Buffer.from('synthetic installer ' + version);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      writeFileSync(join(cache, sha256 + '.exe'), bytes);
      return { version, sequence, platform: 'win32-x64', size: bytes.length, sha256, path: '/api/updates/download/' + sha256, notes: 'Synthetic test release', issuedAt: Date.now() };
    };
    job = { root, dataDir: join(dir, 'data'), next: release('0.4.26', 26), currentVersion: '0.4.25', nonce: randomUUID(), version: '0.4.26' };
    installs.length = 0; launches.length = 0; runningVersion = ''; nextExit = 0; damageBackup = false; legacyRollback = false; hungVersion = '';
    vi.mocked(execFile).mockImplementation((file: any, args: any, options: any, callback: any) => {
      if (args[0] === '--update-registration') { expect(args).toEqual(['--update-registration', root, '0.4.25']); callback(null); return {} as any; }
      expect(file).toBe('taskkill.exe'); expect(args).toEqual(['/PID', '12344', '/T', '/F']); expect(options.timeout).toBe(15000);
      hungChild.emit('exit', 1); callback(null); return {} as any;
    });
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
        const manifest = [job.next].map(release => release).find(release => String(file).endsWith(release.sha256 + '.exe'));
        expect(manifest).toBeDefined(); installs.push(manifest.version);
        writeFileSync(join(root, 'RemoteCompanion.exe'), 'new or partially installed helper');
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'codex-mobile', version: manifest.version }));
        writeFileSync(join(root, 'new-only.txt'), 'new file removed by restoration');
        if (damageBackup) writeFileSync(join(job.dataDir, 'updates/program-backups', job.nonce, 'program/RemoteCompanion.exe'), 'corrupt backup');
      }
      const helper = String(file).endsWith('RemoteCompanion.exe');
      const hung = !helper && installs.at(-1) === hungVersion;
      if (hung) hungChild = child;
      queueMicrotask(() => { child.emit('spawn'); if (!hung) child.emit('exit', helper ? 0 : nextExit); });
      return child as unknown as ChildProcess;
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
  async function perform(ms = 110000) {
    const file = join(dir, 'job.json'); writeFileSync(file, JSON.stringify(job));
    const pending = runUpdate(file);
    let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled(), { timeout: 5000 });
    for (let elapsed = 0; elapsed < Math.max(ms, 600000) && !settled; elapsed += 10000) { await new Promise(resolve => realTimeout(resolve, 10)); await vi.advanceTimersByTimeAsync(10000); }
    await pending;
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
    expect(result.phase).toBe('rolled_back'); expect(installs).toEqual(['0.4.26']);
    expect(readFileSync(join(root, 'RemoteCompanion.exe'), 'utf8')).toBe('synthetic helper, never executed');
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('0.4.25');
  });
  it('does not accept a stale marker when the agent process is gone', async () => {
    vi.mocked(process.kill).mockImplementation(() => { if (runningVersion === '0.4.26') throw new Error('No such process'); return true; });
    expect((await perform()).phase).toBe('rolled_back');
  });
  it('restores the previous version when the candidate installer fails', async () => {
    nextExit = 1; expect((await perform()).phase).toBe('rolled_back');
    expect(installs).toEqual(['0.4.26']); expect(launches).toEqual(['0.4.25']);
  });
  it('refuses a corrupted local backup without starting an unverified program', async () => {
    nextExit = 1; damageBackup = true; await expect(perform()).rejects.toThrow('Backup verification failed');
    expect(launches).toEqual([]); expect(installs).toEqual(['0.4.26']);
    expect(JSON.parse(readFileSync(join(cache, 'result.json'), 'utf8')).installerRunning).toBe(false);
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
    const next = job.next;
    writeFileSync(join(cache, next.sha256 + '.exe'), Buffer.alloc(next.size));
    const file = join(dir, 'job.json'); writeFileSync(file, JSON.stringify(job));
    await expect(runUpdate(file)).rejects.toThrow('Package verification failed');
    expect(spawn).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(cache, 'result.json'), 'utf8'))).toMatchObject({ phase: 'failed', version: '0.4.26', installerRunning: false });
    const freeze = vi.fn(); const updater = new HelperUpdater({ dir: job.dataDir, root, version: '0.4.25', store: { get: () => null } as any, request: async () => { throw new TypeError('Offline'); }, blockers: async () => [], freeze });
    updater.state.phase = 'installing'; updater.state.version = '0.4.26';
    await updater.reportPrevious(); expect(updater.state.phase).toBe('idle'); expect(freeze).toHaveBeenCalledWith(false); updater.close();
  });
  it('persists an early failure even if the release path no longer matches its digest', async () => {
    job.next.path = '/api/updates/download/' + '0'.repeat(64);
    const file = join(dir, 'job.json'); writeFileSync(file, JSON.stringify(job));
    await expect(runUpdate(file)).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(cache, 'result.json'), 'utf8'))).toMatchObject({ phase: 'failed', version: '0.4.26' });
  });
  it('terminates a hung installer before recovering the previous version', async () => {
    hungVersion = '0.4.26';
    const result = await perform(360000);
    expect(result.phase).toBe('rolled_back'); expect(installs).toEqual(['0.4.26']);
    expect(vi.mocked(execFile).mock.calls.filter(call => call[0] === 'taskkill.exe')).toHaveLength(1); expect(launches).toEqual(['0.4.25']);
  });
  it('preserves the backup when the restored helper fails its local health check', async () => {
    nextExit = 1; vi.mocked(fetch).mockRejectedValue(new Error('Restored helper not ready'));
    expect((await perform()).phase).toBe('failed'); expect(launches).toEqual(['0.4.25']);
    expect(readFileSync(join(job.dataDir, 'updates/program-backups', job.nonce, 'program/RemoteCompanion.exe'), 'utf8')).toBe('synthetic helper, never executed');
  });
  it('refuses restoration when the failed helper process identity has changed', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Candidate health failed'));
    vi.mocked(updateProcesses).mockImplementation(async ids => ids?.length === 1 ? [{ pid: 12344, name: 'RemoteCompanion.exe', path: join(root, 'RemoteCompanion.exe'), startedAt: 'original' }] : [{ pid: 12344, name: 'RemoteCompanion.exe', path: join(root, 'RemoteCompanion.exe'), startedAt: 'changed' }]);
    await expect(perform()).rejects.toThrow('Cannot safely identify failed helper');
    expect(launches).toEqual(['0.4.26']); expect(execFile).not.toHaveBeenCalled();
    expect(readFileSync(join(root, 'RemoteCompanion.exe'), 'utf8')).toBe('new or partially installed helper');
    expect(readFileSync(join(job.dataDir, 'updates/program-backups', job.nonce, 'program/RemoteCompanion.exe'), 'utf8')).toBe('synthetic helper, never executed');
  });
  it('does not roll back or restart alongside an installer whose termination failed', async () => {
    hungVersion = '0.4.26';
    vi.mocked(execFile).mockImplementation((_file: any, _args: any, _options: any, callback: any) => { callback(new Error('Access denied')); return {} as any; });
    const file = join(dir, 'job.json'); writeFileSync(file, JSON.stringify(job));
    const pending = runUpdate(file); void pending.catch(() => {});
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled(), { timeout: 5000 });
    await vi.advanceTimersByTimeAsync(360000);
    await expect(pending).rejects.toThrow('Installer termination failed');
    expect(installs).toEqual(['0.4.26']); expect(launches).toEqual([]);
    expect(JSON.parse(readFileSync(join(cache, 'result.json'), 'utf8')).installerRunning).toBe(true);
  });
});
