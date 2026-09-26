import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
it.skipIf(process.platform !== 'win32')('assesses sleep, hibernation, battery and lid risks without changing system settings', () => {
  const root = resolve('.runtime'); mkdirSync(root, { recursive: true }); const dir = mkdtempSync(join(root, 'power-test-'));
  try {
    const executable = join(dir, 'PowerChecks.exe');
    execFileSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', ['/nologo', '/target:exe', '/platform:x64', '/utf8output', `/out:${executable}`, resolve('native/PowerSettings.cs'), resolve('tests/power-settings-checks.cs')], { windowsHide: true });
    expect(Number(execFileSync(executable, [], { encoding: 'utf8', windowsHide: true }))).toBe(15);
  } finally { if (dirname(dir) !== root) throw new Error('Unexpected test directory'); rmSync(dir, { recursive: true, force: true }); }
});
