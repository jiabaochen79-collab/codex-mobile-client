import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { RemoteError } from '../shared/protocol.js';

export class DesktopConnection extends EventEmitter {
  private socket?: WebSocket;
  sessionId?: string;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private helper: string, private desktopPid: number) { super(); }
  get connected() { return this.socket?.readyState === WebSocket.OPEN; }
  async connect() {
    const protectedValue = await readFile(join(process.env.LOCALAPPDATA!, 'CodexMobile', 'bridge', `session-${this.desktopPid}.dpapi`), 'utf8');
    const value = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.helper, ['--unprotect'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', chunk => output += chunk); child.stdin.end(protectedValue);
      child.on('error', reject); child.on('close', code => code === 0 ? resolve(output) : reject(new Error('Local descriptor unavailable')));
    });
    const descriptor = JSON.parse(value);
    if (descriptor.protocol !== 1 || descriptor.desktopPid !== this.desktopPid || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || !/^[a-zA-Z0-9_-]{43}$/.test(descriptor.token) || !/^[a-f0-9-]{36}$/.test(descriptor.sessionId)) throw new Error('Invalid local descriptor');
    const socket = new WebSocket(`ws://127.0.0.1:${descriptor.port}/codex-mobile/v1`, { headers: { Authorization: 'Bearer ' + descriptor.token }, maxPayload: 64 * 1024 * 1024, handshakeTimeout: 4000, perMessageDeflate: false });
    this.socket = socket;
    socket.on('message', data => {
      let message: any; try { message = JSON.parse(data.toString()); } catch { socket.close(); return; }
      const pending = this.pending.get(message.id);
      if (pending && !message.method) {
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new RemoteError(['STALE', 'BUSY', 'INVALID', 'CLIENT_UNAVAILABLE', 'OUTCOME_UNKNOWN'].includes(message.error.code) ? message.error.code : 'CLIENT_REJECTED', message.error.code === -32601 ? '当前 Codex 尚不支持此操作。' : typeof message.error.message === 'string' ? message.error.message.slice(0, 800) : 'Codex 未接受此操作。'));
        else pending.resolve(message.result);
      } else if (typeof message.method === 'string') this.emit('notification', message);
    });
    socket.on('error', () => {});
    socket.on('close', () => { if (this.socket === socket) { this.socket = undefined; this.rejectPending(); this.emit('disconnected'); } });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); socket.once('close', () => reject(new Error('Local bridge disconnected'))); });
    const status = await this.request('bridge/status', {});
    if (!status.ready || status.protocol !== 1 || status.desktopPid !== this.desktopPid || status.sessionId !== descriptor.sessionId) { this.close(); throw new RemoteError('CLIENT_UNAVAILABLE', 'Codex 原生连接正在初始化，请稍后重试。'); }
    this.sessionId = status.sessionId;
    return status;
  }
  request(method: string, params: unknown): Promise<any> {
    if (!this.connected) throw new RemoteError('CLIENT_UNAVAILABLE', 'Codex 原生连接暂不可用。');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RemoteError('OUTCOME_UNKNOWN', '电脑端尚未确认操作结果，请同步后核对，勿重复提交。')); }, 25000); timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket!.send(JSON.stringify({ id, method, params }), error => { if (error) { const pending = this.pending.get(id); if (pending) { clearTimeout(timer); this.pending.delete(id); pending.reject(new RemoteError('OUTCOME_UNKNOWN', '本机连接中断，请核对操作结果。')); } } }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private rejectPending() { for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new RemoteError('OUTCOME_UNKNOWN', 'Codex 连接已中断，请恢复后核对结果。')); } this.pending.clear(); }
  close() { const socket = this.socket; this.socket = undefined; this.rejectPending(); socket?.terminate(); }
}
