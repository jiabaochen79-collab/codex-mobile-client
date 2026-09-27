import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { originUrl } from '../src/shared/security.js';

if (process.platform !== 'win32') throw new Error('Build the installer on Windows.');
const { values } = parseArgs({ options: { package: { type: 'string' }, compiler: { type: 'string' }, output: { type: 'string' } } });
const packageDir = resolve(values.package ?? 'release/windows-public');
const output = resolve(values.output ?? 'release');
const compiler = values.compiler ?? process.env.INNO_SETUP_COMPILER ?? [resolve('.runtime/tools/inno-7.1.0/compiler/ISCC.exe'), resolve('.runtime/tools/inno-7.1.0/ISCC.exe')].find(existsSync) ?? resolve('.runtime/tools/inno-7.1.0/ISCC.exe');
if (!existsSync(compiler)) throw new Error('Set INNO_SETUP_COMPILER to a verified Inno Setup ISCC.exe installation.');
for (const name of ['RemoteCompanion.exe', 'node.exe', 'companion.ico', 'icons', 'dist/agent.mjs', 'dist/web/index.html', 'node_modules', 'relay.json', 'package.json']) if (!existsSync(join(packageDir, name))) throw new Error(`Incomplete Windows package: ${name}`);
const origin = originUrl(JSON.parse(readFileSync(join(packageDir, 'relay.json'), 'utf8')).origin);
if (!origin.startsWith('https:')) throw new Error('The user installer must contain an HTTPS server origin.');
const version = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('The installer requires a three-part numeric version.');
const work = resolve('.runtime/installer-build'); mkdirSync(work, { recursive: true }); mkdirSync(output, { recursive: true });
const script = join(work, 'windows.iss'); const info = join(work, 'install-info.txt');
// Explicit UTF-8 BOM keeps the compiler and the installer text language-independent.
writeFileSync(script, '\ufeff' + readFileSync('installer/windows.iss', 'utf8').replace(/^\ufeff/, ''));
writeFileSync(info, '\ufeff' + readFileSync('installer/install-info.txt', 'utf8').replace(/^\ufeff/, ''));
execFileSync(compiler, ['/Qp', `/DPackageDir=${packageDir}`, `/DAppVersion=${version}`, `/DInfoFile=${info}`, `/O${output}`, script], { windowsHide: true, stdio: 'inherit' });
const file = join(output, `ChatGPT-Remote-Assistant-Setup-${version}.exe`);
const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
writeFileSync(file + '.sha256', `${sha256}  ChatGPT-Remote-Assistant-Setup-${version}.exe\n`);
console.log(JSON.stringify({ file, sha256, version, origin, signed: false }, null, 2));
