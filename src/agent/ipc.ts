import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { RemoteError } from '../shared/protocol.js';
import { compactJson } from './compact-json.js';
import { errorText } from './error-text.js';

// Raw tool output is unused by mobile history. Keep response envelopes and arguments.
export const unusedHistoryOutput = /^(?:params\.change\.conversationState\.)?(?:turns\.\d+|turnHistory\.history\.entitiesByKey\.[^.]+)\.items\.\d+\.(?:result|aggregatedOutput)(?:\.|$)/;

export class IpcRoutingError extends RemoteError {
  constructor() { super('CLIENT_UNAVAILABLE', '电脑端任务连接暂不可用，请稍后重试。'); }
}

function rejection(value: any) {
  const raw = typeof value === 'string' ? value : value?.message;
  const reason = errorText(raw);
  const code = ['NOT_FOUND', 'INVALID', 'UNSUPPORTED', 'CLIENT_UNAVAILABLE', 'BUSY'].includes(value?.code) ? value.code : value?.code === 'PERMISSION_DENIED' ? 'CLIENT_DENIED' : 'CLIENT_REJECTED';
  return new RemoteError(code, reason ? `电脑客户端拒绝操作：${reason}` : '原客户端未接受此操作，请检查目标会话。');
}

// Codex 26.901 uses length-prefixed JSON on its current-user IPC pipe.
export class NativeIpc extends EventEmitter {
  private socket?: net.Socket;
  private buffer = Buffer.alloc(0);
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private frameBytes = 0;
  private frameOffset = 0;
  private compact?: ReturnType<typeof compactJson>;
  private generation = 0;
  private pending = new Map<string, { method: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private connecting?: Promise<void>;
  clientId = 'initializing-client';
  constructor(private pipe = '\\\\.\\pipe\\codex-ipc', private tools = false) { super(); }
  get connected() { return !!this.socket && !this.socket.destroyed; }
  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed) return;
    const socket = net.createConnection(this.pipe);
    const connecting = new Promise<void>((resolve, reject) => {
      this.socket = socket;
      const timer = setTimeout(() => socket.destroy(new Error('IPC connection timeout')), 4000);
      socket.once('connect', () => { clearTimeout(timer); if (this.socket !== socket || socket.destroyed) { reject(new RemoteError('UNAVAILABLE', '连接已关闭。')); return; } resolve(); });
      socket.on('data', chunk => { if (this.socket === socket && !socket.destroyed) this.read(chunk); });
      socket.on('error', e => { clearTimeout(timer); reject(e); });
      socket.on('close', () => {
        clearTimeout(timer);
        reject(new RemoteError('UNAVAILABLE', '连接已关闭。'));
        if (this.socket !== socket) return;
        this.socket = undefined; this.resetReader(); this.clientId = 'initializing-client';
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new RemoteError('OUTCOME_UNKNOWN', '客户端连接中断，请核对操作结果，勿重复提交。')); }
        this.pending.clear(); this.emit('disconnected');
      });
    }).then(async () => {
      if (this.socket !== socket || socket.destroyed) throw new RemoteError('UNAVAILABLE', '连接已关闭。');
      if (!this.tools) {
        const result = await this.request('initialize', { clientType: 'codex-mobile' }, 0);
        if (result.resultType !== 'success' || typeof result.result?.clientId !== 'string' || !result.result.clientId || result.result.clientId.length > 200 || result.result.clientId === 'initializing-client') throw new RemoteError('UNSUPPORTED', '客户端通讯握手格式不兼容，请更新助手。');
        this.clientId = result.result.clientId;
      }
    }).catch(error => { if (this.socket === socket) this.close(); throw error; }).finally(() => { if (this.connecting === connecting) this.connecting = undefined; });
    this.connecting = connecting;
    await connecting;
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
    const generation = this.generation;
    for (let offset = 0; offset < chunk.length;) {
      if (!this.frameBytes) {
        const length = Math.min(4 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + length); this.headerBytes += length; offset += length;
        if (this.headerBytes < 4) return;
        const size = this.header.readUInt32LE(); this.headerBytes = 0;
        if (!size || size > 256 * 1024 * 1024) { this.close(); return; }
        this.frameBytes = size; this.frameOffset = 0;
        if (size > 64 * 1024 * 1024) {
          // Historical tool output is not part of mobile snapshots. Stream it
          // away instead of retaining the oversized native frame.
          this.compact = compactJson(unusedHistoryOutput, 64 * 1024 * 1024, message => { if (generation === this.generation) this.message(message); }, () => { if (generation === this.generation) this.close(); });
        } else this.buffer = Buffer.allocUnsafe(size);
      }
      const length = Math.min(this.frameBytes - this.frameOffset, chunk.length - offset);
      if (this.compact) this.compact.write(chunk.subarray(offset, offset + length));
      else chunk.copy(this.buffer, this.frameOffset, offset, offset + length);
      if (generation !== this.generation) return;
      this.frameOffset += length; offset += length;
      if (this.frameOffset === this.frameBytes) {
        const compact = this.compact; const buffer = this.buffer;
        this.compact = undefined; this.buffer = Buffer.alloc(0); this.frameBytes = 0; this.frameOffset = 0;
        if (compact) compact.end();
        else { let message: any; try { message = JSON.parse(buffer.toString()); } catch { this.close(); return; } this.message(message); }
        if (generation !== this.generation) return;
      }
    }
  }
  private message(message: any) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) { this.close(); return; }
      if (message.type === 'response' || this.tools && ('result' in message || 'error' in message)) {
        const id = String(message.requestId ?? message.id); const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id); clearTimeout(pending.timer);
          // A routing error is transient, but does not authorize replaying a sent operation.
          if (!this.tools && message.resultType === 'error' && message.error === 'no-client-found' && message.handledByClientId === undefined) pending.reject(new IpcRoutingError());
          else if (message.error || !this.tools && message.resultType === 'error') pending.reject(rejection(message.error ?? message.result));
          else if (!this.tools && (message.resultType !== 'success' || message.method !== undefined && message.method !== pending.method)) pending.reject(new RemoteError('OUTCOME_UNKNOWN', '客户端返回格式不兼容，操作结果未确认，请在电脑核对，勿重复提交。'));
          else pending.resolve(message);
        }
      } else if (message.type === 'client-discovery-request') {
        try { this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } }); } catch { this.close(); return; }
      } else if (message.type === 'broadcast') this.emit('broadcast', message);
  }
  private resetReader() { this.generation++; this.buffer = Buffer.alloc(0); this.headerBytes = 0; this.frameBytes = 0; this.frameOffset = 0; this.compact?.destroy(); this.compact = undefined; }
  close() {
    const socket = this.socket; this.socket = undefined; this.connecting = undefined; this.clientId = 'initializing-client'; this.resetReader();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new RemoteError('OUTCOME_UNKNOWN', '连接已关闭，请核对原会话。')); }
    this.pending.clear(); socket?.destroy(); this.emit('disconnected');
  }
}
