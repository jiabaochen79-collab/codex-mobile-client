import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
mkdirSync('dist', { recursive: true });
for (const [name, entry] of [['agent', 'src/agent/main.ts']] as const) {
  // The bundled applications use a modern Node runtime; SQLite is a built-in module.
  await build({ entryPoints: [entry], bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', outfile: `dist/${name}.mjs` });
}
await build({ entryPoints: ['src/agent/update-runner.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: 'dist/updater.mjs' });

const webRoot = join('dist', 'web');
if (!statSync(webRoot, { throwIfNoEntry: false } )?.isDirectory()) throw new Error('Run the Vite web build before generating the client artifact manifest.');
function webFiles(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const name = prefix ? join(prefix, entry.name) : entry.name;
    return entry.isDirectory() ? webFiles(root, name) : [name];
  }).sort();
}
const files = webFiles(webRoot).map(file => {
  const bytes = readFileSync(join(webRoot, file));
  return { path: join('web', file).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
});
const treeSha256 = createHash('sha256').update(files.map(file => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join('')).digest('hex');
let sourceRevision = 'working-tree';
try { sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim() || sourceRevision; } catch { /* Source archives may not contain Git metadata. */ }
writeFileSync('dist/client-web-manifest.json', JSON.stringify({ schemaVersion: 1, packageVersion: JSON.parse(readFileSync('package.json', 'utf8')).version, sourceRevision, treeSha256, files }, null, 2) + '\n');
