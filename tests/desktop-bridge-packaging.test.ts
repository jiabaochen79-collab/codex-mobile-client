import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { buildDesktopBridge } from '../scripts/build-desktop-bridge.js';

it('loads the actual bridge bundle outside the repository with only its declared external dependency', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-mobile-bridge-package-'));
  try {
    const bundle = join(directory, 'desktop-bridge.mjs');
    await buildDesktopBridge(bundle);
    const require = createRequire(import.meta.url);
    cpSync(dirname(require.resolve('ws/package.json')), join(directory, 'node_modules/ws'), { recursive: true });
    expect(execFileSync(process.execPath, [bundle, '--codex-mobile-runtime-check'], { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim()).toBe('codex-mobile-bridge-v1');
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('codex-mobile-bridge-package-')) throw new Error('Unexpected standalone check directory');
    rmSync(directory, { recursive: true, force: true });
  }
});
