import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { updateProcesses } from '../src/agent/update-process.js';

describe.skipIf(process.platform !== 'win32')('isolated native update process operations', () => {
  let dir: string, exe: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'update-native-')); exe = join(dir, 'RemoteCompanion.exe');
    copyFileSync(process.execPath, join(dir, 'node.exe'));
    execFileSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', ['/nologo', '/target:exe', '/platform:x64', '/utf8output', '/main:UpdateFixture', `/out:${exe}`, ...['System.Windows.Forms', 'System.Drawing', 'System.Net.Http', 'System.Web.Extensions', 'System.Management', 'System.Security', 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/WPF/UIAutomationClient', 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/WPF/UIAutomationTypes', 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/WPF/WindowsBase'].map(name => `/reference:${name}.dll`), ...['tests/update-native-fixture.cs', 'native/RemoteCompanion.cs', 'native/PowerSettings.cs', 'native/DesktopToolsPipe.cs', 'native/DesktopRecovery.cs', 'native/DesktopQuestion.cs'].map(file => resolve(file))], { windowsHide: true, stdio: 'inherit' });
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  async function fixture() {
    const child = spawn(exe, ['--update-health', 'fixture', '0.0.0'], { windowsHide: true });
    const ids = await new Promise<{ pid: number; nodePid: number }>((done, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('Fixture startup timed out')), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', bytes => { output += bytes; if (output.includes('\n')) { clearTimeout(timer); done(JSON.parse(output)); } });
    });
    return { child, ...ids };
  }
  async function close(child: ChildProcess, nodePid: number) {
    if (child.exitCode === null) child.kill();
    try { process.kill(nodePid); } catch { /* Fixture node may already have exited. */ }
    await new Promise<void>(done => child.exitCode !== null ? done() : child.once('exit', () => done()));
    await expect.poll(async () => (await updateProcesses([nodePid], exe)).length).toBe(0);
  }
  it('enumerates exact fixture identity and stops only that helper and its connection child', async () => {
    const test = await fixture();
    try {
      const [identity] = await updateProcesses([test.pid], exe);
      expect(identity).toMatchObject({ pid: test.pid, path: exe, parentPid: process.pid }); expect(identity.startedAt).toBeTruthy();
      expect((await updateProcesses([test.nodePid], exe))[0]).toMatchObject({ parentPid: test.pid, path: join(dir, 'node.exe') });
      expect(execFileSync(exe, ['--update-stop', String(test.pid), identity.startedAt, identity.path], { encoding: 'utf8', windowsHide: true, timeout: 25000 })).toContain('"stopped":true');
      expect(await updateProcesses([test.pid, test.nodePid], exe)).toEqual([]);
    } finally { await close(test.child, test.nodePid); }
  }, 30000);
  it('refuses a wrong path and stale creation time without stopping the fixture', async () => {
    const test = await fixture();
    try {
      const [identity] = await updateProcesses([test.pid], exe);
      for (const [startedAt, path] of [[identity.startedAt, join(dir, 'wrong/RemoteCompanion.exe')], ['2000-01-01T00:00:00.0000000Z', exe]]) {
        expect(() => execFileSync(exe, ['--update-stop', String(test.pid), startedAt, path], { windowsHide: true, timeout: 10000, stdio: 'pipe' })).toThrow();
        expect(await updateProcesses([test.pid], exe)).toHaveLength(1);
      }
      execFileSync(exe, ['--update-stop', String(test.pid), identity.startedAt, exe], { windowsHide: true, timeout: 25000 });
    } finally { await close(test.child, test.nodePid); }
  }, 30000);
  it('enumerates the current Windows session while unrelated processes exit', async () => {
    const test = await fixture();
    const transient = Array.from({ length: 8 }, () => spawn(process.execPath, ['-e', 'setTimeout(()=>{},50)'], { windowsHide: true, stdio: 'ignore' }));
    try {
      const rows = await updateProcesses([], exe);
      expect(rows.find(row => row.pid === test.pid)).toMatchObject({ path: exe, parentPid: process.pid });
      expect(rows.find(row => row.pid === test.nodePid)).toMatchObject({ parentPid: test.pid, path: join(dir, 'node.exe') });
    } finally {
      await Promise.all(transient.map(child => new Promise<void>(done => child.exitCode !== null ? done() : child.once('exit', () => done()))));
      await close(test.child, test.nodePid);
    }
  }, 30000);
});
