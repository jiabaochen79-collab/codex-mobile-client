import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'win32')('ignores a Codex process that exits during owner lookup', async () => {
  const dir = mkdtempSync(join(process.cwd(), '.runtime/recovery-race-'));
  const fixture = join(dir, 'OpenAI.Codex_Audit'); mkdirSync(fixture);
  const exe = join(fixture, 'Codex.exe'), probe = join(dir, 'Probe.exe');
  const source = readFileSync('native/DesktopRecovery.cs', 'utf8').replace('foreach (ManagementObject record in query.Get()) {', 'foreach (ManagementObject record in query.Get()) { if(Convert.ToInt32(record["ProcessId"]) != Int32.Parse(Environment.GetEnvironmentVariable("AUDIT_PID"))) continue;');
  const marker = 'var owner = record.InvokeMethod("GetOwnerSid", null, null);', index = source.lastIndexOf(marker);
  writeFileSync(join(dir, 'DesktopRecovery.cs'), source.slice(0, index) + 'Console.WriteLine("AUDIT_BARRIER"); Console.Out.Flush(); Console.ReadLine(); ' + source.slice(index));
  writeFileSync(join(dir, 'Fixture.cs'), 'using System; using System.Threading; class Fixture { static void Main(){ Console.WriteLine("ready"); Console.Out.Flush(); Thread.Sleep(30000); } }');
  writeFileSync(join(dir, 'Probe.cs'), 'using System; using System.Reflection; using System.Web.Script.Serialization; class Program { internal static JavaScriptSerializer Json=new JavaScriptSerializer(); static void Main(){try {Console.WriteLine("RESULT="+typeof(DesktopRecovery).GetMethod("AlreadyRunning",BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,null));}catch(Exception e){Console.WriteLine("ERROR="+e.GetBaseException().GetType().Name);}} }');
  let child: ChildProcess | undefined, checker: ChildProcess | undefined;
  try {
    const csc = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';
    execFileSync(csc, ['/nologo', '/target:exe', '/out:' + exe, join(dir, 'Fixture.cs')], { windowsHide: true });
    execFileSync(csc, ['/nologo', '/target:exe', '/out:' + probe, '/reference:System.Management.dll', '/reference:System.Web.Extensions.dll', join(dir, 'Probe.cs'), join(dir, 'DesktopRecovery.cs')], { windowsHide: true });
    child = spawn(exe, [], { windowsHide: true });
    await new Promise<void>((done, reject) => { child!.stdout!.once('data', () => done()); child!.once('error', reject); });
    checker = spawn(probe, [], { windowsHide: true, env: { ...process.env, AUDIT_PID: String(child.pid) } });
    let output = '';
    checker.stdout!.on('data', async bytes => {
      output += bytes;
      if (bytes.toString().includes('AUDIT_BARRIER')) {
        child!.kill(); await new Promise<void>(done => child!.exitCode !== null ? done() : child!.once('exit', () => done())); checker!.stdin!.end('\n');
      }
    });
    await new Promise<void>((done, reject) => { checker!.once('exit', () => done()); checker!.once('error', reject); });
    expect(output).toContain('RESULT=False'); expect(output).not.toContain('ERROR=');
  } finally {
    for (const process of [child, checker]) if (process && process.exitCode === null && process.signalCode === null) { process.kill(); await new Promise<void>(done => process.once('exit', () => done())); }
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
