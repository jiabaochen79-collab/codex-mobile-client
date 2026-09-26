import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { verifyRelease, fileDigest } from '../shared/release-signature.js';
import { signedReleaseSchema } from '../shared/updates.js';

const jobSchema = z.object({ root: z.string(), dataDir: z.string(), next: signedReleaseSchema, previous: signedReleaseSchema, nonce: z.string().uuid() }).strict();
async function run() {
  const job = jobSchema.parse(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  if (process.platform !== 'win32' || !isAbsolute(job.root) || !isAbsolute(job.dataDir) || resolve(job.root) === resolve(job.dataDir)) throw new Error('Invalid installation paths');
  const next = verifyRelease(job.next).manifest, previous = verifyRelease(job.previous).manifest;
  const cache = join(job.dataDir, 'updates');
  const execute = (file: string, args: string[], wait = true) => new Promise<number>((done, reject) => { const child = spawn(file, args, { windowsHide: true, stdio: 'ignore', cwd: job.root, detached: !wait }); child.once('error', reject); if (wait) child.once('exit', code => done(code ?? 1)); else child.once('spawn', () => { child.unref(); done(0); }); });
  for (const manifest of [next, previous]) { const path = join(cache, manifest.sha256 + '.exe'); if (statSync(path).size !== manifest.size || await fileDigest(path) !== manifest.sha256) throw new Error('Package verification failed'); }
  const install = (sha: string) => execute(join(cache, sha + '.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/DIR=' + job.root]);
  const launch = (version: string, nonce: string) => execute(join(job.root, 'RemoteCompanion.exe'), ['--update-health', nonce, version], false);
  const healthy = async (version: string, nonce: string) => {
    for (let i = 0; i < 45; i++) { await delay(1000); try { const data = JSON.parse(readFileSync(join(cache, 'health-' + nonce + '.json'), 'utf8')); if (data.version === version && data.nonce === nonce && data.localReady === true) return true; } catch {} } return false;
  };
  let phase = 'failed';
  try { if (await install(next.sha256) === 0) { await launch(next.version, job.nonce); if (await healthy(next.version, job.nonce)) phase = 'installed'; } } catch {}
  if (phase !== 'installed') { try { if (await install(previous.sha256) === 0) { const nonce = job.nonce + '-rollback'; await launch(previous.version, nonce); phase = await healthy(previous.version, nonce) ? 'rolled_back' : 'failed'; } } catch {} }
  writeFileSync(join(cache, 'result.json'), JSON.stringify({ phase, version: next.version, at: Date.now() }), { mode: 0o600 });
  // Installation failures can leave the helper stopped; launch the verified existing program.
  if (phase === 'failed' && existsSync(join(job.root, 'RemoteCompanion.exe'))) await execute(join(job.root, 'RemoteCompanion.exe'), [], false);
}
void run().catch(() => { process.exitCode = 1; });
