import { copyFile, cp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);
// Keep running Codex integrations outside the assistant's install directory so
// replacing/uninstalling the assistant never deletes or locks its executor.
export async function prepareDesktopBridge(root: string, helper: string, version: string) {
  if (process.platform !== 'win32' || !existsSync(join(root, 'CodexMobileBridge.exe'))) return false;
  const base = join(process.env.LOCALAPPDATA!, 'CodexMobile', 'bridge', 'runtime');
  const destination = join(base, version);
  if (!existsSync(join(destination, 'desktop-bridge.mjs'))) {
    await mkdir(base, { recursive: true }); const staging = join(base, version + '-' + randomUUID()); await mkdir(staging);
    try {
      for (const file of ['node.exe', 'RemoteCompanion.exe', 'CodexMobileBridge.exe']) await copyFile(join(root, file), join(staging, file));
      await copyFile(join(root, 'dist', 'desktop-bridge.mjs'), join(staging, 'desktop-bridge.mjs'));
      await cp(join(root, 'node_modules', 'ws'), join(staging, 'node_modules', 'ws'), { recursive: true });
      await rename(staging, destination);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  await run(helper, ['--bridge-configure', destination], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return true;
}
