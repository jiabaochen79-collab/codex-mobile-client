import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, statSync, appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { RemoteError, recoveryStateSchema, type DesktopProcess, type RecoveryState } from '../shared/protocol.js';
import type { AgentStore } from './store.js';

const exitSchema = recoveryStateSchema.shape.lastExit.unwrap().extend({ module: z.string().max(100).nullable().optional(), exception: z.string().regex(/^(0x)?[a-fA-F0-9]{8}$/).nullable().optional() });
export type DesktopExit = z.infer<typeof exitSchema>;
export interface RecoveryBackend {
  watch(identity: DesktopProcess, exit: (value: DesktopExit) => void, error: () => void): () => void;
  launch(authorize: () => void): Promise<{ launched?: boolean; alreadyRunning?: boolean }>;
}
export class NativeRecoveryBackend implements RecoveryBackend {
  constructor(private nativeExe: string) {}
  watch(identity: DesktopProcess, exit: (value: DesktopExit) => void, error: () => void) {
    const child = spawn(this.nativeExe, ['--desktop-watch', String(identity.processId), identity.startedAt], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', stopped = false, finished = false;
    const finish = (code: number | null) => {
      if (finished || stopped) return; finished = true;
      try { const value = exitSchema.parse(JSON.parse(output)); if (code !== 0) throw new Error(); exit(value); } catch { error(); }
    };
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 4096) { child.kill(); finish(1); } });
    child.stdin.on('error', () => finish(1)); child.once('error', () => finish(1)); child.once('close', finish);
    return () => { stopped = true; child.stdin.end(); };
  }
  async launch(authorize: () => void) {
    authorize();
    return new Promise<{ launched?: boolean; alreadyRunning?: boolean }>((resolve, reject) => {
      const child = spawn(this.nativeExe, ['--desktop-launch'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      let output = '', accepted = false, finished = false;
      const finish = (error?: unknown) => { if (finished) return; finished = true; clearTimeout(timer); child.stdin.end(); if (error) { child.kill(); reject(error); } else try { resolve(z.object({ launched: z.literal(true).optional(), alreadyRunning: z.literal(true).optional() }).strict().refine(value => value.launched || value.alreadyRunning).parse(JSON.parse(output))); } catch (e) { reject(e); } };
      const timer = setTimeout(() => finish(new Error('Desktop launch timeout')), 12000);
      child.stdin.on('error', finish);
      child.stdout.on('data', bytes => {
        output += bytes;
        if (output.length > 4096) { finish(new Error('Invalid launch response')); return; }
        if (!accepted && output.includes('\n')) {
          const end = output.indexOf('\n');
          try { z.object({ ready: z.literal(true) }).strict().parse(JSON.parse(output.slice(0, end))); authorize(); accepted = true; output = output.slice(end + 1); child.stdin.write('activate\n'); }
          catch (e) { finish(e); }
        }
      });
      child.once('error', finish); child.once('close', code => finish(code === 0 && accepted ? undefined : new Error('Desktop launch failed')));
    });
  }
}

const RETRIES = [3000, 15000, 45000];
export class DesktopRecovery {
  readonly state: RecoveryState;
  private identity?: DesktopProcess;
  private exited?: DesktopProcess;
  private unwatch?: () => void;
  private watchFailed = false;
  private allowed = false;
  private closed = false;
  private generation = 0;
  private due?: number;
  private launchDeadline?: number;
  private automaticAttempt = false;
  private healthySince?: number;
  private manualAt = -Infinity;
  private running?: Promise<void>;
  private crashPending = false;
  constructor(private options: { store: Pick<AgentStore, 'get' | 'set'>; key: string; backend: RecoveryBackend; dir: string; interrupted: () => void; now?: () => number }) {
    this.state = { autoEnabled: options.store.get(options.key + ':auto') !== 'false', phase: 'idle', attempts: 0, reason: '等待检测电脑客户端' };
    try { const previous = JSON.parse(options.store.get(options.key + ':attempts') ?? 'null'); if (previous && Number.isInteger(previous.count) && previous.count >= 0 && previous.count <= 3) this.state.attempts = previous.count; } catch {}
    try { const previousExit = recoveryStateSchema.shape.lastExit.safeParse(JSON.parse(options.store.get(options.key + ':exit') ?? 'null')); if (previousExit.success && previousExit.data) this.state.lastExit = previousExit.data; } catch {}
    if (!this.state.autoEnabled) { this.state.phase = 'paused'; this.state.reason = '自动恢复已暂停'; }
  }
  get blocksCommands() { return !!this.running || this.crashPending || this.launchDeadline !== undefined || !!this.identity && this.identity === this.exited; }
  private now() { return this.options.now?.() ?? performance.now(); }
  private record(kind: string, detail: Record<string, unknown> = {}) {
    try {
      const dir = join(this.options.dir, 'logs'), file = join(dir, 'desktop-recovery.jsonl'); mkdirSync(dir, { recursive: true });
      if (existsSync(file) && statSync(file).size > 1024 * 1024) { if (existsSync(file + '.1')) unlinkSync(file + '.1'); renameSync(file, file + '.1'); }
      appendFileSync(file, JSON.stringify({ at: Date.now(), kind, attempts: this.state.attempts, ...detail }) + '\n', { mode: 0o600 });
    } catch {}
  }
  private saveAttempts() { this.options.store.set(this.options.key + ':attempts', JSON.stringify({ count: this.state.attempts, at: Date.now() })); }
  setAllowed(value: boolean) {
    value = value && !this.closed; if (value === this.allowed) return;
    this.allowed = value;
    if (!this.allowed) {
      this.generation++; this.due = undefined; this.crashPending = false; this.launchDeadline = undefined; delete this.state.nextRetryAt;
      if (['backoff', 'launching', 'connecting'].includes(this.state.phase)) { this.state.phase = 'paused'; this.state.reason = '恢复已暂停，远控已关闭、设备停用或助手正在更新'; }
    }
  }
  observe(identity: DesktopProcess | null | undefined, ready: boolean) {
    if (this.closed) return;
    if (identity && identity.processId === this.exited?.processId && identity.startedAt === this.exited?.startedAt) { identity = null; ready = false; }
    const changed = identity && (identity.processId !== this.identity?.processId || identity.startedAt !== this.identity?.startedAt);
    if (identity && changed) { this.unwatch?.(); this.unwatch = undefined; this.identity = identity; this.healthySince = undefined; this.watchFailed = true; }
    if (identity && this.watchFailed) {
      this.watchFailed = false; const current = this.identity!;
      this.unwatch = this.options.backend.watch(current, value => {
        if (this.closed || this.identity !== current) return;
        this.exited = current;
        this.unwatch = undefined;
        this.healthySince = undefined;
        const { module, exception, ...summary } = value; this.state.lastExit = summary; this.options.store.set(this.options.key + ':exit', JSON.stringify(summary)); this.record('desktop-exit', { ...summary, module, exception });
        if (value.cause === 'crash') { this.options.interrupted(); if (this.allowed && this.state.autoEnabled) { this.crashPending = true; this.schedule(); } else { this.state.phase = 'paused'; this.state.reason = '电脑客户端异常退出，自动恢复未启用'; } }
        else { this.generation++; this.launchDeadline = undefined; this.crashPending = false; this.due = undefined; delete this.state.nextRetryAt; this.state.phase = value.cause === 'session-ending' ? 'paused' : 'idle'; this.state.reason = value.cause === 'session-ending' ? 'Windows 会话正在结束' : '电脑客户端已正常退出，可手动恢复'; }
      }, () => { if (this.closed || this.identity !== current) return; this.unwatch = undefined; this.watchFailed = true; this.record('watch-unavailable'); });
    }
    if (identity && ready && !this.running) { if (this.crashPending) { this.state.recoveredAt = Date.now(); this.record('desktop-recovered', { version: identity.version }); } this.crashPending = false; this.due = undefined; delete this.state.nextRetryAt; if (this.state.phase === 'backoff' || this.state.phase === 'failed') this.state.phase = 'watching'; }
    if (this.crashPending || this.state.phase === 'backoff' || this.running) return;
    if (identity && ready) {
      if (this.launchDeadline !== undefined) { this.state.recoveredAt = Date.now(); this.record('desktop-recovered', { version: identity.version }); this.launchDeadline = undefined; }
      this.healthySince ??= this.now();
      if (this.state.attempts && this.now() - this.healthySince >= 300000) { this.state.attempts = 0; this.saveAttempts(); }
      this.state.phase = this.state.autoEnabled ? this.state.recoveredAt ? 'recovered' : 'watching' : 'paused'; this.state.reason = this.state.autoEnabled ? this.state.recoveredAt ? '客户端连接已恢复；中断任务和暂停队列需确认后继续' : '异常退出时将自动恢复' : '自动恢复已暂停';
    } else if (this.launchDeadline !== undefined) {
      if (this.now() >= this.launchDeadline) { this.launchDeadline = undefined; if (this.automaticAttempt) { this.crashPending = true; this.schedule(); } else { this.state.phase = 'failed'; this.state.reason = '客户端未通过连接及兼容检查，请核对电脑状态后重试'; } }
      else { this.state.phase = 'connecting'; this.state.reason = '正在等待电脑客户端启动及兼容检查'; }
    } else if (this.state.phase !== 'failed') {
      this.healthySince = undefined; this.state.phase = this.state.autoEnabled ? 'idle' : 'paused'; this.state.reason = identity ? '电脑客户端正在运行，正在重新连接；不会强制重启' : this.state.autoEnabled ? '电脑客户端未运行，可手动恢复' : '自动恢复已暂停';
    }
  }
  private schedule() {
    if (!this.allowed || !this.state.autoEnabled || this.state.attempts >= 3) { this.crashPending = false; this.state.phase = this.allowed && this.state.autoEnabled ? 'failed' : 'paused'; this.state.reason = this.state.phase === 'failed' ? '连续恢复失败，已停止自动尝试；请核对后手动恢复' : '自动恢复已暂停'; this.due = undefined; delete this.state.nextRetryAt; return; }
    const delay = RETRIES[this.state.attempts]; this.due = this.now() + delay;
    this.state.nextRetryAt = Date.now() + delay; this.state.phase = 'backoff'; this.state.reason = `电脑客户端异常退出，将进行第 ${this.state.attempts + 1}/3 次恢复`;
  }
  tick() { if (!this.closed && this.allowed && this.due !== undefined && this.now() >= this.due && !this.running) this.startLaunch(() => { if (!this.allowed || !this.state.autoEnabled) throw new RemoteError('RECOVERY_PAUSED', '自动恢复已暂停'); }, true); }
  private startLaunch(authorize: () => void, automatic = false) {
    this.automaticAttempt = automatic;
    this.due = undefined; delete this.state.nextRetryAt; this.crashPending = false; this.state.attempts++; this.saveAttempts(); this.healthySince = undefined;
    this.state.phase = 'launching'; this.state.reason = '正在恢复电脑客户端'; const generation = this.generation;
    this.running = Promise.resolve().then(async () => {
      try {
        const check = () => { if (this.closed || generation !== this.generation) throw new RemoteError('RECOVERY_PAUSED', '恢复已暂停'); authorize(); };
        check(); const result = await this.options.backend.launch(check);
        if (this.closed || generation !== this.generation) return;
        this.launchDeadline = this.now() + 60000; this.state.phase = 'connecting'; this.state.reason = result.alreadyRunning ? '电脑客户端已在运行，正在重新连接' : '客户端已打开，正在等待连接'; this.record('launch-accepted', { alreadyRunning: result.alreadyRunning === true });
      } catch {
        if (this.closed || generation !== this.generation) return;
        this.record('launch-failed'); if (automatic) { this.crashPending = true; this.schedule(); } else { this.state.phase = 'failed'; this.state.reason = '恢复未完成或授权已变化，请核对后手动重试'; }
      }
    }).finally(() => { this.running = undefined; });
  }
  request(action: 'launch' | 'pause' | 'enable', authorize: () => void) {
    if (this.closed) throw new RemoteError('UNAVAILABLE', '助手已关闭'); authorize();
    if (action !== 'launch') {
      this.state.autoEnabled = action === 'enable'; this.options.store.set(this.options.key + ':auto', String(this.state.autoEnabled));
      if (action === 'pause') { this.generation++; this.due = undefined; this.crashPending = false; this.launchDeadline = undefined; delete this.state.nextRetryAt; this.state.phase = 'paused'; this.state.reason = '自动恢复已暂停'; }
      else if (this.state.phase === 'paused') { this.state.phase = 'idle'; this.state.reason = '自动恢复已开启'; }
      this.record(action); return { ...this.state };
    }
    if (this.running || this.launchDeadline !== undefined) return { ...this.state };
    if (this.now() - this.manualAt < 30000) throw new RemoteError('RATE_LIMIT', '请等待 30 秒后再尝试恢复');
    this.manualAt = this.now(); this.state.attempts = 0; this.startLaunch(authorize); return { ...this.state };
  }
  async close() { this.closed = true; this.setAllowed(false); this.unwatch?.(); this.unwatch = undefined; await this.running; }
}
