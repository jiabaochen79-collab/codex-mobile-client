import { execFile } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { promisify } from 'node:util';

export type UpdateProcess = { pid: number; name: string; path: string; startedAt: string; parentPid?: number };
export async function updateProcesses(ids: number[] = [], nativeExe = process.env.NATIVE_EXE): Promise<UpdateProcess[]> {
  if (process.platform === 'win32') {
    if (nativeExe) {
      const { stdout } = await promisify(execFile)(nativeExe, ['--update-processes', ids.join(',')], { windowsHide: true, timeout: ids.length ? 10000 : 30000, maxBuffer: 1024 * 1024 });
      return JSON.parse(stdout);
    }
    const filter = ids.length ? ` -Filter '${ids.map(id => `ProcessId=${id}`).join(' OR ')}'` : '';
    const command = `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process${filter} | ForEach-Object { @{pid=[int]$_.ProcessId;name=[string]$_.Name;path=[string]$_.ExecutablePath;startedAt=$(if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')} else {''})} }) | ConvertTo-Json -Compress`;
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout.trim() || '[]'); return Array.isArray(result) ? result : [result];
  }
  return ids.flatMap(pid => {
    try { const path = readlinkSync(`/proc/${pid}/exe`), stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return [{ pid, name: basename(path), path, startedAt: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] }]; }
    catch (error: any) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return []; throw error; }
  });
}
