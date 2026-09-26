import { resolve, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { homedir } from 'node:os';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { Agent, createLocalServer } from './agent.js';
import { CodexDesktop } from './desktop.js';
import packageInfo from '../../package.json' with { type: 'json' };
if (process.argv.includes('--version')) { console.log(packageInfo.version); process.exit(0); }
const root = resolve(process.env.APP_ROOT ?? '.');
const settingsFile = join(root, 'relay.json');
const origin = process.env.RELAY_URL ?? (existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')).origin : 'http://127.0.0.1:8790');
const nativeExe = process.env.NATIVE_EXE ?? join(root, 'release/RemoteCompanion.exe');
const agent = new Agent({ origin, root, dir: process.env.AGENT_DATA_DIR ?? join(homedir(), 'AppData/Local/CodexMobile'), nativeExe, adapter: new CodexDesktop(nativeExe) });
let port = Number(process.env.LOCAL_PORT ?? 8791); let app: FastifyInstance | undefined;
for (let attempt = 0; attempt < 20; attempt++, port++) {
  app = await createLocalServer(agent, { port, webDir: join(root, 'dist/web') });
  try { await app.listen({ port, host: '127.0.0.1' }); break; } catch (e: any) { await app.close(); if (e.code !== 'EADDRINUSE' || attempt === 19) throw e; }
}
console.log(JSON.stringify({ type: 'ready', port, token: agent.localToken }));
const healthNonce = process.env.CODEX_MOBILE_UPDATE_HEALTH;
if (healthNonce && /^[a-f0-9-]{36}(-rollback)?$/.test(healthNonce)) {
  const dir = join(process.env.AGENT_DATA_DIR ?? join(homedir(), 'AppData/Local/CodexMobile'), 'updates'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'health-' + healthNonce + '.json'), JSON.stringify({ nonce: healthNonce, version: packageInfo.version, localReady: true }), { mode: 0o600 });
}
void agent.start();
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await app?.close(); await agent.close(); process.exit(0); };
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void stop(); });
if (process.env.NATIVE_HOST === '1') { process.stdin.resume(); process.stdin.on('end', () => { void stop(); }); process.stdin.on('data', d => { if (d.toString().trim() === 'stop') void stop(); }); }
