import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { it, expect } from 'vitest';
it('a rejected password change preserves the dialog and allows retry with the same draft', () => {
  const dir = mkdtempSync(resolve('.runtime/native-'));
  try {
    const exe = join(dir, 'PasswordAudit.exe');
    execFileSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', ['/nologo', '/target:exe', '/platform:x64', '/utf8output', '/main:PasswordAudit', `/out:${exe}`, ...['System.Windows.Forms', 'System.Drawing', 'System.Net.Http', 'System.Web.Extensions', 'System.Management', 'System.Security'].map(name => `/reference:${name}.dll`), ...['tests/fixtures/native-password.cs', 'native/RemoteCompanion.cs', 'native/PowerSettings.cs', 'native/DesktopToolsPipe.cs'].map(file => resolve(file))], { windowsHide: true });
    let output: string;
    try { output = execFileSync(exe, [], { encoding: 'utf8', windowsHide: true, timeout: 10000 }); }
    catch (error: any) { throw new Error(String(error.stdout) + String(error.stderr) + error.message); }
    expect(output).toContain('preserves entered draft');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
