import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
it.skipIf(process.platform !== 'win32')('preserves native operation results, polling order and disabled-device status', () => {
  mkdirSync('.runtime', { recursive: true }); const dir = mkdtempSync(resolve('.runtime/native-actions-'));
  try {
    const exe = join(dir, 'NativeActions.exe');
    execFileSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', ['/nologo', '/target:exe', '/platform:x64', '/utf8output', '/main:AuditNative', `/out:${exe}`, ...['System.Windows.Forms', 'System.Drawing', 'System.Net.Http', 'System.Web.Extensions', 'System.Management', 'System.Security', 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/WPF/UIAutomationClient', 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/WPF/UIAutomationTypes', 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/WPF/WindowsBase'].map(name => `/reference:${name}.dll`), ...['tests/native-action-checks.cs', 'native/RemoteCompanion.cs', 'native/PowerSettings.cs', 'native/DesktopToolsPipe.cs', 'native/DesktopRecovery.cs', 'native/DesktopQuestion.cs'].map(file => resolve(file))], { windowsHide: true });
    expect(execFileSync(exe, [], { encoding: 'utf8', windowsHide: true, timeout: 15000 })).toContain('Delayed poll cannot overwrite a successful action');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
