import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'win32')('records native fatal and normal exits without logging exception contents, and survives logging failures', () => {
  const runtime = resolve('.runtime'); mkdirSync(runtime, { recursive: true });
  const dir = mkdtempSync(join(runtime, 'helper-diagnostics-'));
  try {
    // Redirect only the diagnostic destination; never write into the installed helper's data.
    const source = readFileSync('native/RemoteCompanion.cs', 'utf8').replaceAll('Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)', 'Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data-" + Environment.GetEnvironmentVariable("HELPER_DIAGNOSTIC_CASE"))');
    const companion = join(dir, 'RemoteCompanion.cs'); writeFileSync(companion, source);
    const exe = join(dir, 'HelperDiagnosticsFixture.exe');
    const libraries = ['System.Windows.Forms', 'System.Drawing', 'System.Net.Http', 'System.Web.Extensions', 'System.Management', 'System.Security', 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/WPF/UIAutomationClient', 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/WPF/UIAutomationTypes', 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/WPF/WindowsBase'];
    execFileSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', ['/nologo', '/target:exe', '/platform:x64', '/utf8output', '/main:HelperDiagnosticsFixture', '/out:' + exe, ...libraries.map(name => '/reference:' + name + '.dll'), companion, ...['tests/fixtures/native-helper-diagnostics.cs', 'native/PowerSettings.cs', 'native/DesktopToolsPipe.cs', 'native/DesktopRecovery.cs', 'native/DesktopQuestion.cs', 'native/DesktopGoal.cs', 'native/DesktopBridgeSetup.cs'].map(file => resolve(file))], { windowsHide: true });
    for (const mode of ['normal', 'fatal', 'blocked']) {
      const result = spawnSync(exe, [mode], { env: { ...process.env, HELPER_DIAGNOSTIC_CASE: mode }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
      expect(result.error, mode).toBeUndefined(); expect(result.status, mode).not.toBeNull();
      if (mode === 'blocked') { expect(result.status).toBe(0); continue; }
      const text = readFileSync(join(dir, 'data-' + mode, 'CodexMobile/logs/helper-lifecycle.jsonl'), 'utf8').replace(/^\uFEFF/, '');
      const events = text.trim().split(/\r?\n/).map(line => JSON.parse(line));
      expect(text).not.toMatch(/fixture-private-value|private\.invalid|password=|fixture-value/);
      const failure = events.find(event => event.kind === (mode === 'fatal' ? 'helper.unhandled' : 'helper.failed'));
      expect(failure).toMatchObject({ exceptionType: 'System.InvalidOperationException', hresult: '0x80131509' });
      expect(failure.stack).toContain('HelperDiagnosticsFixture.Fail');
      if (mode === 'normal') { expect(result.status).toBe(0); expect(events.at(-1)).toMatchObject({ kind: 'helper.exited', exitCode: 0 }); }
      else expect(result.status).not.toBe(0);
    }
  } finally {
    if (!resolve(dir).startsWith(runtime + sep)) throw new Error('Unexpected diagnostic fixture directory');
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
