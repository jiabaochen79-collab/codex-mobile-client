import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
for (const [name, entry] of [['agent', 'src/agent/main.ts']] as const) {
  // The bundled applications use a modern Node runtime; SQLite is a built-in module.
  await build({ entryPoints: [entry], bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', outfile: `dist/${name}.mjs` });
}
await build({ entryPoints: ['src/agent/update-runner.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: 'dist/updater.mjs' });
