import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'win32')('discovers only a validated Codex-owned app-tool pipe through bounded read-only probes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-tools-pipe-'));
  try {
    const executable = join(dir, 'DiscoveryChecks.exe');
    execFileSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', ['/nologo', '/target:exe', '/platform:x64', '/utf8output', `/out:${executable}`, '/reference:System.Web.Extensions.dll', resolve('native/DesktopToolsPipe.cs'), resolve('tests/desktop-tools-pipe-checks.cs')], { windowsHide: true });
    expect(execFileSync(executable, [], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim()).toBe('App-tool discovery checks passed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
