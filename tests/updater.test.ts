import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HelperUpdater } from '../src/agent/updater.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn(() => { throw new Error('Unexpected native process'); }) }));
vi.mock('node:fs', async importOriginal => { const fs = await importOriginal<typeof import('node:fs')>(); return { ...fs, copyFileSync: vi.fn(), createWriteStream: vi.fn(fs.createWriteStream) }; });

describe('helper updater', () => {
  const directories: string[] = [];
  const updaters: HelperUpdater[] = [];
  const keys = generateKeyPairSync('ed25519');
  const release = (version: string, sequence: number, bytes = Buffer.from(version)) => {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const payload = Buffer.from(JSON.stringify({ version, sequence, platform: 'win32-x64', size: bytes.length, sha256, path: '/api/updates/download/' + sha256, notes: version, issuedAt: Date.now() }));
    return { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') };
  };
  const fixture = (request: (path: string, init?: RequestInit) => Promise<Response>, options: Partial<Pick<ConstructorParameters<typeof HelperUpdater>[0], 'blockers' | 'freeze'>> = {}) => {
    const dir = mkdtempSync(join(process.cwd(), '.runtime-updater-test-')); directories.push(dir);
    const updater = new HelperUpdater({ dir, root: dir, version: '0.4.16', store: { get: () => null, set: () => {} } as any, request, blockers: async () => [], freeze: () => {}, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), ...options });
    updaters.push(updater); return updater;
  };
  const latest = () => Response.json({ current: null, release: null });
  it.each([1, 65536])('finishes a disk-write failure with highWaterMark %s and permits a new check', async highWaterMark => {
    const previous = release('0.4.16', 16); const bytes = Buffer.from('0.4.17'); const candidate = release('0.4.17', 17, bytes);
    const request = vi.fn(async (path: string) => {
      if (path.includes('/check?')) return Response.json({ current: previous, release: candidate });
      let timer: ReturnType<typeof setTimeout>;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); timer = setTimeout(() => controller.close(), 30); }, cancel() { clearTimeout(timer); } }), { headers: { 'content-length': String(bytes.length) } });
    });
    const updater = fixture(request); const sha = JSON.parse(Buffer.from(previous.payload, 'base64').toString()).sha256;
    writeFileSync(join(directories.at(-1)!, 'updates', sha + '.exe'), '0.4.16');
    const output = new Writable({ highWaterMark, write(_chunk, _encoding, callback) { setTimeout(() => callback(Object.assign(new Error('disk full'), { code: 'ENOSPC' })), 5); } });
    vi.mocked(createWriteStream).mockImplementationOnce(() => output as ReturnType<typeof createWriteStream>);
    let settled = false; const checking = updater.check().finally(() => { settled = true; });
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1000 }); await checking;
    expect(updater.state.phase).toBe('error'); expect(output.destroyed).toBe(true);
    request.mockImplementation(async () => latest()); await updater.check(); expect(updater.state.phase).toBe('idle');
  });
  it('does not download or mutate the release after a cancelled check receives a late response', async () => {
    let finish!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    const request = vi.fn((path: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(resolve => { finish = resolve; });
    });
    const updater = fixture(request); const checking = updater.check();
    updater.cancel(); expect(signal?.aborted).toBe(true);
    finish(Response.json({ current: release('0.4.16', 16), release: release('0.4.17', 17) }));
    await checking;
    expect(request).toHaveBeenCalledTimes(1); expect(updater.state.phase).toBe('idle'); expect(updater.state.message).toBe('下载已暂停');
  });
  it('prunes superseded packages and partials while preserving rollback and unrelated files', async () => {
    let candidate = release('0.4.17', 17); const previous = release('0.4.16', 16);
    const updater = fixture(async path => path.includes('/check?') ? Response.json({ current: previous, release: candidate }) : Response.json({}));
    updater.setting(false); const dir = join(directories.at(-1)!, 'updates');
    const save = (envelope: ReturnType<typeof release>, suffix = '') => { const m = JSON.parse(Buffer.from(envelope.payload, 'base64').toString()); const name = m.sha256 + '.exe' + suffix; writeFileSync(join(dir, name), m.version); return name; };
    const rollback = save(previous); let retained = save(candidate);
    writeFileSync(join(dir, 'user-notes.txt'), 'keep'); mkdirSync(join(dir, 'runner'));
    for (const version of [18, 19, 20]) {
      const old = retained; save(candidate, '.part'); candidate = release('0.4.' + version, version); retained = save(candidate);
      await updater.check(); expect(existsSync(join(dir, old))).toBe(false); expect(existsSync(join(dir, old + '.part'))).toBe(false);
      expect(readdirSync(dir).filter(name => name.endsWith('.exe')).sort()).toEqual([rollback, retained].sort());
      expect(readFileSync(join(dir, 'user-notes.txt'), 'utf8')).toBe('keep');
    }
  });
  it('preserves packages referenced by an unfinished installer and skips unsafe cleanup state', async () => {
    const previous = release('0.4.16', 16), candidate = release('0.4.18', 18), active = release('0.4.17', 17);
    const updater = fixture(async () => Response.json({ current: previous, release: candidate })); updater.setting(false);
    const dir = join(directories.at(-1)!, 'updates'); mkdirSync(join(dir, 'runner'));
    const sha = JSON.parse(Buffer.from(active.payload, 'base64').toString()).sha256; writeFileSync(join(dir, sha + '.exe'), 'active');
    writeFileSync(join(dir, 'runner/job.json'), JSON.stringify({ previous, next: active, version: '0.4.17' }));
    await updater.check(); expect(existsSync(join(dir, sha + '.exe'))).toBe(true);
    writeFileSync(join(dir, 'runner/job.json'), 'invalid'); await updater.check(); expect(existsSync(join(dir, sha + '.exe'))).toBe(true);
    writeFileSync(join(dir, 'runner/job.json'), JSON.stringify({ previous, next: active, version: '0.4.17' }));
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ phase: 'installed', version: '0.4.17' }));
    await updater.check(); expect(existsSync(join(dir, sha + '.exe'))).toBe(false);
  });
  afterEach(() => { for (const updater of updaters.splice(0)) updater.close(); vi.useRealTimers(); vi.clearAllMocks(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  const readyFixture = async (blockers: () => Promise<string[]>, freeze = vi.fn()) => {
    const previous = release('0.4.16', 16), candidate = release('0.4.17', 17);
    const request = vi.fn(async (path: string) => path.startsWith('/api/updates/device/check') ? Response.json({ current: previous, release: candidate }) : Response.json({}));
    const updater = fixture(request, { blockers, freeze }); const dir = directories.at(-1)!;
    for (const envelope of [previous, candidate]) {
      const manifest = JSON.parse(Buffer.from(envelope.payload, 'base64').toString());
      writeFileSync(join(dir, 'updates', manifest.sha256 + '.exe'), manifest.version);
    }
    await updater.check(); expect(updater.state.phase).toBe('ready'); request.mockClear();
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => child.emit('spawn')); return child as unknown as ChildProcess;
    });
    return { updater, dir, request, freeze };
  };

  it('accepts only one installation while the first preflight is pending', async () => {
    let resume!: (blocks: string[]) => void;
    const blockers = vi.fn().mockReturnValueOnce(new Promise<string[]>(resolve => { resume = resolve; })).mockResolvedValue([]);
    const { updater, dir, freeze } = await readyFixture(blockers);
    const first = updater.install(); const second = updater.install().then(() => 'accepted', error => error.code);
    resume([]); await expect(first).resolves.toEqual({ accepted: true });
    expect(await second).toBe('UPDATE_NOT_READY');
    expect(spawn).toHaveBeenCalledTimes(1); expect(copyFileSync).toHaveBeenCalledTimes(2);
    expect(freeze).toHaveBeenCalledExactlyOnceWith(true);
    expect(JSON.parse(readFileSync(join(dir, 'updates/runner/job.json'), 'utf8'))).toMatchObject({ root: dir, dataDir: dir });
  });

  it('keeps installation locked against stale cancel, download and check requests', async () => {
    let resume!: (blocks: string[]) => void;
    const blockers = vi.fn().mockReturnValueOnce(new Promise<string[]>(resolve => { resume = resolve; })).mockResolvedValue([]);
    const { updater, request } = await readyFixture(blockers);
    const installing = updater.install(); updater.cancel(); await updater.download(); await updater.check();
    const phase = updater.state.phase; const calls = request.mock.calls.length;
    resume([]); await installing;
    expect(phase).toBe('ready'); expect(updater.state.phase).toBe('installing'); expect(calls).toBe(0); expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('restores readiness and unfreezes after blocked preflight so installation can be retried', async () => {
    const blockers = vi.fn().mockResolvedValueOnce(['pending approval']).mockResolvedValue([]);
    const { updater, freeze } = await readyFixture(blockers);
    await expect(updater.install()).rejects.toMatchObject({ code: 'UPDATE_BLOCKED' });
    expect(updater.state.phase).toBe('ready'); expect(freeze).toHaveBeenLastCalledWith(false); expect(spawn).not.toHaveBeenCalled();
    await expect(updater.install()).resolves.toEqual({ accepted: true }); expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('unfreezes a surviving helper after installation fails even when result reporting is offline', async () => {
    const { updater, dir, freeze, request } = await readyFixture(async () => []);
    await updater.install(); expect(updater.state.phase).toBe('installing');
    writeFileSync(join(dir, 'updates/result.json'), JSON.stringify({ phase: 'failed', version: '0.4.17', at: Date.now() }));
    request.mockRejectedValue(new TypeError('offline'));
    await updater.reportPrevious();
    expect(freeze).toHaveBeenLastCalledWith(false);
    expect(updater.state.phase).toBe('ready'); expect(updater.state.message).toContain('更新失败');
    request.mockResolvedValue(Response.json({})); await updater.install();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(existsSync(join(dir, 'updates/result.json'))).toBe(false);
    await updater.reportPrevious(); expect(updater.state.phase).toBe('installing'); expect(freeze).toHaveBeenLastCalledWith(true);
  });
  it('does not unfreeze while a timed-out installer may still be running', async () => {
    const { updater, dir, freeze } = await readyFixture(async () => []);
    await updater.install();
    writeFileSync(join(dir, 'updates/result.json'), JSON.stringify({ phase: 'failed', version: '0.4.17', installerRunning: true }));
    await updater.reportPrevious();
    expect(updater.state.phase).toBe('installing'); expect(freeze).toHaveBeenCalledExactlyOnceWith(true);
    expect(updater.state.message).toContain('尚未确认退出');
  });

  it('restarts a partial download when an intermediary returns a full 200 response', async () => {
    const previousBytes = Buffer.from('previous-package'), nextBytes = Buffer.from('next-package');
    const previous = release('0.4.16', 16, previousBytes), candidate = release('0.4.17', 17, nextBytes);
    const previousSha = createHash('sha256').update(previousBytes).digest('hex');
    const candidateSha = createHash('sha256').update(nextBytes).digest('hex');
    const ranges: string[] = [];
    const updater = fixture(async (path, init) => {
      if (path.startsWith('/api/updates/device/check')) return Response.json({ current: previous, release: candidate });
      if (path.startsWith('/api/updates/device/result')) return Response.json({});
      ranges.push(new Headers(init?.headers).get('Range') ?? '');
      return new Response(nextBytes, { headers: { 'Content-Length': String(nextBytes.length) } });
    });
    const dir = directories.at(-1)!;
    writeFileSync(join(dir, 'updates', previousSha + '.exe'), previousBytes);
    writeFileSync(join(dir, 'updates', candidateSha + '.exe.part'), nextBytes.subarray(0, 4));
    await updater.check();
    expect(updater.state.phase).toBe('ready'); expect(ranges).toEqual(['bytes=4-']);
    expect(readFileSync(join(dir, 'updates', candidateSha + '.exe'))).toEqual(nextBytes);
  });

  it.each(['installed', 'rolled_back'])('reports a late %s result without reconnecting and stops polling on close', async phase => {
    vi.useFakeTimers(); const request = vi.fn().mockResolvedValue(Response.json({})); const updater = fixture(request);
    updater.start(); await updater.reportPrevious(); expect(request).not.toHaveBeenCalled();
    const file = join(directories.at(-1)!, 'updates/result.json');
    writeFileSync(file, JSON.stringify({ phase, version: '0.4.17', at: Date.now() }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(request).toHaveBeenCalledExactlyOnceWith('/api/updates/device/result', expect.objectContaining({ body: JSON.stringify({ phase, version: '0.4.17' }) }));
    await vi.advanceTimersByTimeAsync(4000); expect(request).toHaveBeenCalledTimes(1);
    updater.close(); writeFileSync(file, JSON.stringify({ phase: 'failed', version: '0.4.18', at: Date.now() }));
    await vi.advanceTimersByTimeAsync(20000); expect(request).toHaveBeenCalledTimes(1);
  });

  it('retries a late result after a request failure and serializes polling with connection reporting', async () => {
    vi.useFakeTimers(); let finish!: (response: Response) => void;
    const request = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    const updater = fixture(request); updater.start();
    writeFileSync(join(directories.at(-1)!, 'updates/result.json'), JSON.stringify({ phase: 'rolled_back', version: '0.4.17', at: Date.now() }));
    await vi.advanceTimersByTimeAsync(2000); expect(request).toHaveBeenCalledTimes(1); expect(updater.state.message).toContain('已恢复上一版本');
    await vi.advanceTimersByTimeAsync(2000); expect(request).toHaveBeenCalledTimes(2);
    const connection = updater.reportPrevious(); await vi.advanceTimersByTimeAsync(2000);
    const calls = request.mock.calls.length; finish(Response.json({})); await connection;
    await vi.advanceTimersByTimeAsync(2000); expect(calls).toBe(2); expect(request).toHaveBeenCalledTimes(2);
  });

  it('distinguishes an unavailable update check from a failed download', async () => {
    const updater = fixture(async () => { throw new TypeError('fetch failed'); });
    await updater.check();
    expect(updater.state.phase).toBe('error');
    expect(updater.state.message).toContain('检查更新');
    expect(updater.state.message).not.toMatch(/磁盘|更新未完成|已是最新版本/);
    expect(updater.state.checkedAt).toBeNull();
  });

  it('clears the previous failure and pending retries when the server confirms the latest version', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementation(latest);
    const updater = fixture(request);
    await updater.check(); await updater.check();
    expect(updater.state).toMatchObject({ phase: 'idle', message: '已是最新版本', progress: 0, notes: '', checkedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(60000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rechecks after reconnection even when automatic retries were exhausted', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const updater = fixture(request);
    await updater.check(); await vi.advanceTimersByTimeAsync(7 * 60000);
    expect(request).toHaveBeenCalledTimes(4);
    request.mockImplementation(latest);
    await updater.connected();
    expect(updater.state).toMatchObject({ phase: 'idle', message: '已是最新版本', checkedAt: Date.now() });
    await updater.connected();
    expect(request).toHaveBeenCalledTimes(5);
  });

  it('restores the retry budget after a successful latest-version check', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const updater = fixture(request);
    await updater.check(); await vi.advanceTimersByTimeAsync(7 * 60000);
    request.mockImplementationOnce(latest);
    await updater.check(); await updater.check();
    await vi.advanceTimersByTimeAsync(60000);
    expect(request).toHaveBeenCalledTimes(7);
  });

  it('does not report latest or blame the network for an invalid release signature', async () => {
    const updater = fixture(async () => Response.json({ current: null, release: { payload: 'e30=', signature: 'AA==' } }));
    await updater.check();
    expect(updater.state.phase).toBe('error');
    expect(updater.state.message).toContain('校验失败');
    expect(updater.state.message).not.toMatch(/网络|磁盘|已是最新版本/);
  });

  it('does not interpret an incomplete check response as latest', async () => {
    const updater = fixture(async () => Response.json({}));
    await updater.check();
    expect(updater.state.phase).toBe('error');
    expect(updater.state.checkedAt).toBeNull();
  });

  it.each(['0.4.15', '0.4.16'])('still rejects a signed replay of version %s', async version => {
    const updater = fixture(async () => Response.json({ current: release('0.4.16', 16), release: release(version, 17) }));
    await updater.check();
    expect(updater.state.phase).toBe('error');
    expect(updater.state.message).toContain('校验失败');
  });

  it('removes withdrawn candidate details when a later check returns no update', async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json({ current: release('0.4.16', 16), release: release('0.4.17', 17) })).mockImplementation(latest);
    const updater = fixture(request); updater.setting(false);
    await updater.check();
    expect(updater.state.version).toBe('0.4.17');
    await updater.check();
    expect(updater.state).toMatchObject({ phase: 'idle', message: '已是最新版本', version: undefined, notes: '', progress: 0 });
  });

  it('identifies a missing rollback package without blaming the disk or network', async () => {
    const updater = fixture(async () => Response.json({ current: null, release: release('0.4.17', 17) }));
    await updater.check();
    expect(updater.state.phase).toBe('error');
    expect(updater.state.message).toContain('恢复包');
    expect(updater.state.message).not.toMatch(/网络|磁盘/);
  });
  it('upgrades a withdrawn installed build using an approved older rollback', async () => {
    const rollback=release('0.4.15',15),candidate=release('0.4.17',17);
    const updater=fixture(async path=>path.startsWith('/api/updates/device/check') ? Response.json({current:null,rollback,release:candidate}) : Response.json({}));
    const dir=directories.at(-1)!;
    for(const envelope of [rollback,candidate]){const m=JSON.parse(Buffer.from(envelope.payload,'base64').toString());writeFileSync(join(dir,'updates',m.sha256+'.exe'),m.version);}
    await updater.check();expect(updater.state.phase).toBe('ready');
    vi.mocked(spawn).mockImplementation(()=>{const child=Object.assign(new EventEmitter(),{unref:vi.fn()});queueMicrotask(()=>child.emit('spawn'));return child as unknown as ChildProcess;});
    await updater.install();
    expect(JSON.parse(readFileSync(join(dir,'updates/runner/job.json'),'utf8')).previous).toEqual(rollback);
  });
  it.each(['forged','newer'])('rejects an unsafe %s rollback', async kind => {
    const rollback=kind==='newer'?release('0.4.17',17):{payload:'e30=',signature:'AA=='};
    const updater=fixture(async()=>Response.json({current:null,rollback,release:release('0.4.18',18)}));
    await updater.check();expect(updater.state.phase).toBe('error');expect(spawn).not.toHaveBeenCalled();
  });

  it('identifies a download failure after a successful version check', async () => {
    const updater = fixture(async path => {
      if (path.startsWith('/api/updates/device/check')) return Response.json({ current: release('0.4.16', 16), release: release('0.4.17', 17) });
      throw new TypeError('fetch failed');
    });
    await updater.check();
    expect(updater.state.phase).toBe('error');
    expect(updater.state.message).toContain('更新包下载失败');
  });

  it('does not let a paused download suppress subsequent update check failures', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/api/updates/device/check')) return Response.json({ current: release('0.4.16', 16), release: release('0.4.17', 17) });
      return new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }); });
    });
    const updater = fixture(request);
    const downloading = updater.check();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    updater.cancel(); await downloading;
    expect(updater.state.phase).toBe('available');
    request.mockRejectedValue(new TypeError('fetch failed'));
    await updater.check();
    expect(updater.state.phase).toBe('error');
    expect(updater.state.message).toContain('检查更新');
  });

  it('reports combined rollback and candidate progress while downloading', async () => {
    const dir = mkdtempSync(join(process.cwd(), '.runtime-updater-test-')); directories.push(dir);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const makeRelease = (version: string, sequence: number, bytes: Buffer) => {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const manifest = { version, sequence, platform: 'win32-x64' as const, size: bytes.length, sha256, path: '/api/updates/download/' + sha256, notes: version, issuedAt: Date.now() };
      const payload = Buffer.from(JSON.stringify(manifest));
      return { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') };
    };
    const previousBytes = Buffer.from('previous-release');
    const candidateBytes = Buffer.from('candidate-release');
    const previous = makeRelease('0.4.10', 10, previousBytes);
    const candidate = makeRelease('0.4.11', 11, candidateBytes);
    const paths = new Map([
      ['/api/updates/download/' + JSON.parse(Buffer.from(previous.payload, 'base64').toString()).sha256, previousBytes],
      ['/api/updates/download/' + JSON.parse(Buffer.from(candidate.payload, 'base64').toString()).sha256, candidateBytes]
    ]);
    const request = async (path: string, init?: RequestInit) => {
      if (path.startsWith('/api/updates/device/check')) return new Response(JSON.stringify({ current: previous, release: candidate }), { headers: { 'content-type': 'application/json' } });
      if (path.startsWith('/api/updates/device/result')) return new Response('{}', { status: 200 });
      const bytes = paths.get(path); if (!bytes) throw new Error('unexpected request ' + path);
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(bytes.subarray(0, 4)); await delay(30); controller.enqueue(bytes.subarray(4)); controller.close();
        }
      });
      const headers = init?.headers;
      const range = headers instanceof Headers ? headers.get('range') : headers && !Array.isArray(headers) ? (headers as Record<string, string>).Range ?? (headers as Record<string, string>).range : undefined;
      const offset = Number(range?.match(/\d+/)?.[0] ?? 0);
      return new Response(stream, { status: offset ? 206 : 200, headers: { 'content-length': String(bytes.length - offset), ...(offset ? { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}) } });
    };
    const updater = new HelperUpdater({
      dir, root: dir, version: '0.4.10', store: { get: (key: string) => key === 'update:auto' ? 'false' : null, set: () => {} } as any,
      request, blockers: async () => [], freeze: () => {}, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString()
    });
    await updater.check();
    expect(updater.state.phase).toBe('available');
    const downloading = updater.download();
    await delay(10);
    expect(updater.state.phase).toBe('downloading');
    expect(updater.state.progress).toBeGreaterThan(0);
    expect(updater.state.progress).toBeLessThan(100);
    await downloading;
    expect(updater.state).toMatchObject({ phase: 'ready', progress: 100 });
  });
});
