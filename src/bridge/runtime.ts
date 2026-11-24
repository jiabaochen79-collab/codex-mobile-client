import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, rename, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { WebSocketServer, WebSocket } from 'ws';
import { DesktopBroker, type RpcMessage } from './broker.js';

const cliFiles = ['codex.exe', 'codex-code-mode-host.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe'];
async function digest(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Resolve from the actual desktop package, never the stale stable bin/codex.exe.
// Copied files stay on this computer and are not part of our distributable.
export async function managedCli(desktop: string | undefined, base: string) {
  const record = join(base, 'cli-source.json');
  if (!desktop) {
    const saved = JSON.parse(await readFile(record, 'utf8'));
    if (typeof saved.executable !== 'string' || !saved.executable.startsWith(join(base, 'cli') + '\\') || !existsSync(saved.executable)) throw new Error('No verified Codex runtime');
    return saved.executable as string;
  }
  const source = join(dirname(desktop), 'resources');
  if (!['chatgpt.exe', 'codex.exe'].includes(basename(desktop).toLowerCase()) || !existsSync(join(source, 'app.asar'))) throw new Error('Invalid desktop runtime');
  const hashes = await Promise.all(cliFiles.map(file => digest(join(source, file))));
  const id = createHash('sha256').update(hashes.join('\n')).digest('hex');
  const destination = join(base, 'cli', id);
  if (!existsSync(join(destination, 'verified.json'))) {
    await mkdir(join(base, 'cli'), { recursive: true });
    const staging = destination + '-' + randomBytes(8).toString('hex');
    await mkdir(staging);
    try {
      for (let i = 0; i < cliFiles.length; i++) {
        const file = cliFiles[i]; await copyFile(join(source, file), join(staging, file));
        if (await digest(join(staging, file)) !== hashes[i]) throw new Error('Codex changed during runtime copy');
      }
      await writeFile(join(staging, 'verified.json'), JSON.stringify({ hashes }));
      try { await rename(staging, destination); }
      catch (error) { if (!existsSync(join(destination, 'verified.json'))) throw error; }
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  const executable = join(destination, 'codex.exe');
  await writeFile(record, JSON.stringify({ executable }));
  return executable;
}

export async function runBridge(executable: string, args: string[], base: string, helper: string, desktopPid: number) {
  const environment = { ...process.env };
  delete environment.CODEX_CLI_PATH;
  delete environment.CODEX_MOBILE_DESKTOP_EXE;
  delete environment.CODEX_MOBILE_DESKTOP_PID;
  // The desktop's supported override omits these registered-package fields.
  // The actual runtime is the verified copy of the same bundled CLI and peers.
  const child = spawn(executable, args, { env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const exit = new Promise<number>(resolve => { child.once('error', () => resolve(1)); child.once('close', code => resolve(code ?? 1)); });
  if (!args.includes('app-server') || !Number.isSafeInteger(desktopPid) || desktopPid <= 0) {
    process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout);
    const result = await exit; process.stdin.unpipe(child.stdin); process.stdin.pause(); return result;
  }
  const token = randomBytes(32).toString('base64url');
  const sessionId = randomUUID();
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
  const broker = new DesktopBroker(message => {
    if (!child.stdin.write(JSON.stringify(message) + '\n')) { process.stdin.pause(); child.stdin.once('drain', () => process.stdin.resume()); }
  }, message => {
    if (!process.stdout.write(JSON.stringify(message) + '\n')) { child.stdout.pause(); process.stdout.once('drain', () => child.stdout.resume()); }
  });
  server.on('upgrade', (request, socket, head) => {
    const provided = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from('Bearer ' + token);
    if (request.url !== '/codex-mobile/v1' || request.headers.origin !== undefined || request.headers.host !== `127.0.0.1:${(server.address() as any)?.port}` || provided.length !== expected.length || !timingSafeEqual(provided, expected)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', (socket: WebSocket) => {
    const client = broker.connect(message => { if (socket.bufferedAmount > 16 * 1024 * 1024) { socket.terminate(); throw new Error('Slow local consumer'); } socket.send(JSON.stringify(message)); });
    socket.on('error', () => socket.close());
    socket.on('close', () => client.close());
    socket.on('message', (data, binary) => {
      let request: any;
      try {
        if (binary) throw new Error('Invalid frame');
        request = JSON.parse(data.toString());
        if (!request || !['string', 'number'].includes(typeof request.id) || typeof request.method !== 'string') throw new Error('Invalid request');
        if (request.method === 'bridge/status') socket.send(JSON.stringify({ id: request.id, result: { ...client.status(), protocol: 1, desktopPid, sessionId } }));
        else if (request.method === 'bridge/pending') socket.send(JSON.stringify({ id: request.id, result: client.pending(String(request.params?.threadId)) }));
        else if (request.method === 'bridge/live') socket.send(JSON.stringify({ id: request.id, result: client.live(String(request.params?.threadId)) }));
        else if (request.method === 'bridge/respond') client.respond(request.id, request.params?.requestId, request.params?.threadId, request.params?.turnId, request.params?.result);
        else client.request(request.id, request.method, request.params);
      } catch (error: any) {
        socket.send(JSON.stringify({ id: request?.id ?? null, error: { code: typeof error.code === 'string' ? error.code : 'INVALID', message: typeof error.code === 'string' ? error.message : '本机请求格式无效。' } }));
      }
    });
  });
  // A helper disconnect or failure must never end the desktop's executor.
  const descriptor = join(base, `session-${desktopPid}.dpapi`);
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const value = JSON.stringify({ protocol: 1, desktopPid, pid: process.pid, port: (server.address() as any).port, token, sessionId });
    const protectedValue = await new Promise<string>((resolve, reject) => {
      const protect = spawn(helper, ['--protect'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; protect.stdout.on('data', chunk => output += chunk); protect.stdin.end(value);
      protect.on('error', reject); protect.on('close', code => code === 0 ? resolve(output) : reject(new Error('Cannot protect bridge descriptor')));
    });
    await writeFile(descriptor + '.tmp', protectedValue, { mode: 0o600 }); await rename(descriptor + '.tmp', descriptor);
  } catch {
    // Fail open for Codex itself: only remote integration is unavailable.
    server.close(); sockets.close();
    process.stderr.write('Codex Mobile: local remote-control endpoint unavailable.\n');
  }
  const desktop = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const executor = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let failed = false;
  const handle = (line: string, source: 'desktop' | 'executor') => {
    let message: RpcMessage;
    try { message = JSON.parse(line) as RpcMessage; } catch {
      // Unknown future messages still pass through unchanged to their owner.
      if (source === 'desktop') child.stdin.write(line + '\n'); else process.stdout.write(line + '\n'); return;
    }
    if (source === 'desktop') broker.fromDesktop(message); else broker.fromExecutor(message);
  };
  desktop.on('line', line => handle(line, 'desktop'));
  executor.on('line', line => handle(line, 'executor'));
  desktop.on('close', () => child.stdin.end());
  child.stdin.on('error', () => { failed = true; });
  const result = await exit;
  broker.close(); sockets.close(); for (const socket of sockets.clients) socket.terminate(); server.close();
  desktop.close(); executor.close(); process.stdin.pause();
  await rm(descriptor, { force: true }).catch(() => {});
  return failed && result === 0 ? 1 : result;
}

export async function main() {
  const base = join(process.env.LOCALAPPDATA!, 'CodexMobile', 'bridge'); await mkdir(base, { recursive: true });
  const executable = await managedCli(process.env.CODEX_MOBILE_DESKTOP_EXE, base);
  const helper = join(dirname(resolve(process.argv[1])), 'RemoteCompanion.exe');
  return runBridge(executable, process.argv.slice(2), base, helper, Number(process.env.CODEX_MOBILE_DESKTOP_PID));
}
