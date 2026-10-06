import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { AgentStore } from './store.js';
import { MAX_FRAME, RemoteError, codeSchema, passwordSettingsSchema, commandFrame, publicError, readMethods, isSafetyCommand, supportsDesktopCommand, uid, type ControlLease, type PasswordSettings, type ClientStatus, type DesktopAdapter, type Snapshot, type Command, type LocalAttachment } from '../shared/protocol.js';
import { redeemSchema, subscriptionSchema, type Subscription } from '../shared/subscription.js';
import { parseUploadFrame } from '../shared/upload-frame.js';
import { UploadStore } from './uploads.js';
import { equalSecret, hash, originUrl, RateLimit, token, verificationCode } from '../shared/security.js';
import { serveWeb } from '../web-server.js';
import { REMEMBERED_SESSION_MS, TEMPORARY_SESSION_MS } from '../shared/session.js';
import { checkoutSchema, refundRequestSchema } from '../shared/commerce.js';
import { SendQueue, type QueueEntry } from './send-queue.js';
import { snapshotResponse } from './snapshot-response.js';
import packageInfo from '../../package.json' with { type: 'json' };
import { ConnectionHttpError, connectionFailure, type ConnectionStage } from './connection-error.js';
import { HelperUpdater } from './updater.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CompletionMonitor } from './notifications.js';

export class Agent {
  private updater?: HelperUpdater;
  private updateFrozen = false;
  readonly localToken = token();
  readonly epoch = randomUUID();
  private code = verificationCode();
  private codeExpires: number | null = Date.now() + 12 * 3600000;
  private passwordMode: PasswordSettings['mode'] = 'automatic';
  private credentials?: { id: string; secret: string };
  private socket?: WebSocket;
  private computerFingerprint?: string;
  private computerIdentitySent = false;
  private reconnect?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private changeTimer?: NodeJS.Timeout;
  private changed = new Set<string>();
  private control?: ControlLease;
  private controlDeadline?: number;
  private uploads: UploadStore;
  private failures = 0;
  private lastPong = 0;
  private lastPing = 0;
  private lastStatus = '';
  private lastStatusAt = 0;
  private refreshing = false;
  private closing = false;
  private grants = new Map<string, number>();
  private pairLimit = new RateLimit(5, 15 * 60000);
  private queue = Promise.resolve();
  private commandWork: { priority: number; work: () => Promise<void> }[] = [];
  private queued = 0;
  private safetyQueued = 0;
  private mediaQueue = Promise.resolve();
  private mediaQueued = 0;
  private subscription?: Subscription;
  private feedbackUnread = 0;
  private feedbackReading = false;
  private feedbackCheckedAt = 0;
  private client: ClientStatus = { available: false, version: null, reason: '正在连接客户端。' };
  private connection = 'connecting';
  private connectionError: ReturnType<typeof connectionFailure> | null = null;
  private enabled = false;
  readonly origin: string;
  private store: AgentStore;
  private sends: SendQueue;
  private queueTimer?: NodeJS.Timeout;
  private notificationTimer?: NodeJS.Timeout;
  private completionMonitor: CompletionMonitor;
  private pumping = false;
  private queueCursor = 0;
  private stopping = new Set<string>();
  private subscriptions: string[] = [];
  private queueAuthorizations = new Map<string, { resolve: (value: { allowed: boolean; validForMs: number; retryable?: boolean }) => void; timer: NodeJS.Timeout }>();
  constructor(private options: { origin: string; dir: string; nativeExe?: string; root?: string; adapter: DesktopAdapter }) {
    if (!isAbsolute(options.dir) || /%[^%]+%/.test(options.dir)) throw new Error('Agent data directory must be an absolute resolved path.');
    this.origin = originUrl(options.origin); this.store = new AgentStore(options.dir, options.nativeExe);
    this.sends = new SendQueue(this.store, this.origin);
    this.uploads = new UploadStore(options.dir, this.store.db);
    this.completionMonitor = new CompletionMonitor(this.store, taskIds => this.options.adapter.notificationSources?.(taskIds) ?? []);
    if (options.root && process.platform === 'win32' && this.origin.startsWith('https:')) this.updater = new HelperUpdater({ dir: options.dir, root: options.root, version: packageInfo.version, store: this.store, request: (path, init) => this.serviceRequest(path, init), blockers: () => this.updateBlockers(), freeze: v => { this.updateFrozen = v; } });
    this.enabled = this.store.get(`enabled:${hash(this.origin)}`) === 'true';
    if (this.enabled) this.grants = this.store.grants(this.origin); else this.store.clearGrants(this.origin);
    const password = this.store.passwordSettings(this.origin);
    if (password.mode === 'custom') { this.passwordMode = 'custom'; this.code = password.password; this.codeExpires = null; }
    options.adapter.onChange = id => {
      this.notifyQueue(id);
    };
  }
  async start() {
    this.completionMonitor.start();
    await this.connect();
    this.updater?.start();
    this.timer = setInterval(() => { void this.refresh(); }, 5000); this.timer.unref();
    this.queueTimer = setInterval(() => { this.pumpQueue(); }, 1500); this.queueTimer.unref();
    this.notificationTimer = setInterval(() => { void this.flushNotifications(); }, 2000); this.notificationTimer.unref();
  }
  private async connect() {
    if (this.closing) return;
    let stage: ConnectionStage = 'credentials';
    try {
      let credentials = this.store.credentials(this.origin);
      if (!credentials) {
        stage = 'register';
        const response = await fetch(`${this.origin}/api/devices`, { method: 'POST', signal: AbortSignal.timeout(10000), redirect: 'error' });
        if (!response.ok) { await response.body?.cancel(); throw new ConnectionHttpError(response.status); }
        const parsed = z.object({ id: z.string().regex(/^[1-9][0-9]{8}$/), secret: z.string().min(40).max(100) }).parse(await response.json());
        stage = 'save';
        credentials = { ...parsed, origin: this.origin }; this.store.saveCredentials(credentials);
      }
      this.credentials = credentials;
      stage = 'connect';
      const url = new URL('/ws/host', this.origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('deviceId', credentials.id); url.searchParams.set('epoch', this.epoch);
      const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${credentials.secret}` }, maxPayload: MAX_FRAME, perMessageDeflate: false, handshakeTimeout: 30000, followRedirects: false });
      let socketError: ReturnType<typeof connectionFailure> | undefined;
      this.socket = socket;
      socket.on('open', () => { this.connection = 'online'; this.connectionError = null; this.failures = 0; this.lastPong = Date.now(); this.lastPing = 0; this.lastStatus = ''; this.computerIdentitySent = false; void this.announceComputer(); void this.refresh(); void this.flushNotifications(); void this.updater?.reportPrevious(); void this.updater?.connected(); });
      socket.on('pong', () => { this.lastPong = Date.now(); });
      socket.on('message', (data, binary) => { if (this.socket === socket) { if (binary) this.uploadChunk(Buffer.from(data as Buffer)); else void this.message(data.toString()); } });
      socket.on('unexpected-response', (_req, response) => { socketError = connectionFailure('connect', new ConnectionHttpError(response.statusCode ?? 502)); response.resume(); socket.terminate(); });
      socket.on('error', error => { if (this.socket === socket) { this.connection = 'offline'; this.connectionError = socketError ??= connectionFailure('connect', error); } });
      socket.on('close', code => { if (this.socket === socket) { this.connectionError = socketError ?? connectionFailure('connect', code === 4001 ? new ConnectionHttpError(401) : new Error('Disconnected')); this.socket = undefined; this.control = undefined; this.subscription = undefined; this.computerIdentitySent = false; this.retry(); } });
    } catch (e) { this.connectionError = connectionFailure(stage, e); this.retry(); }
  }
  private retry() {
    if (this.closing || this.reconnect) return;
    this.connection = 'offline';
    this.reconnect = setTimeout(() => { this.reconnect = undefined; void this.connect(); }, Math.min(15000, 1000 * 2 ** Math.min(++this.failures, 4)) + Math.floor(Math.random() * 500));
  }
  private async refresh() {
    if (this.closing || this.refreshing) return;
    this.refreshing = true;
    try {
    if (this.socket?.readyState === WebSocket.OPEN) {
      if (Date.now() - this.lastPong > 75000) { this.socket.terminate(); return; }
      if (Date.now() - this.lastPing > 10000) { this.socket.ping(); this.lastPing = Date.now(); }
    }
    if (this.codeExpires !== null && Date.now() >= this.codeExpires) this.refreshCode();
    this.client = await this.options.adapter.status();
    this.client = { ...this.client, capabilities: [...new Set([...(this.client.capabilities ?? []), 'queued-send', 'multi-terminal', 'command-status'])] };
    if (this.closing) { this.options.adapter.close(); return; }
    for (const [id, until] of this.grants) if (until <= Date.now()) { this.store.deleteGrant(this.origin, id); this.grants.delete(id); }
    const frame = { type: 'status', helperVersion: packageInfo.version, enabled: this.enabled, status: this.client, update: this.updater?.state, authorizedSessions: [...this.grants.keys()] };
    const serialized = JSON.stringify(frame);
    if (this.socket?.readyState === WebSocket.OPEN && (serialized !== this.lastStatus || Date.now() - this.lastStatusAt >= 30000)) {
      this.send(frame); this.lastStatus = serialized; this.lastStatusAt = Date.now();
    }
    } finally { this.refreshing = false; }
  }
  private send(message: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > MAX_FRAME || this.socket.bufferedAmount > MAX_FRAME * 2) { this.socket.close(1009); return; }
    this.socket.send(text);
  }
  private async message(text: string) {
    if (this.closing) return;
    let m: any; try { m = JSON.parse(text); } catch { return; }
    if (m.type === 'queue-authorization') { const parsed = z.object({ id: uid, allowed: z.boolean(), validForMs: z.number().int().min(0).max(10000) }).safeParse(m); if (parsed.success) { const pending = this.queueAuthorizations.get(parsed.data.id); if (pending) { clearTimeout(pending.timer); this.queueAuthorizations.delete(parsed.data.id); pending.resolve(parsed.data); } } return; }
    if (m.type === 'notification-ack') {
      const parsed = z.object({ type: z.literal('notification-ack'), eventId: z.string().regex(/^[a-f0-9]{64}$/), accepted: z.boolean(), errorCode: z.string().optional(), occurredAt: z.number().int().positive().optional(), serverTime: z.number().int().positive().optional() }).safeParse(m);
      if (parsed.success) {
        const ack = parsed.data;
        if (ack.accepted) this.store.ackNotification(ack.eventId);
        else if (ack.errorCode === 'NOTIFICATION_TIME' && ack.occurredAt !== undefined && ack.serverTime !== undefined && this.store.rejectNotificationTime(ack.eventId, ack.occurredAt)) this.store.syncNotificationClock(this.origin, ack.serverTime);
      }
      return;
    }
    if (m.type === 'subscription') { const parsed = subscriptionSchema.safeParse(m.subscription); if (parsed.success) { this.subscription = parsed.data; this.store.syncNotificationClock(this.origin, parsed.data.serverTime); void this.flushNotifications(); } return; }
    if (m.type === 'control') {
      const lease = z.object({ sessionId: uid, clientId: uid, epoch: uid, expires: z.number().int() }).nullable().safeParse(m.lease);
      if (!lease.success || lease.data && (this.grants.get(lease.data.sessionId) ?? 0) <= Date.now()) { this.send({ type: 'control-result', id: m.id, ok: false }); return; }
      const serverTime = Number.isSafeInteger(m.serverTime) ? m.serverTime : Date.now() + Number(this.store.get(`notification:clock:${hash(this.origin)}`) ?? 0);
      this.control = lease.data ?? undefined;
      this.controlDeadline = lease.data ? performance.now() + Math.max(0, Math.min(90000, lease.data.expires - serverTime)) : undefined;
      this.send({ type: 'control-result', id: m.id, ok: true }); return;
    }
    if (m.type === 'subscriptions') { const ids = z.array(uid).max(6).safeParse(m.ids); if (ids.success) { this.subscriptions = ids.data; this.updateSubscriptions(); } return; }
    if (m.type === 'pair') {
      let ok = false;
      let error: ReturnType<typeof publicError> | undefined;
      try {
        this.pairLimit.take('device');
        const p = z.object({ type: z.literal('pair'), id: z.string().uuid(), code: codeSchema, sessionId: z.string().uuid(), remember: z.boolean().default(false) }).strict().parse(m);
        const validCode = (this.codeExpires === null || this.codeExpires > Date.now()) && equalSecret(this.code, p.code);
        ok = this.enabled && this.grants.size < 32 && validCode;
        if (!this.enabled && validCode) error = { code: 'REMOTE_DISABLED', message: '电脑端未开启“允许远程连接”，请在 Windows 助手中勾选后重试。' };
        if (ok) {
          const expires = Date.now() + (p.remember ? REMEMBERED_SESSION_MS : TEMPORARY_SESSION_MS);
          if (p.remember) this.store.saveGrant(this.origin, p.sessionId, expires);
          this.grants.set(p.sessionId, expires); this.pairLimit.reset('device');
          // Consume the one-time code before another pairing request can use it.
          if (this.passwordMode === 'automatic') this.refreshCode();
        }
      } catch (e) { ok = false; if (e instanceof RemoteError && e.code === 'RATE_LIMIT') error = publicError(e); }
      this.send({ type: 'pair-result', id: m.id, ok, ...(error ? { error } : {}) }); return;
    }
    if (m.type === 'revoke' && typeof m.sessionId === 'string') { this.store.deleteGrant(this.origin, m.sessionId); this.grants.delete(m.sessionId); for (const id of this.sends.pause('原手机授权已失效，请重新确认后继续。', undefined, m.sessionId)) this.notifyQueue(id); if (this.control?.sessionId === m.sessionId) this.control = undefined; return; }
    if (m.type !== 'command') return;
    const sessionId = m.sessionId;
    const parsed = commandFrame.safeParse({ type: m.type, id: m.id, command: m.command, controlEpoch: m.controlEpoch });
    if (!parsed.success || typeof sessionId !== 'string') return;
    const frame = parsed.data;
    if (this.updateFrozen) { this.send({ type: 'result', id: frame.id, sessionId, clientId: m.clientId, error: { code: 'UPDATING', message: '助手正在准备更新，请稍后重试。' } }); return; }
    const image = frame.command.method === 'image.read';
    const safety = isSafetyCommand(frame.command);
    if (image ? this.mediaQueued >= 6 : safety ? this.safetyQueued >= 6 : this.queued >= 16) { this.send({ type: 'result', id: frame.id, sessionId, clientId: m.clientId, error: { code: 'BUSY', message: '请求过多，请稍后重试。' } }); return; }
    if (image) this.mediaQueued++; else if (safety) this.safetyQueued++; else this.queued++;
    if (frame.command.method === 'stop') { try { this.authorizeControl(sessionId, m.clientId, frame.controlEpoch); this.stopping.add(frame.command.params.id); } catch {} }
    const work = async () => {
      try {
        if (!this.enabled || (this.grants.get(sessionId) ?? 0) <= Date.now()) throw new RemoteError('AUTH', '远控授权已失效。');
        const authorize = () => {
          if (this.closing || !this.enabled || (this.grants.get(sessionId) ?? 0) <= Date.now()) throw new RemoteError('AUTH', '远控授权已失效。');
          if (this.subscription && !this.subscription.access && !isSafetyCommand(frame.command)) throw new RemoteError('SUBSCRIPTION_REQUIRED', '订阅未开通或已到期。');
          if (!supportsDesktopCommand(this.client.capabilities, frame.command)) throw new RemoteError('UNSUPPORTED', '当前客户端的此项接口尚未适配，操作未执行。');
          if (!readMethods.has(frame.command.method)) this.authorizeControl(sessionId, m.clientId, frame.controlEpoch);
        };
        authorize(); const command = frame.command;
        let result: unknown;
        if (command.method === 'upload.begin') {
          const available = await this.options.adapter.execute({ method: 'activity', params: { ids: [command.params.id] } }, frame.id) as any;
          if (!available.activities?.length) throw new RemoteError('NOT_FOUND', '目标任务不存在。');
          authorize(); result = this.uploads.begin(frame.id, sessionId, command.params);
        } else if (command.method === 'upload.status') result = this.uploads.status(command.params.attachmentId, sessionId);
        else if (command.method === 'upload.complete') result = await this.uploads.complete(command.params.attachmentId, sessionId, authorize);
        else if (command.method === 'upload.remove') result = this.uploads.remove(command.params.attachmentId, sessionId);
        else if (command.method === 'queue.list') result = { queued: this.sends.list(command.params.id) };
        else if (command.method === 'command.status') result = this.store.commandStatus(command.params.requestId, sessionId, command.params.id);
        else if (command.method === 'read') {
          const snapshot = await this.options.adapter.execute({ ...command, params: { ...command.params, ifRevision: undefined } }, frame.id) as Snapshot;
          result = snapshotResponse({ ...snapshot, queued: this.sends.list(command.params.id) }, command.params.ifRevision);
        }
        else result = await this.store.once(command.method === 'plan.respond' ? `plan:${hash(JSON.stringify([this.origin, command.params.id, command.params.requestId]))}` : frame.id, command, async () => {
          if (command.method === 'plan.respond' && this.sends.entries(command.params.id).length) throw new RemoteError('QUEUE_PENDING', '请先处理待发送消息，再确认计划。');
          if (command.method === 'queue.remove') { authorize(); const result = this.sends.remove(command.params.queuedId, command.params.id); this.notifyQueue(command.params.id); this.updateSubscriptions(); return result; }
          if (command.method === 'queue.resume') {
            const current = await this.options.adapter.execute({ method: 'read', params: { id: command.params.id, limit: 20 } }, frame.id) as Snapshot;
            if (current.epoch !== command.params.epoch) throw new RemoteError('STALE', '任务已重新连接，请刷新队列。'); authorize();
            const result = this.sends.resume(command.params.queuedId, command.params.id, sessionId, current.epoch, ['failed','interrupted'].includes(current.lastTurnStatus ?? '') ? current.lastTurnId ?? '' : null); this.notifyQueue(command.params.id); this.updateSubscriptions(); return result;
          }
          const attachments = command.method === 'send' ? this.uploads.resolve(command.params.attachmentIds ?? [], sessionId, command.params.id) : [];
          if (command.method === 'send' && command.params.mode === 'queue') {
            const current = await this.options.adapter.execute({ method: 'read', params: { id: command.params.id, limit: 20 } }, frame.id) as Snapshot;
            if (current.epoch !== command.params.epoch) throw new RemoteError('STALE', '任务已重新连接，请刷新后排队。'); authorize();
            this.sends.add(frame.id, current.id, sessionId, current.epoch, { text: command.params.text, attachments: attachments.map(a => ({ id: a.id, name: a.name })) }); this.updateSubscriptions(); this.notifyQueue(current.id); return { accepted: true, queued: true, messageId: frame.id };
          }
          if (command.method === 'send' && command.params.mode !== 'steer' && this.sends.entries(command.params.id).length) throw new RemoteError('QUEUE_PENDING', '当前任务已有待发送消息，请使用排队发送或先处理队列。');
          const startedAt = Date.now();
          if (command.method === 'send' || command.method === 'plan.respond') await this.completionMonitor.watch(command.params.id, startedAt);
          let executed: unknown;
          const pauseStoppedQueue = () => { if (command.method === 'stop') for (const id of this.sends.pause('任务已停止，待发送消息已暂停。', command.params.id)) this.notifyQueue(id); };
          try { executed = command.method === 'send' ? await this.executeSend(command, frame.id, authorize, attachments) : await this.options.adapter.execute(command, frame.id, authorize, attachments); }
          catch (error) { if (error instanceof RemoteError && ['OUTCOME_UNKNOWN', 'INTERNAL'].includes(error.code)) pauseStoppedQueue(); throw error; }
          pauseStoppedQueue();
          if (command.method === 'create' && typeof (executed as { threadId?: unknown })?.threadId === 'string') this.completionMonitor.watch((executed as { threadId: string }).threadId, startedAt);
          return executed;
        }, sessionId);
       if (this.enabled && this.grants.has(sessionId)) {
          if (frame.command.method === 'seen' && (result as any)?.seen === true && 'turnId' in frame.command.params && frame.command.params.turnId) this.send({ type: 'notification.seen', taskId: frame.command.params.id, turnId: frame.command.params.turnId });
          this.send({ type: 'result', id: frame.id, sessionId, clientId: m.clientId, result });
        }
      } catch (error) { this.send({ type: 'result', id: frame.id, sessionId, clientId: m.clientId, error: publicError(error) }); }
      finally { if (image) this.mediaQueued--; else if (safety) this.safetyQueued--; else this.queued--; if (frame.command.method === 'stop') this.stopping.delete(frame.command.params.id); }
    };
    if (frame.command.method === 'queue.remove' || frame.command.method === 'command.status') void work();
    else if (image) this.mediaQueue = this.mediaQueue.then(work);
    else {
      this.commandWork.push({ priority: safety ? 0 : readMethods.has(frame.command.method) ? 2 : 1, work });
      this.commandWork.sort((a, b) => a.priority - b.priority);
      this.queue = this.queue.then(async () => { await this.commandWork.shift()?.work(); });
    }
  }
  private async executeSend(command: Extract<Command, { method: 'send' }>, commandId: string, authorize: () => void, attachments: LocalAttachment[], onDispatch?: (dispatched: boolean) => void) {
    const ids = attachments.map(a => a.id), holdId = `dispatch:${commandId}`;
    let dispatched = false, retain = false;
    try {
      const result = await this.options.adapter.execute(command, commandId, () => {
        authorize();
        // Protect files during IPC and across a crash without declaring an unaccepted send committed.
        for (const id of ids) this.store.db.prepare('INSERT OR IGNORE INTO upload_holds VALUES(?,?)').run(holdId, id);
        dispatched = true; onDispatch?.(true);
      }, attachments);
      retain = true;
      return result;
    } catch (error) {
      retain = dispatched && (!(error instanceof RemoteError) || ['OUTCOME_UNKNOWN', 'INTERNAL'].includes(error.code));
      if (!retain) onDispatch?.(false);
      throw error;
    } finally {
      if (retain) this.uploads.commit(ids);
      this.store.db.prepare('DELETE FROM upload_holds WHERE queue_id=?').run(holdId);
    }
  }
  private async flushNotifications() {
    if (this.closing || !this.credentials || !this.enabled || !this.subscription || this.socket?.readyState !== WebSocket.OPEN) return;
    for (const event of this.store.notificationOutbox()) {
      const occurredAt = this.store.notificationTime(event.eventId, this.origin); if (occurredAt === undefined) continue;
      this.store.markNotificationAttempt(event.eventId);
      this.send({ type: 'notification.event', eventId: event.eventId, deviceId: this.credentials.id, taskId: event.taskId, turnId: event.turnId, status: event.status, occurredAt, protocolVersion: 1 });
    }
  }
  private notifyQueue(id: string) {
    if (!this.enabled || this.closing) return; this.changed.add(id);
    if (!this.changeTimer) this.changeTimer = setTimeout(() => { this.changeTimer = undefined; this.send({ type: 'changed', conversationIds: [...this.changed], conversationId: [...this.changed][0] }); this.changed.clear(); }, 1000);
  }
  private updateSubscriptions() { this.options.adapter.setSubscriptions?.([...new Set([...this.sends.entries().map(r => r.conversation), ...this.subscriptions])].slice(0, 6)); }
  private queueAuthorization(sessionId: string) {
    return new Promise<{ allowed: boolean; validForMs: number; retryable?: boolean }>(resolve => {
      const id = randomUUID(); const timer = setTimeout(() => { this.queueAuthorizations.delete(id); resolve({ allowed: false, validForMs: 0, retryable: true }); }, 15000);
      this.queueAuthorizations.set(id, { resolve, timer }); this.send({ type: 'queue-authorize', id, sessionId });
    });
  }
  private pumpQueue() {
    if (this.updateFrozen || this.pumping || this.closing || !this.enabled || this.connection !== 'online' || !this.client.available || this.safetyQueued) return;
    const first = new Map<string, QueueEntry>(); for (const row of this.sends.entries()) if (!first.has(row.conversation)) first.set(row.conversation, row);
    const heads = [...first.values()];
    if (!heads.length) return; const entry = heads[this.queueCursor++ % heads.length]; this.pumping = true; this.queued++;
    this.commandWork.push({ priority: 1, work: async () => { try { await this.dispatchQueued(entry); } finally { this.pumping = false; this.queued--; } } });
    this.commandWork.sort((a, b) => a.priority - b.priority);
    this.queue = this.queue.then(async () => { await this.commandWork.shift()?.work(); });
  }
  private async dispatchQueued(entry: QueueEntry) {
    let dispatched = false; let taskRead = false; let pending = entry.state === 'pending';
    try {
      const current = this.sends.get(entry.id, entry.conversation); pending = current.state === 'pending';
      if (pending && (this.grants.get(current.session) ?? 0) <= Date.now()) throw new RemoteError('AUTH', '原手机授权已失效，请重新确认后继续。');
      const snapshot = await this.options.adapter.execute({ method: 'read', params: { id: current.conversation, limit: 20 } }, current.attempt) as Snapshot;
      taskRead = true;
      if (!pending) return;
      if (snapshot.epoch !== current.epoch) throw new RemoteError('STALE', '原客户端已重新打开，请核对后继续队列。');
      if (['failed','interrupted'].includes(snapshot.lastTurnStatus ?? '') && current.resumeAfter !== (snapshot.lastTurnId ?? '')) throw new RemoteError('QUEUE_PAUSED', '上一轮已停止或失败，请确认后继续。');
      if (snapshot.busy || snapshot.requests.some(r => r.kind === 'plan') || (snapshot.nativeQueuedCount ?? 0) > 0) return;
      if (snapshot.nativeQueuedCount === null) throw new RemoteError('QUEUE_PAUSED', '无法核对电脑端队列，请在电脑端检查后继续。');
      const value = this.sends.payload(current); const attachments = this.uploads.resolve(value.attachments.map(a => a.id), current.attachmentOwner, current.conversation);
      const requestedAt = performance.now(); const proof = await this.queueAuthorization(current.session); if (proof.retryable) throw new RemoteError('QUEUE_RETRY', '服务器连接暂时中断，队列将自动重试。'); const deadline = requestedAt + proof.validForMs;
      const authorize = () => {
        if (this.closing || !this.enabled || this.connection !== 'online' || (this.grants.get(current.session) ?? 0) <= Date.now()) throw new RemoteError('AUTH', '远控授权已失效，队列已暂停。');
        if (!proof.allowed || this.subscription?.access === false) throw new RemoteError('SUBSCRIPTION_REQUIRED', '服务器授权或订阅待确认，队列已暂停。');
        if (performance.now() >= deadline) throw new RemoteError('QUEUE_RETRY', '授权确认延迟，队列将自动重新核对。');
        if (this.stopping.has(current.conversation) || !['pending','sending'].includes(this.sends.get(current.id, current.conversation).state)) throw new RemoteError('QUEUE_PAUSED', '队列已暂停。');
      };
      authorize(); this.sends.mark(current, 'sending'); this.notifyQueue(current.conversation);
      await this.completionMonitor.watch(current.conversation);
      await this.executeSend({ method: 'send', params: { id: current.conversation, epoch: current.epoch, text: value.text, attachmentIds: value.attachments.map(a => a.id) } }, current.attempt, authorize, attachments, value => { dispatched = value; });
      this.sends.finish(current); this.notifyQueue(current.conversation); this.updateSubscriptions();
    } catch (e) {
      const row = this.sends.entries(entry.conversation).find(r => r.id === entry.id); if (!row) return;
      if (!dispatched && e instanceof RemoteError && (['BUSY', 'QUEUE_RETRY', 'CLIENT_UNAVAILABLE', 'OFFLINE'].includes(e.code) || !taskRead && ['CLIENT_REJECTED', 'OUTCOME_UNKNOWN', 'UNAVAILABLE'].includes(e.code))) { if (pending) this.sends.mark(row, 'pending', e.code === 'BUSY' ? null : e.message); this.notifyQueue(entry.conversation); this.updateSubscriptions(); return; }
      if (!taskRead && e instanceof RemoteError && e.code === 'NOT_FOUND') { for (const item of this.sends.entries(entry.conversation)) this.sends.finish(item); }
      else if (!pending) return;
      else { this.sends.mark(row, dispatched ? 'uncertain' : 'paused', dispatched ? '发送结果待核对，不会自动重发；请查看原任务后处理。' : e instanceof RemoteError ? e.message : '待发送内容暂不可用，请核对后继续。'); this.sends.pause('前一条消息需要处理，队列已暂停。', entry.conversation); }
      this.notifyQueue(entry.conversation); this.updateSubscriptions();
    }
  }
  private authorizeControl(sessionId: string, clientId: string, epoch?: string) {
    if (!this.enabled || this.closing || (this.grants.get(sessionId) ?? 0) <= Date.now()) throw new RemoteError('AUTH', '远控授权已失效。');
    if (!this.control || this.control.sessionId !== sessionId || this.control.clientId !== clientId || this.control.epoch !== epoch || (this.controlDeadline === undefined ? this.control.expires <= Date.now() : this.controlDeadline <= performance.now())) throw new RemoteError('CONTROL_LOST', '当前为查看模式，请先接管控制权。');
  }
  private uploadChunk(frame: Buffer) {
    let header: ReturnType<typeof parseUploadFrame>['header'] | undefined;
    try { const parsed = parseUploadFrame(frame); header = parsed.header; this.authorizeControl(header.sessionId, header.clientId, header.controlEpoch); if (this.subscription && !this.subscription.access) throw new RemoteError('SUBSCRIPTION_REQUIRED', '订阅未开通或已到期。'); this.send({ type: 'upload-result', id: header.id, result: this.uploads.write(header.attachmentId, header.sessionId, header.offset, parsed.bytes) }); }
    catch (e) { if (header) this.send({ type: 'upload-result', id: header.id, error: publicError(e) }); }
  }
  state() { return { helperVersion: packageInfo.version, deviceId: this.credentials?.id ?? null, code: this.code, passwordMode: this.passwordMode, codeExpires: this.codeExpires, enabled: this.enabled, connection: this.connection, connectionError: this.connectionError, client: this.client, authorizedCount: this.grants.size, url: this.origin, subscription: this.subscription, update: this.updater?.state, feedbackUnread: this.feedbackUnread }; }
  async refreshFeedbackUnread(force = false) {
    if (this.closing || this.feedbackReading || !this.credentials || this.subscription?.disabled || !force && Date.now() - this.feedbackCheckedAt < 30000) return;
    this.feedbackReading = true; this.feedbackCheckedAt = Date.now();
    try { const result = z.object({ count: z.number().int().nonnegative() }).parse(await (await this.serviceRequest('/api/feedback/device/unread')).json()); if (!this.closing) this.feedbackUnread = result.count; }
    catch {} finally { this.feedbackReading = false; }
  }
  async serviceRequest(path: string, init: RequestInit = {}) {
    if (!this.credentials) throw new RemoteError('OFFLINE', '设备尚未连接服务器。');
    const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${this.credentials.secret}`); headers.set('X-Device-Id', this.credentials.id);
    const timeout = AbortSignal.timeout(path.startsWith('/api/updates/download/') ? 30 * 60000 : 15000);
    const response = await fetch(this.origin + path, { ...init, headers, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout, redirect: 'error' });
    if (!response.ok) { const body = await response.json().catch(() => ({})) as any; throw new RemoteError(body.error?.code ?? 'UNAVAILABLE', body.error?.message ?? '服务器暂不可用。'); } return response;
  }
  private async readComputerFingerprint() {
    if (this.computerFingerprint) return this.computerFingerprint;
    if (process.platform !== 'win32' || !this.options.nativeExe) return undefined;
    try {
      const result = await promisify(execFile)(this.options.nativeExe, ['--computer-id'], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
      return this.computerFingerprint = z.string().regex(/^[a-f0-9]{64}$/).parse(result.stdout.trim());
    } catch { return undefined; }
  }
  private async announceComputer() {
    if (this.computerIdentitySent) return;
    const fingerprint = await this.readComputerFingerprint();
    if (!fingerprint || this.socket?.readyState !== WebSocket.OPEN) return;
    this.send({ type: 'computer', fingerprint });
    this.computerIdentitySent = true;
  }
  private async registerComputer() {
    const fingerprint = await this.readComputerFingerprint();
    if (!fingerprint) return;
    try { await this.serviceRequest('/api/subscription/device/computer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fingerprint }) }); } catch {}
  }
  async trial(value: unknown) { await this.registerComputer(); const input = z.object({ termsVersion: z.string(), requestId: uid }).strict().parse(value); const result = await (await this.serviceRequest('/api/subscription/device/trial', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).json() as any; this.subscription = subscriptionSchema.parse(result.subscription); return result; }
  diagnostics() { return { source: 'desktop', helperVersion: packageInfo.version, ...(this.client.version && /^[\d.]+$/.test(this.client.version) ? { clientVersion: this.client.version } : {}), system: 'Windows', connection: this.connection, ...(this.connectionError?.code ? { errorCode: this.connectionError.code } : {}) }; }
  async update(action: string, value?: unknown) {
    if (action === 'state') return this.updater?.state ?? { phase: 'error', progress: 0, autoDownload: false, message: '请安装包含在线更新器的新版本 Windows 助手。', notes: '' };
    if (!this.updater) throw new RemoteError('UNSUPPORTED', '请安装完整的新版 Windows 助手以使用在线更新。');
    if (action === 'check') void this.updater.check();
    else if (action === 'download') void this.updater.download();
    else if (action === 'cancel') this.updater.cancel();
    else if (action === 'settings') this.updater.setting(z.object({ autoDownload: z.boolean() }).strict().parse(value).autoDownload);
    else if (action === 'install') return this.updater.install();
    return this.updater.state;
  }
  private async updateBlockers() {
    const reasons: string[] = [];
    this.uploads.cleanup();
    if (this.queued || this.safetyQueued || this.mediaQueued || this.pumping) reasons.push('有正在处理的远程操作');
    if (this.sends.entries().length) reasons.push('有尚未发送的队列消息');
    if (this.store.db.prepare('SELECT 1 FROM uploads WHERE committed=0 AND ready=0').get()) reasons.push('有尚未完成的附件上传');
    if (this.options.adapter.updateBlockers) reasons.push(...await this.options.adapter.updateBlockers());
    return reasons;
  }
  async subscriptionInfo(input?: z.infer<typeof redeemSchema>) {
    if (!this.credentials) throw new RemoteError('OFFLINE', '设备尚未连接服务器。');
    // Register before reading trial eligibility so the first desktop visit can claim the trial.
    await this.registerComputer();
    const response = await fetch(`${this.origin}${input ? '/api/subscription/device/redeem' : '/api/subscription/device'}`, {
      method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${this.credentials.secret}`, 'X-Device-Id': this.credentials.id, ...(input ? { 'Content-Type': 'application/json' } : {}) },
      ...(input ? { body: JSON.stringify(redeemSchema.parse(input)) } : {}), signal: AbortSignal.timeout(15000), redirect: 'error'
    });
    const result = await response.json() as any;
    if (!response.ok) throw new RemoteError(result.error?.code ?? 'UNAVAILABLE', result.error?.message ?? '订阅服务暂不可用。');
    this.subscription = subscriptionSchema.parse(result.subscription); return result;
  }
  async orders(action: 'list' | 'create' | 'open' | 'close' | 'refund', input?: unknown, orderId?: string) {
    if (!this.credentials) throw new RemoteError('OFFLINE', '设备尚未连接服务器。');
    const path = `/api/subscription/device/orders${action === 'open' || action === 'close' || action === 'refund' ? `/${uid.parse(orderId)}/${action}` : action === 'list' ? `?page=${z.number().int().min(1).max(10000).parse(input ?? 1)}` : ''}`;
    const response = await fetch(`${this.origin}${path}`, { method: action === 'list' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${this.credentials.secret}`, 'X-Device-Id': this.credentials.id, ...(action === 'list' ? {} : { 'Content-Type': 'application/json' }) }, ...(action === 'list' ? {} : { body: JSON.stringify(action === 'create' ? checkoutSchema.parse(input) : action === 'refund' ? refundRequestSchema.parse(input) : {}) }), signal: AbortSignal.timeout(15000), redirect: 'error' });
    const result = await response.json() as any; if (!response.ok) throw new RemoteError(result.error?.code ?? 'UNAVAILABLE', result.error?.message ?? '订单服务暂不可用。'); return result;
  }
  private refreshCode() {
    const previous = this.code;
    do { this.code = verificationCode(); } while (this.code === previous);
    this.codeExpires = Date.now() + 12 * 3600000;
  }
  private revoke() {
    this.control = undefined;
    this.store.clearGrants(this.origin);
    for (const id of this.sends.pause('远控授权已撤销，请重新确认后继续。')) this.notifyQueue(id);
    this.grants.clear(); this.pairLimit = new RateLimit(5, 15 * 60000); this.send({ type: 'invalidate' });
  }
  rotate() { if (this.passwordMode === 'automatic') this.refreshCode(); this.revoke(); }
  setPassword(value: PasswordSettings) {
    const settings = passwordSettingsSchema.parse(value);
    this.store.savePasswordSettings(this.origin, settings);
    this.passwordMode = settings.mode;
    if (settings.mode === 'custom') { this.code = settings.password; this.codeExpires = null; } else this.refreshCode();
    this.revoke();
  }
  setEnabled(enabled: boolean) {
    if (!enabled) this.store.clearGrants(this.origin);
    this.enabled = enabled; this.store.set(`enabled:${hash(this.origin)}`, String(enabled));
    if (!enabled) { this.rotate(); this.options.adapter.close(); }
    void this.refresh();
  }
  async close() {
    this.updater?.close();
    this.closing = true; this.enabled = false; clearTimeout(this.reconnect); clearTimeout(this.changeTimer); clearInterval(this.timer); clearInterval(this.queueTimer); clearInterval(this.notificationTimer); this.completionMonitor.close();
    for (const pending of this.queueAuthorizations.values()) { clearTimeout(pending.timer); pending.resolve({ allowed: false, validForMs: 0, retryable: true }); } this.queueAuthorizations.clear();
    this.socket?.close(1000); this.options.adapter.close(); await this.queue; await this.mediaQueue; this.store.close();
  }
}

export async function createLocalServer(agent: Agent, options: { port: number; webDir?: string }) {
  const app = Fastify({ logger: false, bodyLimit: 4096 }); const origin = `http://127.0.0.1:${options.port}`;
  await app.register(cookie);
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return reply.code(403).send({ error: { message: '请求来源无效。' } });
    if (req.url.startsWith('/local/')) {
      const secret = req.headers.authorization?.replace(/^Bearer /, '') ?? req.cookies.local_session ?? '';
      if (!equalSecret(secret, agent.localToken)) return reply.code(401).send({ error: { message: '请从电脑助手打开此页面。' } });
      if (req.method !== 'GET' && !req.headers.authorization && req.headers.origin !== origin) return reply.code(403).send({ error: { message: '请求来源无效。' } });
    }
  });
  app.get('/api/bootstrap', async () => ({ mode: 'desktop' }));
  app.post('/local/session', async (_req, reply) => { reply.setCookie('local_session', agent.localToken, { httpOnly: true, sameSite: 'strict', path: '/' }); return { ok: true }; });
  app.get('/local/state', async () => { void agent.refreshFeedbackUnread(); return agent.state(); });
  app.get('/local/subscription', async () => agent.subscriptionInfo());
  app.post('/local/license', async req => agent.subscriptionInfo(redeemSchema.parse(req.body)));
  app.post('/local/trial', async req => agent.trial(req.body));
  app.get('/local/diagnostics', async () => agent.diagnostics());
  app.get('/local/update/state', async () => agent.update('state'));
  app.post('/local/update/:action', async req => agent.update(z.object({ action: z.enum(['check', 'download', 'cancel', 'install', 'settings']) }).parse(req.params).action, req.body));
  for (const path of ['/local/feedback', '/local/feedback/*']) app.route({ url: path, method: ['GET', 'POST'], bodyLimit: 22 * 1024 * 1024, handler: async (req, reply) => {
    const requestUrl = new URL(req.url, origin); const pathname = requestUrl.pathname; const prefix = '/local/feedback';
    const suffix = pathname.slice(prefix.length); const validSuffix = suffix === '' || /^\/(?:unread|uploads(?:\/[a-f0-9-]{36}(?:\/chunks)?)?|images\/[a-f0-9-]{36}|[a-f0-9-]{36}(?:\/(?:messages|read|state))?)$/.test(suffix);
    if (!validSuffix || !pathname.startsWith(prefix)) throw new RemoteError('INVALID', '反馈地址无效。');
    const upstreamSuffix = suffix + requestUrl.search;
    const response = await agent.serviceRequest('/api/feedback/device' + upstreamSuffix, { method: req.method, ...(req.method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) } : {}) });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (suffix.endsWith('/read') || req.method === 'POST') void agent.refreshFeedbackUnread(true);
    return reply.type(response.headers.get('content-type')?.startsWith('image/') ? 'image/jpeg' : 'application/json; charset=utf-8').send(bytes);
  } });
  app.get('/local/orders', async req => agent.orders('list', z.object({ page: z.coerce.number().int().min(1).max(10000).default(1) }).parse(req.query).page));
  app.post('/local/orders', async req => agent.orders('create', checkoutSchema.parse(req.body)));
  app.post('/local/orders/:id/open', async req => agent.orders('open', undefined, z.object({ id: uid }).parse(req.params).id));
  app.post('/local/orders/:id/close', async req => agent.orders('close', undefined, z.object({ id: uid }).parse(req.params).id));
  app.post('/local/orders/:id/refund', async req => agent.orders('refund', refundRequestSchema.parse(req.body), z.object({ id: uid }).parse(req.params).id));
  app.post('/local/enabled', async req => { const p = z.object({ enabled: z.boolean() }).strict().parse(req.body); agent.setEnabled(p.enabled); return agent.state(); });
  app.post('/local/rotate', async () => { agent.rotate(); return agent.state(); });
  app.post('/local/password', async req => { agent.setPassword(passwordSettingsSchema.parse(req.body)); return agent.state(); });
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: { code: 'LOCAL_ROUTE_NOT_FOUND', message: '当前 Windows 助手不支持此功能，请更新到最新版本。' } });
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof RemoteError) return reply.code(400).send({ error: publicError(err) });
    const status = Number.isInteger((err as any).statusCode) ? Math.max(400, Math.min(599, Number((err as any).statusCode))) : 500;
    if (err instanceof z.ZodError) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: '请求参数无效，请刷新后重试。' } });
    if ((err as any).validation) return reply.code(status).send({ error: { code: 'INVALID_REQUEST', message: '请求参数无效，请刷新后重试。' } });
    reply.code(status).send({ error: { code: 'LOCAL_SERVICE_ERROR', message: '电脑助手本地服务异常，请重启助手后重试。' } });
  });
  if (options.webDir) await serveWeb(app, options.webDir);
  return app;
}
