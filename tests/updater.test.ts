import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HelperUpdater } from '../src/agent/updater.js';

describe('helper updater', () => {
  const directories: string[] = [];
  const updaters: HelperUpdater[] = [];
  const keys = generateKeyPairSync('ed25519');
  const release = (version: string, sequence: number, bytes = Buffer.from(version)) => {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const payload = Buffer.from(JSON.stringify({ version, sequence, platform: 'win32-x64', size: bytes.length, sha256, path: '/api/updates/download/' + sha256, notes: version, issuedAt: Date.now() }));
    return { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') };
  };
  const fixture = (request: (path: string, init?: RequestInit) => Promise<Response>) => {
    const dir = mkdtempSync(join(process.cwd(), '.runtime-updater-test-')); directories.push(dir);
    const updater = new HelperUpdater({ dir, root: dir, version: '0.4.16', store: { get: () => null, set: () => {} } as any, request, blockers: async () => [], freeze: () => {}, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
    updaters.push(updater); return updater;
  };
  const latest = () => Response.json({ current: null, release: null });
  afterEach(() => { for (const updater of updaters.splice(0)) updater.close(); vi.useRealTimers(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

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
