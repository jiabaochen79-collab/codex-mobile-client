import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { buildDesktopBridge } from '../scripts/build-desktop-bridge.js';

it.skipIf(process.platform !== 'win32')('never lets an independent CLI inherit or overwrite desktop bridge ownership', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-mobile-bridge-owner-'));
  try {
    const base = join(directory, 'CodexMobile', 'bridge'), cli = join(base, 'cli', 'fixture', 'codex.exe');
    mkdirSync(dirname(cli), { recursive: true });
    execFileSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', ['/nologo', '/out:' + cli, resolve('tests/desktop-bridge-owner-fixture.cs')], { windowsHide: true });
    writeFileSync(join(base, 'cli-source.json'), JSON.stringify({ executable: cli }));
    const descriptor = join(base, 'session-29344.dpapi'); writeFileSync(descriptor, 'existing-desktop-descriptor');
    for (const file of ['RemoteCompanion.exe', 'CodexMobileBridge.exe']) copyFileSync(join('release', file), join(directory, file));
    copyFileSync(process.execPath, join(directory, 'node.exe'));
    const require = createRequire(import.meta.url);
    cpSync(dirname(require.resolve('ws/package.json')), join(directory, 'node_modules/ws'), { recursive: true });
    await buildDesktopBridge(join(directory, 'desktop-bridge.mjs'));
    const output = execFileSync(join(directory, 'CodexMobileBridge.exe'), ['app-server'], {
      input: 'probe\n', encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: { ...process.env, LOCALAPPDATA: directory, CODEX_MOBILE_DESKTOP_PID: '29344', CODEX_MOBILE_DESKTOP_EXE: '' },
    });
    expect(output.trim()).toBe('isolated-cli');
    expect(readFileSync(descriptor, 'utf8')).toBe('existing-desktop-descriptor');
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('codex-mobile-bridge-owner-')) throw new Error('Unexpected ownership test directory');
    rmSync(directory, { recursive: true, force: true });
  }
});
