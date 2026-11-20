import { RemoteError } from '../shared/protocol.js';

type Call = (name: string, args: Record<string, unknown>, contextId: string, authorize?: () => void) => Promise<any>;
type Page = { turns: Map<string, any>; state: any; cursor?: string; more: boolean; checked: number };

// New desktop builds expose task tools instead of the removed follower pipe.
// Reading and sending use the desktop's own running executor, never a second CLI.
export class ToolSession {
  private pages = new Map<string, Page>();
  private pending = new Map<string, Promise<any>>();
  private generation = 0;
  private lifetimes = new Map<string, object>();
  constructor(private call: Call) {}
  async read(id: string, older = false): Promise<any> {
    const pending = this.pending.get(id);
    if (pending) { await pending; return this.read(id, older); }
    const previous = this.pages.get(id);
    if (older && previous && !previous.more) return previous.state;
    if (!older && previous && performance.now() - previous.checked < 750) return previous.state;
    const cursor = older ? previous?.cursor : undefined;
    const generation = this.generation;
    const lifetime = this.lifetimes.get(id) ?? {};
    this.lifetimes.set(id, lifetime);
    const request = (async () => {
      const result = await this.call('read_thread', { threadId: id, hostId: 'local', turnLimit: 1, includeOutputs: true, maxOutputCharsPerItem: 20000, ...(cursor ? { cursor } : {}) }, id);
      if (result?.thread?.id !== id || result.thread.kind !== 'codex' || result.thread.hostId !== 'local' || !Array.isArray(result.turns)
        || !['active', 'idle', 'notLoaded', 'systemError'].includes(result.thread.status?.type)
        || !result.page || typeof result.page.hasMore !== 'boolean' || result.page.hasMore && (typeof result.page.nextCursor !== 'string' || !result.page.nextCursor || result.page.nextCursor === cursor)
        || result.turns.some((turn: any) => typeof turn?.id !== 'string' || !Array.isArray(turn.items) || typeof turn.status !== 'string'
          || turn.items.some((item: any) => typeof item?.id !== 'string' || typeof item.type !== 'string'))) throw new RemoteError('UNSUPPORTED', '当前会话返回的数据不完整，请稍后重新同步。');
      const turns = new Map(previous?.turns);
      for (const turn of result.turns) turns.set(turn.id, { ...turn, turnId: turn.id, turnStartedAtMs: turn.startedAt ?? 0, items: turn.items.map((item: any) => item?.type === 'agentMessage' && item.phase === 'final_answer' ? { ...item, phase: 'final' } : item) });
      const state = { id, title: result.thread.title, cwd: result.thread.cwd, threadRuntimeStatus: result.thread.status, turns: [...turns.values()].sort((a, b) => a.turnStartedAtMs - b.turnStartedAtMs), requests: [] };
      if (generation !== this.generation || this.lifetimes.get(id) !== lifetime) throw new RemoteError('CLIENT_UNAVAILABLE', '任务连接正在恢复，请稍后重新同步。');
      // Refresh the live turn without discarding already loaded history pages.
      this.pages.set(id, { turns, state, checked: performance.now(), cursor: older || !previous ? result.page.nextCursor ?? undefined : previous.cursor, more: older || !previous ? result.page.hasMore : previous.more });
      return state;
    })();
    this.pending.set(id, request);
    try { return await request; } finally { if (this.pending.get(id) === request) this.pending.delete(id); }
  }
  hasMore(id: string) { return this.pages.get(id)?.more === true; }
  refresh(id: string) { this.lifetimes.delete(id); const page = this.pages.get(id); if (page) page.checked = -Infinity; }
  forget(id: string) { this.lifetimes.delete(id); this.pages.delete(id); }
  clear() { this.generation++; this.pages.clear(); this.lifetimes.clear(); }
}

export function toolSessionCapabilities(tools: any[]) {
  const has = (name: string, required: string[] = []) => tools.some(tool => tool?.namespace === 'codex_app' && tool.name === name && tool.inputSchema?.type === 'object'
    && required.every(key => tool.inputSchema.properties?.[key]?.type === 'string'));
  if (!has('read_thread', ['threadId']) || !has('list_projects') || !has('list_threads')) throw new RemoteError('UNSUPPORTED', 'Codex 任务工具尚未启动完成，请稍后重试。');
  const capabilities = ['compatibility-checked', 'project-navigation', 'task-list-cursor', 'task-list-lookup', 'turn-details', 'activity', 'live-activity', 'multi-terminal', 'message-images', 'conditional-read', 'history-pages', 'safety-status'];
  if (has('send_message_to_thread', ['threadId', 'prompt'])) capabilities.push('send-messages', 'attachments');
  if (has('create_thread', ['prompt'])) capabilities.push('create-tasks');
  return { capabilities, reason: '新版 Codex 已切换任务接口，会话和消息可使用；调整方向、停止、模型、权限、目标与审批操作暂需在电脑端处理。' };
}
