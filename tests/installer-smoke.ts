import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'win32') throw new Error('Windows is required.');
const setup = resolve(process.argv[2] ?? 'release/ChatGPT-Remote-Assistant-Setup-0.3.0.exe');
const registry = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{B98F4E8B-9CF9-4C68-9718-376041F08A25}_is1';
const registered = () => { try { execFileSync('reg.exe', ['query', registry], { stdio: 'ignore', windowsHide: true }); return true; } catch { return false; } };
if (registered()) throw new Error('An installation already exists. Use a clean Windows user for this smoke test.');
const root = resolve('.runtime'); const target = join(root, `installer-smoke-${randomUUID()}`); mkdirSync(target, { recursive: true });
const app = join(target, 'app'); const data = join(homedir(), 'AppData/Local/CodexMobile/agent.sqlite');
const digest = () => existsSync(data) ? createHash('sha256').update(readFileSync(data)).digest('hex') : null;
const before = digest();
function assert(value: boolean, message: string) { if (!value) throw new Error(message); }
const args = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/NOICONS', '/TASKS=', `/DIR=${app}`];
try {
  execFileSync(setup, [...args, `/LOG=${join(target, 'install.log')}`], { windowsHide: true, timeout: 180000 });
  for (const file of ['RemoteCompanion.exe', 'node.exe', 'dist/agent.mjs', 'relay.json', 'unins000.exe']) assert(existsSync(join(app, file)), `Missing installed file: ${file}`);
  assert(registered(), 'Windows uninstall registration missing');
  const power = JSON.parse(execFileSync(join(app, 'RemoteCompanion.exe'), ['--power-status'], { encoding: 'utf8', windowsHide: true }));
  assert(typeof power.Available === 'boolean' && typeof power.Risk === 'boolean', 'Installed diagnostic failed');
  writeFileSync(join(app, 'user-owned-marker.txt'), 'installer must preserve untracked files');
  execFileSync(setup, [...args, `/LOG=${join(target, 'upgrade.log')}`], { windowsHide: true, timeout: 180000 });
  assert(existsSync(join(app, 'user-owned-marker.txt')), 'Upgrade removed untracked content');
  execFileSync(join(app, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/LOG=${join(target, 'uninstall.log')}`], { windowsHide: true, timeout: 180000 });
  assert(!registered(), 'Uninstall registration was not removed');
  assert(!existsSync(join(app, 'RemoteCompanion.exe')), 'Installed program was not removed');
  assert(existsSync(join(app, 'user-owned-marker.txt')), 'Uninstall removed untracked content');
  assert(digest() === before, 'User settings database changed');
  console.log(JSON.stringify({ installed: true, upgraded: true, uninstalled: true, userDataPreserved: true, untrackedFilesPreserved: true, directory: target }));
} catch (error) { console.error(`Installer verification logs: ${target}`); throw error; }
