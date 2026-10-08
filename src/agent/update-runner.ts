import { readFileSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { validateRelease, fileDigest } from '../shared/release-metadata.js';
import { releaseManifestSchema } from '../shared/updates.js';
import { updateProcesses, type UpdateProcess } from './update-process.js';
import { cleanupFailedProgram, createProgramBackup, pruneProgramBackups, restoreProgramBackup, validateUpdatePaths } from './update-backup.js';

const jobSchema = z.object({ root: z.string(), dataDir: z.string(), next: releaseManifestSchema, currentVersion: z.string().regex(/^\d+\.\d+\.\d+$/), nonce: z.string().uuid(), version: z.string().regex(/^\d+\.\d+\.\d+$/).optional() }).strict();
const INSTALL_TIMEOUT_MS = 5 * 60000;
class InstallerStillRunning extends Error {}
export async function runUpdate(jobPath: string) {
  const job = jobSchema.parse(JSON.parse(readFileSync(jobPath, 'utf8')));
  if (process.platform !== 'win32' || !isAbsolute(job.root) || !isAbsolute(job.dataDir) || resolve(job.root) === resolve(job.dataDir)) throw new Error('Invalid installation paths');
  validateUpdatePaths(job.root, job.dataDir);
  const cache = join(job.dataDir, 'updates');
  const nativeExe = join(cache, 'runner/RemoteCompanion.exe');
  const version = job.version ?? job.next.version;
  let installerPid = 0;
  let runnerIdentity: UpdateProcess | undefined, installerIdentity: UpdateProcess | undefined;
  try { runnerIdentity = (await updateProcesses([process.pid], nativeExe))[0]; } catch {}
  const result = (phase: string, installerRunning = false, message?: string) => writeFileSync(join(cache, 'result.json'), JSON.stringify({ phase, version, at: Date.now(), installerRunning, runnerPid: process.pid, installerPid, runnerIdentity, installerIdentity, message }), { mode: 0o600 });
  let next: ReturnType<typeof validateRelease>['manifest'];
  try {
    next = validateRelease(job.next).manifest;
    const path = join(cache, next.sha256 + '.exe'); if (statSync(path).size !== next.size || await fileDigest(path) !== next.sha256) throw new Error('Package verification failed');
    await createProgramBackup(job.root, job.dataDir, job.nonce, job.currentVersion);
  } catch (error) { result('failed', false, '安装包校验或本机程序备份未完成，未开始安装。请检查磁盘空间和文件权限后重试。'); throw error; }
  const execute = (file: string, args: string[], wait = true) => new Promise<number>((done, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore', cwd: job.root, detached: !wait });
    let timer: NodeJS.Timeout | undefined, exited = false, terminating = false, terminationFinished = false;
    if (wait) child.once('spawn', () => {
      installerPid = child.pid ?? 0; installerIdentity = undefined; result('installing', true);
      void updateProcesses([installerPid], nativeExe).then(rows => { if (!exited && !terminating) { installerIdentity = rows[0]; result('installing', true); } }).catch(() => {});
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    if (!wait) { child.once('spawn', () => { child.unref(); done(child.pid ?? 0); }); return; }
    child.once('exit', code => { exited = true; clearTimeout(timer); if (!terminating) done(code ?? 1); else if (terminationFinished) done(1); });
    timer = setTimeout(() => {
      terminating = true;
      // Inno Setup uses child processes; never start rollback alongside a live installer.
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }, error => {
        terminationFinished = true;
        if (exited) { done(1); return; }
        if (error) { reject(new InstallerStillRunning('Installer termination failed')); return; }
        timer = setTimeout(() => exited ? done(1) : reject(new InstallerStillRunning('Installer did not exit')), 5000);
      });
    }, INSTALL_TIMEOUT_MS);
  });
  const install = (sha: string) => execute(join(cache, sha + '.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/DIR=' + job.root]);
  const launch = (version: string, nonce: string) => execute(join(job.root, 'RemoteCompanion.exe'), ['--update-health', nonce, version], false);
  const healthy = async (version: string, nonce: string, helperPid: number) => {
    const deadline = Date.now() + 45000; let consecutive = 0, pid = 0, legacyPort: number | undefined;
    const probe = async (port: number, timeout = 1500) => {
      const remaining = deadline - Date.now(); if (remaining <= 0) return false;
      const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { signal: AbortSignal.timeout(Math.min(timeout, remaining)), redirect: 'error' });
      return response.ok && (await response.json()).mode === 'desktop';
    };
    while (Date.now() < deadline) {
      await delay(1000);
      try {
        const data = JSON.parse(readFileSync(join(cache, 'health-' + nonce + '.json'), 'utf8'));
        if (data.version !== version || data.nonce !== nonce || data.localReady !== true) throw new Error('Invalid local health marker');
        const legacy = data.pid === undefined && data.port === undefined;
        const processId = legacy ? helperPid : data.pid;
        if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error('Invalid local helper process');
        process.kill(processId, 0);
        // Previous installers do not report a port; use their existing bounded local-port range.
        if (legacy && legacyPort === undefined) {
          const basePort = Number(process.env.LOCAL_PORT ?? 8791);
          for (let offset = 0; offset < 20; offset++) {
            const port = basePort + offset; if (!Number.isInteger(port) || port < 1 || port > 65535) break;
            try { if (await probe(port, 250)) { legacyPort = port; break; } } catch {}
          }
        }
        const port = legacy ? legacyPort : data.port;
        if (!Number.isInteger(port) || port! < 1 || port! > 65535 || !await probe(port!)) throw new Error('Local helper is not healthy');
        if (pid !== processId) consecutive = 0; pid = processId;
        if (++consecutive >= 10) return true;
      } catch { consecutive = 0; pid = 0; legacyPort = undefined; }
    }
    return false;
  };
  let phase = 'failed';
  let helperIdentity: UpdateProcess | undefined;
  let helperPid = 0;
  result('installing', true);
  try {
    try { if (await install(next.sha256) === 0) { helperPid = await launch(next.version, job.nonce); helperIdentity = (await updateProcesses([helperPid], nativeExe))[0]; if (await healthy(next.version, job.nonce, helperPid)) phase = 'installed'; } } catch (error) { if (error instanceof InstallerStillRunning) throw error; }
    if (phase !== 'installed') {
      const rows = await updateProcesses([], nativeExe);
      const samePath = (a: string, b: string) => { try { a = realpathSync(a); b = realpathSync(b); } catch {} return a.replaceAll('\\', '/').toLowerCase() === b.replaceAll('\\', '/').toLowerCase(); };
      const helpers = rows.filter(row => samePath(row.path, join(job.root, 'RemoteCompanion.exe')) && !rows.some(parent => parent.pid === row.parentPid && samePath(parent.path, join(job.root, 'node.exe'))));
      if (helpers.length > 1) throw new Error('Multiple helper instances block program restoration');
      for (const active of helpers) {
        if (!active.startedAt || helperPid && (!helperIdentity || active.pid !== helperPid || active.startedAt !== helperIdentity.startedAt)) throw new Error('Cannot safely identify failed helper');
        await new Promise<void>((done, reject) => execFile(nativeExe, ['--update-stop', String(active.pid), active.startedAt, active.path], { windowsHide: true, timeout: 60000 }, error => error ? reject(error) : done()));
        if ((await updateProcesses([active.pid], nativeExe)).some(row => row.startedAt === active.startedAt)) throw new Error('Failed helper is still running');
      }
      const restored = await restoreProgramBackup(job.root, job.dataDir, job.nonce);
      await new Promise<void>((done, reject) => execFile(nativeExe, ['--update-registration', job.root, restored.version], { windowsHide: true, timeout: 10000 }, error => error ? reject(error) : done()));
      const nonce = job.nonce + '-rollback'; const pid = await launch(restored.version, nonce);
      phase = await healthy(restored.version, nonce, pid) ? 'rolled_back' : 'failed';
    }
  } catch (error) { result('failed', error instanceof InstallerStillRunning, '更新未完成，本机备份已保留。请确认安装器及助手状态后重试。'); throw error; }
  result(phase);
  if (phase !== 'failed') { try { if (phase === 'rolled_back') await cleanupFailedProgram(job.root, job.dataDir, job.nonce); await pruneProgramBackups(job.dataDir, job.nonce); } catch { /* Keep backups if cleanup cannot be verified. */ } }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runUpdate(process.argv[2]).catch(() => { process.exitCode = 1; });
}
