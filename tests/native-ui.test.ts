import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import packageInfo from '../package.json' with { type: 'json' };

it.skipIf(process.platform !== 'win32')('renders native desktop layouts and verifies credential and authorization controls', () => {
  mkdirSync('.runtime', { recursive: true });
  const dir = mkdtempSync(resolve('.runtime/native-ui-'));
  try {
    cpSync('release/icons', join(dir, 'icons'), { recursive: true }); cpSync('release/companion.ico', join(dir, 'companion.ico'));
    const executable = join(dir, 'NativeUiChecks.exe');
    execFileSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', ['/nologo', '/target:exe', '/platform:x64', '/utf8output', `/out:${executable}`, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', resolve('tests/native-ui-checks.cs')], { windowsHide: true });
    const cases = JSON.parse(execFileSync(executable, [resolve('release/RemoteCompanion.exe'), resolve('test-results/native-desktop'), packageInfo.version], { encoding: 'utf8', windowsHide: true, timeout: 20000 }));
    expect(cases).toHaveLength(15); expect(cases.every((sample: any) => sample.verified)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 25000);
