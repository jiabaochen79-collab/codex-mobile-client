import { RemoteError } from '../shared/protocol.js';

export type NativeRequest = (method: string, params: any) => Promise<any>;
type Page = { turns: Map<string, any>; state: any; cursor?: string; more: boolean; checked: number };

// This adapter talks to the desktop's existing executor. Resuming only loads
// settings/history; it never starts a turn or replays a user operation.
export class NativeSession {
  private pages = new Map<string, Page>();
  private pending = new Map<string, Promise<any>>();
  private versions = new Map<string, number>();
  private settings = new Map<string, any>();
  private lifetimes = new Map<string, object>();
  private generation = 0;
  constructor(readonly request: NativeRequest) {}
  async read(id: string, older = false): Promise<any> {
    const pending = this.pending.get(id); if (pending) { await pending; return this.read(id, older); }
    const previous = this.pages.get(id);
    if (older && previous && !previous.more || !older && previous && performance.now() - previous.checked < 500) return previous!.state;
    const generation = this.generation, version = this.versions.get(id) ?? 0, lifetime = this.lifetimes.get(id) ?? {};
    this.lifetimes.set(id, lifetime);
    const cursor = older ? previous?.cursor : undefined;
    const reading = (async () => {
      let settings = this.settings.get(id);
      let thread: any;
      if (!settings) {
        const resumed = await this.request('thread/resume', { threadId: id, excludeTurns: true });
        thread = resumed.thread;
        settings = { ...resumed, effort: resumed.reasoningEffort, sandboxPolicy: resumed.sandbox };
        delete settings.thread;
        if (!this.settings.has(id)) this.settings.set(id, settings);
      }
      const [page, goal, requests] = await Promise.all([
        this.request('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'summary', ...(cursor ? { cursor } : {}) }),
        this.request('thread/goal/get', { threadId: id }), this.request('bridge/pending', { threadId: id })
      ]);
      if (!Array.isArray(page.data) || page.nextCursor && (typeof page.nextCursor !== 'string' || page.nextCursor === cursor) || !Array.isArray(requests)) throw new RemoteError('UNSUPPORTED', 'Codex 历史分页返回不完整。');
      const turns = new Map(previous?.turns);
      for (const turn of page.data) {
        if (typeof turn?.id !== 'string' || typeof turn.status !== 'string') throw new RemoteError('UNSUPPORTED', 'Codex 轮次返回不完整。');
        const items: any[] = []; let itemCursor: string | undefined;
        const cursors = new Set<string>();
        do {
          const result = await this.request('thread/items/list', { threadId: id, turnId: turn.id, limit: 100, sortDirection: 'asc', deferOutput: { commandExecution: true, mcpToolCall: true }, ...(itemCursor ? { cursor: itemCursor } : {}) });
          if (!Array.isArray(result.data)) throw new RemoteError('UNSUPPORTED', 'Codex 消息列表尚未完整返回。');
          for (const entry of result.data) {
            const item = entry.item;
            if (entry.turnId !== turn.id || typeof item?.id !== 'string' || typeof item.type !== 'string') throw new RemoteError('UNSUPPORTED', 'Codex 消息归属未通过检查。');
            items.push(item.type === 'agentMessage' && item.phase === 'final_answer' ? { ...item, phase: 'final' } : item);
          }
          itemCursor = result.nextCursor ?? undefined;
          if (itemCursor && (typeof itemCursor !== 'string' || cursors.has(itemCursor))) throw new RemoteError('UNSUPPORTED', 'Codex 消息分页位置无效。');
          if (itemCursor) cursors.add(itemCursor);
        } while (itemCursor);
        turns.set(turn.id, { ...turn, turnId: turn.id, turnStartedAtMs: (turn.startedAt ?? 0) * 1000, items });
      }
      const live = await this.request('bridge/live', { threadId: id });
      if (live) {
        if (typeof live.id !== 'string' || !Array.isArray(live.items) || typeof live.status !== 'string') throw new RemoteError('UNSUPPORTED', 'Codex 实时轮次尚未同步。');
        const saved = turns.get(live.id);
        const finished = saved && (['completed', 'failed'].includes(saved.status) || saved.status === 'interrupted' && saved.completedAt != null);
        // A recorded terminal outcome must never be replaced by a cached start.
        // Interrupted history without completedAt can still describe a live turn.
        if (!finished || !['inProgress', 'interrupted'].includes(live.status)) {
          const items = new Map((saved?.items ?? []).map((item: any) => [item.id, item]));
          for (const item of live.items) items.set(item.id, item);
          turns.set(live.id, { ...saved, ...live, turnId: live.id, items: [...items.values()] });
        }
      }
      // Read runtime status after history: turn/start can be acknowledged before
      // the executor changes its status from idle to active.
      thread = (await this.request('thread/read', { threadId: id, includeTurns: false })).thread;
      if (thread?.id !== id || !['active', 'idle', 'notLoaded', 'systemError'].includes(thread.status?.type)) throw new RemoteError('UNSUPPORTED', 'Codex 会话状态尚未完整返回。');
      settings = this.settings.get(id) ?? settings;
      const ordered = [...turns.values()].sort((a, b) => a.turnStartedAtMs - b.turnStartedAtMs);
      const latest = ordered.at(-1), plan = latest?.items.findLast((item: any) => item.type === 'plan' && typeof item.text === 'string' && item.text.trim());
      if (latest?.status === 'completed' && plan && settings.collaborationMode?.mode === 'plan' && !requests.length) {
        // The desktop derives its plan confirmation from this same completed plan.
        latest.items = latest.items.filter((item: any) => item.type !== 'planImplementation').concat({ type: 'planImplementation', isCompleted: false });
        requests.push({ id: `implement-plan:${latest.turnId}`, method: 'item/plan/requestImplementation', params: { threadId: id, turnId: latest.turnId, planContent: plan.text } });
      }
      const state = { id, nativeProtocol: true, title: thread.name ?? thread.preview ?? '未命名会话', cwd: thread.cwd, threadRuntimeStatus: thread.status, latestThreadSettings: settings, turns: ordered, requests, threadGoal: goal.goal ?? null };
      if (generation !== this.generation || this.lifetimes.get(id) !== lifetime) throw new RemoteError('CLIENT_UNAVAILABLE', 'Codex 连接已经变化，请重新同步。');
      this.pages.set(id, { turns, state, checked: version === (this.versions.get(id) ?? 0) ? performance.now() : -Infinity, cursor: older || !previous ? page.nextCursor ?? undefined : previous.cursor, more: older || !previous ? !!page.nextCursor : previous.more });
      return state;
    })();
    this.pending.set(id, reading);
    try { return await reading; } finally { if (this.pending.get(id) === reading) this.pending.delete(id); }
  }
  notification(message: any) {
    const params = message.params;
    const id = params?.threadId ?? params?.thread?.id;
    if (typeof id !== 'string') return;
    const page = this.pages.get(id);
    if (message.method === 'thread/settings/updated' && params.threadSettings) { this.settings.set(id, params.threadSettings); if (page) page.state.latestThreadSettings = params.threadSettings; }
    if (page && message.method === 'thread/status/changed' && params.status) page.state.threadRuntimeStatus = params.status;
    this.refresh(id);
    return id;
  }
  hasMore(id: string) { return this.pages.get(id)?.more === true; }
  refresh(id: string) { this.versions.set(id, (this.versions.get(id) ?? 0) + 1); const page = this.pages.get(id); if (page) page.checked = -Infinity; }
  forget(id: string) { this.refresh(id); this.lifetimes.delete(id); this.settings.delete(id); this.pages.delete(id); }
  clear() { this.generation++; this.pages.clear(); this.versions.clear(); this.lifetimes.clear(); this.settings.clear(); }
}
