import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { RemoteError } from '../shared/protocol.js';

function rejection(value: any) {
  const raw = typeof value === 'string' ? value : value?.message;
  const reason = typeof raw === 'string' ? raw.split(/[\r\n]/, 1)[0].replace(/[\x00-\x1f\x7f]/g, '').replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]+/gi, '[redacted]').replace(/\b(password|passwd|authorization|cookie|api[_-]?key|token|secret)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]').trim().slice(0, 400) : '';
  const code = ['NOT_FOUND', 'INVALID', 'UNSUPPORTED', 'CLIENT_UNAVAILABLE', 'BUSY'].includes(value?.code) ? value.code : value?.code === 'PERMISSION_DENIED' ? 'CLIENT_DENIED' : 'CLIENT_REJECTED';
  return new RemoteError(code, reason ? `电脑客户端拒绝操作：${reason}` : '原客户端未接受此操作，请检查目标会话。');
}

// Codex 26.901 uses length-prefixed JSON on its current-user IPC pipe.
export class NativeIpc extends EventEmitter {
  private socket?: net.Socket;
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, { method: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private connecting?: Promise<void>;
  clientId = 'initializing-client';
  constructor(private pipe = '\\\\.\\pipe\\codex-ipc', private tools = false) { super(); }
  get connected() { return !!this.socket && !this.socket.destroyed; }
  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed) return;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.pipe);
      const timer = setTimeout(() => socket.destroy(new Error('IPC connection timeout')), 4000);
      socket.once('connect', () => { clearTimeout(timer); this.socket = socket; resolve(); });
      socket.on('data', chunk => { if (this.socket === socket && !socket.destroyed) this.read(chunk); });
      socket.on('error', e => { clearTimeout(timer); reject(e); });
      socket.on('close', () => {
        clearTimeout(timer);
        if (this.socket !== socket) return;
        this.socket = undefined; this.buffer = Buffer.alloc(0); this.clientId = 'initializing-client';
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new RemoteError('OUTCOME_UNKNOWN', '客户端连接中断，请核对操作结果，勿重复提交。')); }
        this.pending.clear(); this.emit('disconnected');
      });
    }).then(async () => {
      if (!this.tools) {
        const result = await this.request('initialize', { clientType: 'codex-mobile' }, 0);
        if (result.resultType !== 'success' || typeof result.result?.clientId !== 'string' || !result.result.clientId || result.result.clientId.length > 200 || result.result.clientId === 'initializing-client') throw new RemoteError('UNSUPPORTED', '客户端通讯握手格式不兼容，请更新助手。');
        this.clientId = result.result.clientId;
      }
    }).catch(error => { this.close(); throw error; }).finally(() => { this.connecting = undefined; });
    await this.connecting;
  }
  private send(message: unknown) {
    const payload = Buffer.from(JSON.stringify(message));
    if (!this.socket || payload.length > 2 * 1024 * 1024 || this.socket.writableLength > 4 * 1024 * 1024) throw new RemoteError('UNAVAILABLE', '客户端连接不可用。');
    const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
    this.socket.write(Buffer.concat([header, payload]));
  }
  async request(method: string, params: unknown, version = 1, targetClientId?: string): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RemoteError('OUTCOME_UNKNOWN', '客户端未及时确认，请先核对原会话。')); }, 15000);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.send(this.tools ? { jsonrpc: '2.0', id, method, params } : { type: 'request', requestId: id, sourceClientId: this.clientId, method, version, params, targetClientId, timeoutMs: 12000 });
      } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  broadcast(method: string, params: unknown, targetClientIds?: string[], version = 1) {
    this.send({ type: 'broadcast', method, params, targetClientIds, sourceClientId: this.clientId, version });
  }
  private read(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE();
      if (size > 64 * 1024 * 1024 || size === 0) { this.close(); return; }
      if (this.buffer.length < size + 4) return;
      let message: any;
      try { message = JSON.parse(this.buffer.subarray(4, size + 4).toString()); } catch { this.close(); return; }
      this.buffer = this.buffer.subarray(size + 4);
      if (!message || typeof message !== 'object' || Array.isArray(message)) { this.close(); return; }
      if (message.type === 'response' || this.tools && ('result' in message || 'error' in message)) {
        const id = String(message.requestId ?? message.id); const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id); clearTimeout(pending.timer);
          if (message.error || !this.tools && message.resultType === 'error') pending.reject(rejection(message.error ?? message.result));
          else if (!this.tools && (message.resultType !== 'success' || message.method !== undefined && message.method !== pending.method)) pending.reject(new RemoteError('OUTCOME_UNKNOWN', '客户端返回格式不兼容，操作结果未确认，请在电脑核对，勿重复提交。'));
          else pending.resolve(message);
        }
      } else if (message.type === 'client-discovery-request') {
        try { this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } }); } catch { this.close(); return; }
      } else if (message.type === 'broadcast') this.emit('broadcast', message);
    }
  }
  close() {
    const socket = this.socket; this.socket = undefined; this.clientId = 'initializing-client'; this.buffer = Buffer.alloc(0);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new RemoteError('OUTCOME_UNKNOWN', '连接已关闭，请核对原会话。')); }
    this.pending.clear(); socket?.destroy(); this.emit('disconnected');
  }
}
