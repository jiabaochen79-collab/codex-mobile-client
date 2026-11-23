import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

export async function buildDesktopBridge(outfile: string) {
  await build({ entryPoints: [fileURLToPath(new URL('../src/bridge/main.ts', import.meta.url))], bundle: true, external: ['ws'], platform: 'node', format: 'esm', target: 'node22', outfile });
}
