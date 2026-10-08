import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, statfsSync, unlinkSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validateRelease, fileDigest } from '../shared/release-metadata.js';
import { compareVersions, releaseManifestSchema, type ReleaseManifest, type UpdateState } from '../shared/updates.js';
import { RemoteError } from '../shared/protocol.js';
import type { AgentStore } from './store.js';
import { updateProcesses, type UpdateProcess } from './update-process.js';

type Request = (path: string, init?: RequestInit) => Promise<Response>;
const checkResponseSchema = z.object({ release: releaseManifestSchema.nullable() });
export class HelperUpdater {
  readonly state: UpdateState = { phase: 'idle', progress: 0, autoDownload: true, message: '', notes: '', checkedAt: null };
  private candidate?: ReleaseManifest;
  private operation?: Promise<void>;
  private preparingInstall = false;
  private abort?: AbortController;
  private timer?: NodeJS.Timeout;
  private resultTimer?: NodeJS.Timeout;
  private reporting = false;
  private reportedResult?: string;
  private presentedResult?: string;
  private readyReportAt = 0;
  private readyReporting = false;
  private retry?: NodeJS.Timeout;
  private failures = 0;
  private closed = false;
  private dir: string;
  constructor(private options: { dir: string; root: string; version: string; store: AgentStore; request: Request; blockers: () => Promise<string[]>; freeze: (value: boolean) => void; processes?: typeof updateProcesses }) {
    this.dir = join(options.dir, 'updates'); mkdirSync(this.dir, { recursive: true });
    this.state.autoDownload = options.store.get('update:auto') !== 'false';
    try {
      const result = JSON.parse(readFileSync(join(this.dir, 'result.json'), 'utf8'));
      if (result.installerRunning === true && /^\d+\.\d+\.\d+$/.test(result.version)) { this.state.phase = 'installing'; this.state.version = result.version; options.freeze(true); }
    } catch { /* A first install has no prior update result. */ }
  }
  start() { const initial = setTimeout(() => { void this.check(); }, 15000); initial.unref(); this.timer = setInterval(() => { void this.check(); }, 6 * 3600000); this.timer.unref(); this.resultTimer = setInterval(() => { void this.reportPrevious(); }, 2000); this.resultTimer.unref(); }
  setting(enabled: boolean) { this.state.autoDownload = enabled; this.options.store.set('update:auto', String(enabled)); if (enabled && this.state.phase === 'available') void this.download(); return this.state; }
  cancel() { if (this.preparingInstall || this.state.phase === 'installing') return; this.abort?.abort(); clearTimeout(this.retry); this.state.phase = this.candidate ? 'available' : 'idle'; this.state.message = '下载已暂停'; }
  async connected() { this.readyReportAt = 0; await this.reportReady(); if (this.state.phase === 'error') await this.check(); }
  private async reportReady() {
    const version = this.options.store.get('update:ready-report');
    if (!version || this.closed || this.readyReporting || Date.now() - this.readyReportAt < 30000) return;
    this.readyReportAt = Date.now();
    this.readyReporting = true;
    try { if (await this.report('ready', version) && this.options.store.get('update:ready-report') === version) this.options.store.set('update:ready-report', ''); }
    finally { this.readyReporting = false; }
  }
  private succeeded() { clearTimeout(this.retry); this.retry = undefined; this.failures = 0; }
  private failed(error: unknown, downloading: boolean) {
    this.state.phase = 'error';
    this.state.message = error instanceof RemoteError && ['UPDATE_INVALID', 'UPDATE_DISK_SPACE', 'UPDATE_PACKAGE_INVALID'].includes(error.code)
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
      let next: ReturnType<typeof validateRelease> | undefined;
      try {
        const data = checkResponseSchema.parse(await response.json());
        if (controller.signal.aborted) return;
        next = data.release ? validateRelease(data.release) : undefined;
        if (next && compareVersions(next.manifest.version, this.options.version) <= 0) throw new Error('Release replay');
      } catch { throw new RemoteError('UPDATE_INVALID', '更新信息校验失败，已阻止更新。请通过“问题反馈”联系支持。'); }
      this.state.checkedAt = Date.now();
      if (!next) { this.candidate = undefined; this.pruneCache(); Object.assign(this.state, { phase: 'idle', version: undefined, progress: 0, notes: '', message: '已是最新版本' }); this.succeeded(); return; }
      const { manifest } = next;
      this.candidate = manifest;
      this.pruneCache();
      Object.assign(this.state, { phase: 'available', version: manifest.version, notes: manifest.notes });
      const cached = await this.cached(manifest);
      if (controller.signal.aborted) return;
      if (cached || this.state.autoDownload) { downloading = true; await this.fetchPackages(controller); }
      else { this.state.progress = 0; this.succeeded(); }
    })().catch(error => { if (!this.abort?.signal.aborted) this.failed(error, downloading); }).finally(() => { this.operation = undefined; });
    return this.operation;
  }
  download(): Promise<void> {
    if (this.closed || this.operation || this.preparingInstall || this.state.phase === 'installing' || !this.candidate) return this.operation ?? Promise.resolve();
    this.operation = this.fetchPackages().catch(error => { if (!this.abort?.signal.aborted) this.failed(error, true); }).finally(() => { this.operation = undefined; }); return this.operation;
  }
  private async fetchPackages(controller = new AbortController()) {
    if (!this.candidate || controller.signal.aborted || this.closed) return; this.abort = controller; this.state.phase = 'downloading'; this.state.message = '';
    const packages = [this.candidate];
    const total = packages.reduce((sum, envelope) => sum + validateRelease(envelope).manifest.size, 0);
    let completed = 0;
    const progress = (downloaded: number) => { this.state.progress = Math.min(99, Math.floor((completed + downloaded) * 100 / total)); };
    for (const envelope of packages) {
      const { manifest } = validateRelease(envelope);
      await this.fetchPackage(envelope, downloaded => progress(downloaded));
      completed += manifest.size; progress(0);
    }
    if (this.abort.signal.aborted) return;
    this.succeeded(); this.state.phase = 'ready'; this.state.progress = 100;
    this.options.store.set('update:ready-report', this.state.version!); this.readyReportAt = 0;
    void this.reportReady();
  }
  private async cached(envelope: ReleaseManifest) {
    const { manifest } = validateRelease(envelope); const file = join(this.dir, manifest.sha256 + '.exe');
    return existsSync(file) && statSync(file).size === manifest.size && await fileDigest(file) === manifest.sha256;
  }
  private pruneCache() {
    const keep = new Set<string>();
    try {
      if (this.candidate) keep.add(validateRelease(this.candidate).manifest.sha256);
      const jobPath = join(this.dir, 'runner/job.json');
      if (existsSync(jobPath)) {
        const job = JSON.parse(readFileSync(jobPath, 'utf8'));
        const resultPath = join(this.dir, 'result.json');
        const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : undefined;
        if (!result || result.version !== job.version || result.installerRunning === true || !['installed', 'failed', 'rolled_back'].includes(result.phase)) {
          for (const envelope of [job.previous, job.next]) if (envelope) keep.add(validateRelease(envelope).manifest.sha256);
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
  private async fetchPackage(envelope: ReleaseManifest, onProgress: (downloaded: number) => void) {
    const { manifest: m } = validateRelease(envelope); const file = join(this.dir, m.sha256 + '.exe');
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
    if (this.closed || this.operation || this.preparingInstall || this.state.phase !== 'ready' || !this.candidate) throw new RemoteError('UPDATE_NOT_READY', '更新尚未下载完成。');
    this.preparingInstall = true; this.options.freeze(true);
    try {
      const blockers = await this.options.blockers(); if (blockers.length) throw new RemoteError('UPDATE_BLOCKED', blockers.join('；'));
      const { manifest: m } = validateRelease(this.candidate); const file = join(this.dir, m.sha256 + '.exe'); if (statSync(file).size !== m.size || await fileDigest(file) !== m.sha256) throw new Error('Corrupt cached package'); await this.options.request('/api/updates/device/verify/' + m.sha256);
      const blocks = await this.options.blockers(); if (blocks.length) throw new RemoteError('UPDATE_BLOCKED', blocks.join('；'));
      const runner = join(this.dir, 'runner'); mkdirSync(runner, { recursive: true });
      copyFileSync(process.execPath, join(runner, 'node.exe')); copyFileSync(join(this.options.root, 'dist/updater.mjs'), join(runner, 'updater.mjs'));
      copyFileSync(join(this.options.root, 'RemoteCompanion.exe'), join(runner, 'RemoteCompanion.exe'));
      const job = { root: this.options.root, dataDir: this.options.dir, next: this.candidate, currentVersion: this.options.version, nonce: randomUUID(), version: this.state.version };
      const path = join(runner, 'job.json'); writeFileSync(path, JSON.stringify(job), { mode: 0o600 });
      const resultFile = join(this.dir, 'result.json'); if (existsSync(resultFile)) unlinkSync(resultFile);
      const child = spawn(join(runner, 'node.exe'), [join(runner, 'updater.mjs'), path], { detached: true, stdio: 'ignore', windowsHide: true, cwd: runner });
      child.once('exit', () => {
        if (this.closed || this.state.phase !== 'installing') return;
        try {
          const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : undefined;
          if (result?.installerRunning === true) { this.state.message = '更新程序已退出，但安装器是否结束尚未确认。请关闭安装器后重启助手。'; return; }
          if (['installed', 'failed', 'rolled_back'].includes(result?.phase)) { void this.reportPrevious(); return; }
        } catch {}
        this.options.freeze(false); this.state.phase = 'error'; this.state.message = '更新程序未能启动安装，请重新检查更新。不影响当前版本使用。';
      });
      await once(child, 'spawn'); child.unref(); this.state.phase = 'installing'; return { accepted: true };
    } catch (e) { this.options.freeze(false); if (e instanceof RemoteError) throw e; throw new RemoteError('UPDATE_FAILED', '安装准备失败，请重新检查更新。'); }
    finally { this.preparingInstall = false; }
  }
  async report(phase: 'ready' | 'installed' | 'failed' | 'rolled_back', version: string) { try { await this.options.request('/api/updates/device/result', { method: 'POST', body: JSON.stringify({ phase, version }), headers: { 'Content-Type': 'application/json' } }); return true; } catch { return false; } }
  private async installerActive(result: { runnerPid?: number; installerPid?: number; runnerIdentity?: UpdateProcess; installerIdentity?: UpdateProcess }) {
    const ids = [result.runnerPid, result.installerPid].filter((id): id is number => Number.isSafeInteger(id) && id! > 0);
    const names = readdirSync(this.dir).filter(name => /^[a-f0-9]{64}\.exe$/.test(name));
    try {
      const rows = await (this.options.processes ?? updateProcesses)(ids);
      const samePath = (a: string, b: string) => a.replaceAll('\\', '/').toLowerCase() === b.replaceAll('\\', '/').toLowerCase();
      return rows.some(row => {
        if (!ids.length) return names.includes(row.name) || /^is-.*\.tmp$/i.test(row.name);
        const expected = row.pid === result.runnerPid ? result.runnerIdentity : result.installerIdentity;
        if (!row.path || !row.startedAt) return true;
        if (expected?.path && expected.startedAt) return samePath(row.path, expected.path) && row.startedAt === expected.startedAt;
        if (row.pid === result.runnerPid) return samePath(row.path, join(this.dir, 'runner/node.exe'));
        return names.some(name => samePath(row.path, join(this.dir, name))) || /^is-.*\.tmp$/i.test(row.name);
      });
    } catch { return true; }
  }
  async reportPrevious() {
    if (this.closed || this.reporting) return;
    this.reporting = true;
    try {
      await this.reportReady();
      const file = join(this.dir, 'result.json'); if (!existsSync(file)) return;
      let contents = readFileSync(file, 'utf8'); if (contents === this.reportedResult) return;
      const result = JSON.parse(contents);
      if (result.installerRunning === true && /^\d+\.\d+\.\d+$/.test(result.version)) {
        if (await this.installerActive(result)) {
          if (this.state.phase !== 'installing') this.options.freeze(true);
          this.state.phase = 'installing'; this.state.version = result.version;
          if (result.phase !== 'installing') this.state.message = '安装器超时且尚未确认退出，请关闭安装器后重启助手。'; return;
        }
        result.installerRunning = false; if (result.phase === 'installing') result.phase = 'failed';
        contents = JSON.stringify(result); writeFileSync(file, contents, { mode: 0o600 });
      }
      if (['installed', 'failed', 'rolled_back'].includes(result.phase) && /^\d+\.\d+\.\d+$/.test(result.version)) {
        if (this.state.phase === 'installing' && result.version === this.state.version) { this.state.phase = this.candidate ? 'ready' : 'idle'; this.options.freeze(false); }
        if (contents !== this.presentedResult) {
          if (this.state.checkedAt === null || result.version === this.state.version) this.state.message = result.phase === 'rolled_back' ? '更新失败，已从本机备份恢复上一版本' : result.phase === 'failed' ? typeof result.message === 'string' ? result.message.slice(0, 1000) : '更新失败，请重新检查更新' : '';
          this.presentedResult = contents;
        }
        const reported = await this.report(result.phase, result.version);
        if (reported) this.reportedResult = contents;
      }
    } catch {} finally { this.reporting = false; }
  }
  close() { this.closed = true; clearInterval(this.timer); clearInterval(this.resultTimer); clearTimeout(this.retry); this.abort?.abort(); }
}
