import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, statfsSync, unlinkSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { verifyRelease, fileDigest } from '../shared/release-signature.js';
import { compareVersions, signedReleaseSchema, type SignedRelease, type UpdateState } from '../shared/updates.js';
import { RemoteError } from '../shared/protocol.js';
import type { AgentStore } from './store.js';

type Request = (path: string, init?: RequestInit) => Promise<Response>;
const checkResponseSchema = z.object({ release: signedReleaseSchema.nullable(), current: signedReleaseSchema.nullable(), rollback: signedReleaseSchema.nullable().optional() });
export class HelperUpdater {
  readonly state: UpdateState = { phase: 'idle', progress: 0, autoDownload: true, message: '', notes: '', checkedAt: null };
  private candidate?: SignedRelease;
  private previous?: SignedRelease;
  private operation?: Promise<void>;
  private preparingInstall = false;
  private abort?: AbortController;
  private timer?: NodeJS.Timeout;
  private resultTimer?: NodeJS.Timeout;
  private reporting = false;
  private reportedResult?: string;
  private retry?: NodeJS.Timeout;
  private failures = 0;
  private closed = false;
  private dir: string;
  constructor(private options: { dir: string; root: string; version: string; store: AgentStore; request: Request; blockers: () => Promise<string[]>; freeze: (value: boolean) => void; publicKey?: string }) {
    this.dir = join(options.dir, 'updates'); mkdirSync(this.dir, { recursive: true });
    this.state.autoDownload = options.store.get('update:auto') !== 'false';
  }
  start() { const initial = setTimeout(() => { void this.check(); }, 15000); initial.unref(); this.timer = setInterval(() => { void this.check(); }, 6 * 3600000); this.timer.unref(); this.resultTimer = setInterval(() => { void this.reportPrevious(); }, 2000); this.resultTimer.unref(); }
  setting(enabled: boolean) { this.state.autoDownload = enabled; this.options.store.set('update:auto', String(enabled)); if (enabled && this.state.phase === 'available') void this.download(); return this.state; }
  cancel() { if (this.preparingInstall || this.state.phase === 'installing') return; this.abort?.abort(); clearTimeout(this.retry); this.state.phase = this.candidate ? 'available' : 'idle'; this.state.message = '下载已暂停'; }
  connected() { return this.state.phase === 'error' ? this.check() : Promise.resolve(); }
  private succeeded() { clearTimeout(this.retry); this.retry = undefined; this.failures = 0; }
  private failed(error: unknown, downloading: boolean) {
    this.state.phase = 'error';
    this.state.message = error instanceof RemoteError && ['UPDATE_INVALID', 'UPDATE_DISK_SPACE', 'UPDATE_ROLLBACK_UNAVAILABLE', 'UPDATE_PACKAGE_INVALID'].includes(error.code)
      ? error.message : downloading ? '更新包下载失败，请稍后在“帮助”中重试。' : '暂时无法检查更新，请稍后在“帮助”中重试。不影响当前版本使用。';
    if (!this.closed && this.state.autoDownload && this.failures < 3) { this.retry = setTimeout(() => { void this.check(); }, 60000 * 2 ** this.failures++); this.retry.unref(); }
  }
  check(): Promise<void> {
    if (this.closed || this.operation || this.preparingInstall || this.state.phase === 'installing') return this.operation ?? Promise.resolve();
    clearTimeout(this.retry); this.retry = undefined; const controller = new AbortController(); this.abort = controller;
    this.state.phase = 'checking'; this.state.message = '';
    let downloading = false;
    this.operation = (async () => {
      const response = await this.options.request('/api/updates/device/check?version=' + this.options.version, { signal: controller.signal });
      if (controller.signal.aborted) { await response.body?.cancel(); return; }
      let next: ReturnType<typeof verifyRelease> | undefined;
      try {
        const data = checkResponseSchema.parse(await response.json());
        if (controller.signal.aborted) return;
        const current = data.current ? verifyRelease(data.current, this.options.publicKey) : undefined;
        if (current && current.manifest.version !== this.options.version) throw new Error('Incorrect rollback version');
        const rollback = data.rollback ? verifyRelease(data.rollback, this.options.publicKey) : current;
        if (rollback && compareVersions(rollback.manifest.version, this.options.version) > 0) throw new Error('Rollback is newer than the installed version');
        next = data.release ? verifyRelease(data.release, this.options.publicKey) : undefined;
        if (next && (compareVersions(next.manifest.version, this.options.version) <= 0 || next.manifest.sequence < Number(this.options.store.get('update:sequence') ?? 0))) throw new Error('Release replay');
        this.previous = rollback?.envelope;
      } catch { throw new RemoteError('UPDATE_INVALID', '更新信息校验失败，已阻止更新。请通过“问题反馈”联系支持。'); }
      this.state.checkedAt = Date.now();
      if (!next) { this.candidate = undefined; this.pruneCache(); Object.assign(this.state, { phase: 'idle', version: undefined, progress: 0, notes: '', message: '已是最新版本' }); this.succeeded(); return; }
      const { envelope, manifest } = next;
      this.options.store.set('update:sequence', String(manifest.sequence)); this.candidate = envelope;
      this.pruneCache();
      Object.assign(this.state, { phase: 'available', version: manifest.version, notes: manifest.notes });
      if (this.state.autoDownload) { downloading = true; await this.fetchPackages(controller); }
      else this.succeeded();
    })().catch(error => { if (!this.abort?.signal.aborted) this.failed(error, downloading); }).finally(() => { this.operation = undefined; });
    return this.operation;
  }
  download(): Promise<void> {
    if (this.closed || this.operation || this.preparingInstall || this.state.phase === 'installing' || !this.candidate) return this.operation ?? Promise.resolve();
    this.operation = this.fetchPackages().catch(error => { if (!this.abort?.signal.aborted) this.failed(error, true); }).finally(() => { this.operation = undefined; }); return this.operation;
  }
  private async fetchPackages(controller = new AbortController()) {
    if (!this.candidate || controller.signal.aborted || this.closed) return; this.abort = controller; this.state.phase = 'downloading'; this.state.message = '';
    if (!this.previous) throw new RemoteError('UPDATE_ROLLBACK_UNAVAILABLE', '暂不能自动更新：服务器尚未提供当前版本的恢复包。');
    const packages = [this.previous, this.candidate];
    const total = packages.reduce((sum, envelope) => sum + verifyRelease(envelope, this.options.publicKey).manifest.size, 0);
    let completed = 0;
    const progress = (downloaded: number) => { this.state.progress = Math.min(99, Math.floor((completed + downloaded) * 100 / total)); };
    for (const envelope of packages) {
      const { manifest } = verifyRelease(envelope, this.options.publicKey);
      await this.fetchPackage(envelope, downloaded => progress(downloaded));
      completed += manifest.size; progress(0);
    }
    if (this.abort.signal.aborted) return;
    this.succeeded(); this.state.phase = 'ready'; this.state.progress = 100;
    await this.report('ready', this.state.version!);
  }
  private pruneCache() {
    const keep = new Set<string>();
    try {
      for (const envelope of [this.previous, this.candidate]) if (envelope) keep.add(verifyRelease(envelope, this.options.publicKey).manifest.sha256);
      const jobPath = join(this.dir, 'runner/job.json');
      if (existsSync(jobPath)) {
        const job = JSON.parse(readFileSync(jobPath, 'utf8'));
        const resultPath = join(this.dir, 'result.json');
        const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : undefined;
        if (!result || result.version !== job.version || result.installerRunning === true || !['installed', 'failed', 'rolled_back'].includes(result.phase)) {
          for (const envelope of [job.previous, job.next]) keep.add(verifyRelease(envelope, this.options.publicKey).manifest.sha256);
        }
      }
      for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
        const match = /^([a-f0-9]{64})\.exe(?:\.part)?$/.exec(entry.name);
        if (entry.isFile() && match && !keep.has(match[1])) {
          try { unlinkSync(join(this.dir, entry.name)); } catch {}
        }
      }
    } catch { /* Preserve recovery files when their state cannot be verified. */ }
  }
  private async fetchPackage(envelope: SignedRelease, onProgress: (downloaded: number) => void) {
    const { manifest: m } = verifyRelease(envelope, this.options.publicKey); const file = join(this.dir, m.sha256 + '.exe');
    if (existsSync(file) && statSync(file).size === m.size && await fileDigest(file) === m.sha256) { onProgress(m.size); return; }
    if (existsSync(file)) unlinkSync(file);
    const part = file + '.part'; let offset = existsSync(part) ? statSync(part).size : 0;
    if (offset > m.size) { unlinkSync(part); offset = 0; }
    onProgress(offset);
    const space = statfsSync(this.dir); if (space.bavail * space.bsize < m.size - offset + 512 * 1024 * 1024) throw new RemoteError('UPDATE_DISK_SPACE', '更新包下载失败，磁盘可用空间不足。');
    if (offset < m.size) {
      const response = await this.options.request(m.path, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: this.abort!.signal });
      if (offset && response.status === 200) offset = 0;
      else if (offset && (response.status !== 206 || response.headers.get('content-range') !== `bytes ${offset}-${m.size - 1}/${m.size}`)) { await response.body?.cancel(); throw new Error('Invalid range response'); }
      if (!response.body || Number(response.headers.get('content-length')) !== m.size - offset) { await response.body?.cancel(); throw new Error('Invalid response size'); }
      const output = createWriteStream(part, { flags: offset ? 'a' : 'w', mode: 0o600 });
      const signal = this.abort!.signal;
      await pipeline(async function* () {
        for await (const chunk of response.body as any) {
          if (signal.aborted) throw new Error('Cancelled'); offset += chunk.length;
          if (offset > m.size) throw new Error('Response exceeds release size');
          yield chunk;
          onProgress(offset);
        }
      }, output, { signal });
    }
    if (offset !== m.size || await fileDigest(part) !== m.sha256) { if (existsSync(part)) unlinkSync(part); throw new RemoteError('UPDATE_PACKAGE_INVALID', '更新包校验失败，已阻止安装，请重试下载。'); }
    renameSync(part, file);
  }
  async install() {
    if (this.closed || this.operation || this.preparingInstall || this.state.phase !== 'ready' || !this.candidate || !this.previous) throw new RemoteError('UPDATE_NOT_READY', '更新尚未下载完成。');
    this.preparingInstall = true; this.options.freeze(true);
    try {
      const blockers = await this.options.blockers(); if (blockers.length) throw new RemoteError('UPDATE_BLOCKED', blockers.join('；'));
      for (const signed of [this.previous, this.candidate]) { const { manifest: m } = verifyRelease(signed, this.options.publicKey); const file = join(this.dir, m.sha256 + '.exe'); if (statSync(file).size !== m.size || await fileDigest(file) !== m.sha256) throw new Error('Corrupt cached package'); await this.options.request('/api/updates/device/verify/' + m.sha256); }
      const blocks = await this.options.blockers(); if (blocks.length) throw new RemoteError('UPDATE_BLOCKED', blocks.join('；'));
      const runner = join(this.dir, 'runner'); mkdirSync(runner, { recursive: true });
      copyFileSync(process.execPath, join(runner, 'node.exe')); copyFileSync(join(this.options.root, 'dist/updater.mjs'), join(runner, 'updater.mjs'));
      const job = { root: this.options.root, dataDir: this.options.dir, next: this.candidate, previous: this.previous, nonce: randomUUID(), version: this.state.version };
      const path = join(runner, 'job.json'); writeFileSync(path, JSON.stringify(job), { mode: 0o600 });
      const resultFile = join(this.dir, 'result.json'); if (existsSync(resultFile)) unlinkSync(resultFile);
      const child = spawn(join(runner, 'node.exe'), [join(runner, 'updater.mjs'), path], { detached: true, stdio: 'ignore', windowsHide: true, cwd: runner });
      await once(child, 'spawn'); child.unref(); this.state.phase = 'installing'; return { accepted: true };
    } catch (e) { this.options.freeze(false); if (e instanceof RemoteError) throw e; throw new RemoteError('UPDATE_FAILED', '安装准备失败，请重新检查更新。'); }
    finally { this.preparingInstall = false; }
  }
  async report(phase: 'ready' | 'installed' | 'failed' | 'rolled_back', version: string) { try { await this.options.request('/api/updates/device/result', { method: 'POST', body: JSON.stringify({ phase, version }), headers: { 'Content-Type': 'application/json' } }); return true; } catch { return false; } }
  async reportPrevious() {
    if (this.closed || this.reporting) return;
    this.reporting = true;
    try {
      const file = join(this.dir, 'result.json'); if (!existsSync(file)) return;
      const contents = readFileSync(file, 'utf8'); if (contents === this.reportedResult) return;
      const result = JSON.parse(contents);
      if (['installed', 'failed', 'rolled_back'].includes(result.phase) && /^\d+\.\d+\.\d+$/.test(result.version)) {
        if (result.installerRunning === true) { this.state.message = '安装器超时且尚未确认退出，请关闭安装器后重启助手。'; return; }
        if (this.state.phase === 'installing' && result.version === this.state.version) { this.state.phase = 'ready'; this.options.freeze(false); }
        this.state.message = result.phase === 'rolled_back' ? '更新失败，已恢复上一版本' : result.phase === 'failed' ? '更新失败，请重新检查更新' : '';
        const reported = await this.report(result.phase, result.version);
        if (reported) this.reportedResult = contents;
      }
    } catch {} finally { this.reporting = false; }
  }
  close() { this.closed = true; clearInterval(this.timer); clearInterval(this.resultTimer); clearTimeout(this.retry); this.abort?.abort(); }
}
