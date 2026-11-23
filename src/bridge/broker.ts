import { randomUUID } from 'node:crypto';
import { RemoteError } from '../shared/protocol.js';
import { LiveState } from './live-state.js';

export type RpcId = string | number;
export type RpcMessage = { id?: RpcId; method?: string; params?: any; result?: any; error?: any };
type Client = { send: (message: RpcMessage) => void };
type Pending = { client: Client; id: RpcId; method: string; threadId?: string; timer: NodeJS.Timeout };
type Approval = { message: RpcMessage; submitted: boolean; client?: Client; id?: RpcId; timer?: NodeJS.Timeout };

const methods = new Set([
  'model/list', 'permissionProfile/list', 'collaborationMode/list',
  'thread/read', 'thread/resume', 'thread/list', 'thread/turns/list', 'thread/items/list', 'thread/items/read', 'thread/loaded/list',
  'thread/settings/update', 'thread/goal/get', 'thread/goal/set', 'thread/goal/clear', 'thread/prepareApprovedPlan',
  'thread/queue/list', 'thread/readState/update', 'turn/start', 'turn/steer', 'turn/interrupt', 'turn/settings/update'
]);
const approvals = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval']);
const key = (id: RpcId) => `${typeof id}:${id}`;

// Multiplex into the desktop's single initialized executor. The desktop keeps
// ownership of initialization, account credentials and all other native tools.
export class DesktopBroker {
  private clients = new Set<Client>();
  private pending = new Map<string, Pending>();
  private desktopRequests = new Map<string, { method: string; threadId?: string }>();
  private approvals = new Map<string, Approval>();
  private initialized?: { userAgent: string; codexHome: string };
  private closed = false;
  private live = new LiveState();
  constructor(private executor: (message: RpcMessage) => void, private desktop: (message: RpcMessage) => void) {}

  connect(send: Client['send']) {
    const client = { send };
    this.clients.add(client);
    return {
      request: (id: RpcId, method: string, params: unknown) => this.request(client, id, method, params),
      respond: (id: RpcId, requestId: RpcId, threadId: string, turnId: string | undefined, result: unknown) => this.respond(client, id, requestId, threadId, turnId, result),
      pending: (threadId: string) => [...this.approvals.values()].filter(entry => entry.message.params?.threadId === threadId && !entry.submitted).map(entry => entry.message),
      status: () => ({ ready: !!this.initialized && !this.closed, ...this.initialized }),
      live: (threadId: string) => this.live.read(threadId),
      close: () => this.disconnect(client)
    };
  }

  fromDesktop(message: RpcMessage) {
    if (this.closed) return;
    if (message.id !== undefined && message.method) this.desktopRequests.set(key(message.id), { method: message.method, threadId: message.params?.threadId });
    else if (message.id !== undefined) {
      const pending = this.approvals.get(key(message.id));
      if (pending?.submitted) return;
      if (pending) pending.submitted = true;
    }
    this.executor(message);
  }

  fromExecutor(message: RpcMessage) {
    if (this.closed) return;
    this.live.accept(message);
    if (message.id !== undefined && !message.method) {
      const id = key(message.id);
      const pending = this.pending.get(id);
      if (pending) {
        if (pending.method === 'turn/start' && pending.threadId && !message.error) this.live.started(pending.threadId, message.result?.turn);
        this.pending.delete(id); clearTimeout(pending.timer);
        this.deliver(pending.client, { id: pending.id, ...('error' in message ? { error: message.error } : { result: message.result }) });
        return;
      }
      if (typeof message.id === 'string' && message.id.startsWith('codex-mobile:') && !this.desktopRequests.has(id)) return;
      const request = this.desktopRequests.get(id), method = request?.method;
      this.desktopRequests.delete(id);
      if (method === 'turn/start' && request?.threadId && !message.error) this.live.started(request.threadId, message.result?.turn);
      if (method === 'initialize' && !message.error && typeof message.result?.userAgent === 'string' && typeof message.result?.codexHome === 'string') {
        this.initialized = { userAgent: message.result.userAgent, codexHome: message.result.codexHome };
      }
    } else if (message.id !== undefined && message.method && approvals.has(message.method)) {
      this.approvals.set(key(message.id), { message, submitted: false });
    }
    if (message.method === 'serverRequest/resolved') {
      const requestId = message.params?.requestId;
      if (typeof requestId === 'string' || typeof requestId === 'number') {
        const id = key(requestId), pending = this.approvals.get(id);
        if (pending && pending.message.params?.threadId === message.params?.threadId) {
          this.approvals.delete(id); clearTimeout(pending.timer);
          if (pending.client && pending.id !== undefined) this.deliver(pending.client, { id: pending.id, result: { accepted: true } });
        }
      }
    }
    this.desktop(message);
    if (message.method && (/^(?:thread|turn|item)\//.test(message.method) || message.method === 'serverRequest/resolved') && (message.id === undefined || approvals.has(message.method))) {
      for (const client of this.clients) this.deliver(client, message);
    }
  }

  private request(client: Client, id: RpcId, method: string, params: unknown) {
    if (!this.initialized || this.closed || !this.clients.has(client)) throw new RemoteError('CLIENT_UNAVAILABLE', 'Codex 原生连接尚未就绪。');
    if (!methods.has(method)) throw new RemoteError('INVALID', '此操作不属于远程助手支持的原生功能。');
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new RemoteError('INVALID', '原生请求参数无效。');
    if ([...this.pending.values()].some(entry => entry.client === client && key(entry.id) === key(id))) throw new RemoteError('BUSY', '该请求仍在等待确认。');
    let wireId: string;
    do { wireId = `codex-mobile:${randomUUID()}`; } while (this.desktopRequests.has(key(wireId)) || this.pending.has(key(wireId)));
    const timer = setTimeout(() => {
      this.pending.delete(key(wireId));
      this.deliver(client, { id, error: { code: 'OUTCOME_UNKNOWN', message: 'Codex 尚未确认操作结果，请重新同步后核对，勿重复提交。' } });
    }, 20000);
    timer.unref();
    this.pending.set(key(wireId), { client, id, timer, method, threadId: typeof (params as any).threadId === 'string' ? (params as any).threadId : undefined });
    try { this.executor({ id: wireId, method, params }); }
    catch (error) { this.pending.delete(key(wireId)); clearTimeout(timer); throw error; }
  }

  private respond(client: Client, id: RpcId, requestId: RpcId, threadId: string, turnId: string | undefined, result: unknown) {
    if (!this.initialized || this.closed || !this.clients.has(client)) throw new RemoteError('CLIENT_UNAVAILABLE', 'Codex 原生连接尚未就绪。');
    const pending = this.approvals.get(key(requestId));
    if (!pending || pending.submitted || pending.message.params?.threadId !== threadId || turnId !== undefined && pending.message.params?.turnId !== turnId) throw new RemoteError('STALE', '电脑端的问题或审批已经变化，请重新同步。');
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new RemoteError('INVALID', '回复参数无效。');
    pending.submitted = true; pending.client = client; pending.id = id;
    pending.timer = setTimeout(() => {
      delete pending.client; delete pending.id;
      this.deliver(client, { id, error: { code: 'OUTCOME_UNKNOWN', message: '回复已提交，但尚未收到原生确认，请同步后核对。' } });
    }, 20000);
    pending.timer.unref();
    try { this.executor({ id: requestId, result }); }
    catch (error) { clearTimeout(pending.timer); delete pending.client; delete pending.id; throw error; }
  }

  private disconnect(client: Client) {
    this.clients.delete(client);
    for (const [id, entry] of this.pending) if (entry.client === client) { clearTimeout(entry.timer); this.pending.delete(id); }
    // Submitted approvals remain unavailable until the executor confirms them.
    for (const entry of this.approvals.values()) if (entry.client === client) { clearTimeout(entry.timer); delete entry.client; delete entry.id; }
  }

  private deliver(client: Client, message: RpcMessage) {
    if (!this.clients.has(client)) return;
    try { client.send(message); } catch { this.disconnect(client); }
  }

  close() {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      this.deliver(pending.client, { id: pending.id, error: { code: 'OUTCOME_UNKNOWN', message: 'Codex 连接已中断，请恢复后核对操作结果。' } });
    }
    for (const entry of this.approvals.values()) clearTimeout(entry.timer);
    this.pending.clear(); this.approvals.clear(); this.desktopRequests.clear(); this.clients.clear();
  }
}
