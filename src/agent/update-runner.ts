import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { verifyRelease, fileDigest } from '../shared/release-signature.js';
import { signedReleaseSchema } from '../shared/updates.js';

const jobSchema = z.object({ root: z.string(), dataDir: z.string(), next: signedReleaseSchema, previous: signedReleaseSchema, nonce: z.string().uuid(), version: z.string().regex(/^\d+\.\d+\.\d+$/).optional() }).strict();
const INSTALL_TIMEOUT_MS = 5 * 60000;
class InstallerStillRunning extends Error {}
export async function runUpdate(jobPath: string) {
  const job = jobSchema.parse(JSON.parse(readFileSync(jobPath, 'utf8')));
  if (process.platform !== 'win32' || !isAbsolute(job.root) || !isAbsolute(job.dataDir) || resolve(job.root) === resolve(job.dataDir)) throw new Error('Invalid installation paths');
  const cache = join(job.dataDir, 'updates');
  const version = job.version ?? JSON.parse(Buffer.from(job.next.payload, 'base64').toString()).version;
  let installerPid = 0;
  const result = (phase: string, installerRunning = false) => writeFileSync(join(cache, 'result.json'), JSON.stringify({ phase, version, at: Date.now(), installerRunning, runnerPid: process.pid, installerPid }), { mode: 0o600 });
  let next: ReturnType<typeof verifyRelease>['manifest'], previous: typeof next;
  try {
    next = verifyRelease(job.next).manifest; previous = verifyRelease(job.previous).manifest;
    for (const manifest of [next, previous]) { const path = join(cache, manifest.sha256 + '.exe'); if (statSync(path).size !== manifest.size || await fileDigest(path) !== manifest.sha256) throw new Error('Package verification failed'); }
  } catch (error) { result('failed'); throw error; }
  const execute = (file: string, args: string[], wait = true) => new Promise<number>((done, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore', cwd: job.root, detached: !wait });
    if (wait) child.once('spawn', () => { installerPid = child.pid ?? 0; result('installing', true); });
    let timer: NodeJS.Timeout | undefined, exited = false, terminating = false, terminationFinished = false;
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
  result('installing', true);
  try {
    try { if (await install(next.sha256) === 0) { const pid = await launch(next.version, job.nonce); if (await healthy(next.version, job.nonce, pid)) phase = 'installed'; } } catch (error) { if (error instanceof InstallerStillRunning) throw error; }
    if (phase !== 'installed') { try { if (await install(previous.sha256) === 0) { const nonce = job.nonce + '-rollback'; const pid = await launch(previous.version, nonce); phase = await healthy(previous.version, nonce, pid) ? 'rolled_back' : 'failed'; } } catch (error) { if (error instanceof InstallerStillRunning) throw error; } }
  } catch (error) { result('failed', true); throw error; }
  result(phase);
  // Installation failures can leave the helper stopped; launch the verified existing program.
  if (phase === 'failed' && existsSync(join(job.root, 'RemoteCompanion.exe'))) await execute(join(job.root, 'RemoteCompanion.exe'), [], false);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runUpdate(process.argv[2]).catch(() => { process.exitCode = 1; });
}
