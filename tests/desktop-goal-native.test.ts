import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'win32')('matches only the current goal and refuses unrelated or disabled native controls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'goal-native-')), exe = join(dir, 'GoalFixture.exe');
  try {
    execFileSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', ['/nologo', '/target:exe', '/platform:x64', '/utf8output', '/main:GoalFixture', `/out:${exe}`, ...['System.Windows.Forms', 'System.Drawing', 'System.Net.Http', 'System.Web.Extensions', 'System.Management', 'System.Security', 'System.Xaml', 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/WPF/PresentationFramework', 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/WPF/PresentationCore', 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/WPF/UIAutomationClient', 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/WPF/UIAutomationTypes', 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/WPF/WindowsBase'].map(name => `/reference:${name}.dll`), ...['tests/fixtures/native-goal.cs', 'native/RemoteCompanion.cs', 'native/PowerSettings.cs', 'native/DesktopToolsPipe.cs', 'native/DesktopRecovery.cs', 'native/DesktopQuestion.cs', 'native/DesktopGoal.cs'].map(file => resolve(file))], { windowsHide: true, stdio: 'inherit' });
    expect(execFileSync(exe, [], { encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'inherit'] }).trim()).toBe('goal-controls-ok');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20000);
