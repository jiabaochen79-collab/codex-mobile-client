import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { NativeRecoveryBackend } from '../src/agent/desktop-recovery.js';
let dir: string, exe: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'recovery-native-')); exe = join(dir, 'RecoveryFixture.exe');
  execFileSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', ['/nologo', '/target:exe', '/platform:x64', '/utf8output', '/main:RecoveryFixture', `/out:${exe}`, ...['System.Windows.Forms', 'System.Drawing', 'System.Net.Http', 'System.Web.Extensions', 'System.Management', 'System.Security', 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/WPF/UIAutomationClient', 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/WPF/UIAutomationTypes', 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/WPF/WindowsBase'].map(name => `/reference:${name}.dll`), ...['tests/client-recovery-native.cs', 'native/RemoteCompanion.cs', 'native/PowerSettings.cs', 'native/DesktopToolsPipe.cs', 'native/DesktopRecovery.cs', 'native/DesktopQuestion.cs'].map(file => resolve(file))], { windowsHide: true, stdio: 'inherit' });
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
it.each([0, 7])('observes independent fixture exit code %s without touching Codex', async code => {
  const child = spawn(exe, [String(code)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', value => output += value);
  await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', value => value === 0 ? resolve() : reject(new Error(output))); });
  expect(JSON.parse(output)).toMatchObject({ cause: code ? 'crash' : 'normal', code: '0x' + code.toString(16).padStart(8, '0') });
});
it('stdin EOF cancels observation while the fixture exits normally by itself', async () => {
  const child = spawn(exe, ['0'], { windowsHide: true }); let output = ''; child.stdout.on('data', value => output += value); child.stdin.end();
  await new Promise<void>(resolve => child.once('close', () => resolve())); expect(output).toBe('cancelled');
});
it('decodes Windows event PIDs and refuses a non-Codex main process', () => {
  expect(execFileSync(exe, ['pid'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })).toContain('identity verified');
});
it('resolves the registered installed application without launching or stopping it', async () => {
  const value = await new Promise<string>((resolve, reject) => execFile(exe, ['resolve'], { windowsHide: true, timeout: 12000 }, (error, output) => error ? reject(error) : resolve(output)));
  expect(value).toMatch(/^OpenAI\.Codex_[a-zA-Z0-9]+![a-zA-Z0-9._-]+$/);
});
it('rechecks authorization at the actual native activation boundary', async () => {
  const backend = new NativeRecoveryBackend(exe); let calls = 0;
  await expect(backend.launch(() => { if (++calls === 2) throw new Error('Authorization revoked'); })).rejects.toThrow('Authorization revoked');
  expect(calls).toBe(2); await expect(backend.launch(() => {})).resolves.toEqual({ launched: true });
});
