import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync, realpathSync, statfsSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { fileDigest } from '../shared/release-metadata.js';

const manifestSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), files: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1) }).strict();
const requiredFiles = ['RemoteCompanion.exe', 'node.exe', 'dist/agent.mjs', 'relay.json', 'package.json'];
const inside = (parent: string, child: string) => { const path = relative(parent, child); return !path || !path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path); };
function filePath(root: string, path: string) {
  if (!path || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part))) throw new Error('Invalid backup path');
  const target = resolve(root, path); if (!inside(resolve(root), target)) throw new Error('Invalid backup path'); return target;
}
async function files(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Program links cannot be backed up or restored');
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) result.push(...await files(root, path));
    else if (entry.isFile()) { filePath(root, path); result.push(path); }
    else throw new Error('Unsupported program entry');
  }
  return result.sort();
}
export function validateUpdatePaths(root: string, dataDir: string, allowMissingProgram = false) {
  if (!isAbsolute(root) || !isAbsolute(dataDir)) throw new Error('Invalid installation paths');
  const missing = allowMissingProgram && !existsSync(root);
  if ((!missing && lstatSync(root).isSymbolicLink()) || lstatSync(dataDir).isSymbolicLink()) throw new Error('Installation paths must not be links');
  const program = missing ? join(realpathSync(dirname(root)), basename(root)) : realpathSync(root), data = realpathSync(dataDir);
  if (inside(program, data) || inside(data, program) || resolve(program) === resolve(program, '..')) throw new Error('Program and user data paths must be separate');
}
export async function verifyProgramBackup(backup: string) {
  if (lstatSync(backup).isSymbolicLink() || lstatSync(join(backup, 'program')).isSymbolicLink()) throw new Error('Backup paths must not be links');
  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8')));
  const root = join(backup, 'program');
  const expected = manifest.files.map(file => file.path).sort();
  if (new Set(expected).size !== expected.length || JSON.stringify(await files(root)) !== JSON.stringify(expected)) throw new Error('Backup file set changed');
  for (const required of requiredFiles) if (!expected.includes(required)) throw new Error('Backup is incomplete');
  for (const file of manifest.files) { const path = filePath(root, file.path); if ((await stat(path)).size !== file.size || await fileDigest(path) !== file.sha256) throw new Error('Backup verification failed'); }
  const installed = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (installed.name !== 'codex-mobile' || installed.version !== manifest.version) throw new Error('Backup version does not match its program');
  return manifest;
}
export async function createProgramBackup(root: string, dataDir: string, nonce: string, version: string) {
  validateUpdatePaths(root, dataDir);
  if (!z.string().uuid().safeParse(nonce).success) throw new Error('Invalid backup identifier');
  const installed = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (installed.name !== 'codex-mobile' || installed.version !== version) throw new Error('Installed program does not match the update job');
  const names = await files(root);
  for (const required of requiredFiles) if (!names.includes(required)) throw new Error('Installed program is incomplete');
  const inventory = [];
  for (const path of names) inventory.push({ path, size: (await stat(filePath(root, path))).size, sha256: await fileDigest(filePath(root, path)) });
  const bytes = inventory.reduce((sum, file) => sum + file.size, 0);
  const sameVolume = statSync(dataDir).dev === statSync(dirname(root)).dev;
  const space = statfsSync(dataDir); if (space.bavail * space.bsize < bytes * (sameVolume ? 2 : 1) + 512 * 1024 * 1024) throw new Error('Insufficient space for local program backup');
  const programSpace = statfsSync(dirname(root)); if (programSpace.bavail * programSpace.bsize < bytes * (sameVolume ? 2 : 1) + 512 * 1024 * 1024) throw new Error('Insufficient space for program installation and restoration');
  const parent = join(dataDir, 'updates/program-backups'), target = join(parent, nonce), partial = target + '.partial';
  await mkdir(parent, { recursive: true }); if (!inside(realpathSync(dataDir), realpathSync(parent))) throw new Error('Backup directory escapes user data'); await mkdir(partial);
  try {
    await cp(root, join(partial, 'program'), { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    await writeFile(join(partial, 'manifest.json'), JSON.stringify({ version, files: inventory }), { mode: 0o600 });
    await verifyProgramBackup(partial); await rename(partial, target); return target;
  } catch (error) { await rm(partial, { recursive: true, force: true }); throw error; }
}
export async function restoreProgramBackup(root: string, dataDir: string, nonce: string) {
  validateUpdatePaths(root, dataDir, true);
  if (!z.string().uuid().safeParse(nonce).success) throw new Error('Invalid backup identifier');
  const backup = join(dataDir, 'updates/program-backups', nonce), manifest = await verifyProgramBackup(backup);
  if (!inside(realpathSync(dataDir), realpathSync(backup))) throw new Error('Backup directory escapes user data');
  // Verify a staged copy before moving any remaining installation out of the way.
  const displaced = root + '.failed-update-' + nonce, staged = root + '.restore-' + nonce;
  const space = statfsSync(dirname(root)); if (space.bavail * space.bsize < manifest.files.reduce((sum, file) => sum + file.size, 0) + 512 * 1024 * 1024) throw new Error('Insufficient space for program restoration');
  await mkdir(staged);
  try {
    await cp(join(backup, 'program'), staged, { recursive: true, preserveTimestamps: true, force: true });
    for (const file of manifest.files) if (await fileDigest(filePath(staged, file.path)) !== file.sha256) throw new Error('Restored program verification failed');
  } catch (error) { await rm(staged, { recursive: true, force: true }); throw error; }
  if (existsSync(root)) { await files(root); await rename(root, displaced); }
  await rename(staged, root);
  return { version: manifest.version, displaced };
}
export async function cleanupFailedProgram(root: string, dataDir: string, nonce: string) {
  validateUpdatePaths(root, dataDir);
  if (!z.string().uuid().safeParse(nonce).success) throw new Error('Invalid backup identifier');
  const manifest = await verifyProgramBackup(join(dataDir, 'updates/program-backups', nonce));
  for (const file of manifest.files) if (await fileDigest(filePath(root, file.path)) !== file.sha256) throw new Error('Restored program verification failed');
  const displaced = root + '.failed-update-' + nonce;
  if (!existsSync(displaced)) return;
  if (lstatSync(displaced).isSymbolicLink()) throw new Error('Failed program path must not be a link');
  await files(displaced); await rm(displaced, { recursive: true });
}
export async function pruneProgramBackups(dataDir: string, keep: string) {
  const parent = join(dataDir, 'updates/program-backups');
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !z.string().uuid().safeParse(entry.name).success || entry.name === keep) continue;
    const path = join(parent, entry.name); await verifyProgramBackup(path); await rm(path, { recursive: true });
  }
}
