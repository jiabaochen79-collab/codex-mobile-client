import { describe, expect, it } from 'vitest';
import { CodexDesktop, normalizeSnapshot } from '../src/agent/desktop.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
describe('desktop snapshot projection', () => {
  it('blocks updates for queues on unfollowed tasks and unreadable queue state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'remote-update-queue-')); const adapter = new CodexDesktop('unused', dir);
    const path = join(dir, '.codex-global-state.json');
    try {
      expect(await adapter.updateBlockers()).toEqual([]);
      writeFileSync(path, JSON.stringify({ 'queued-follow-ups': { 'unfollowed-task': [{ text: 'pending' }] } }));
      expect(await adapter.updateBlockers()).toEqual(['电脑端有尚未发送的队列消息']);
      writeFileSync(path, 'invalid JSON');
      expect(await adapter.updateBlockers()).toEqual(['无法核对电脑端队列，请稍后安装']);
      writeFileSync(path, JSON.stringify({ 'queued-follow-ups': {} }));
      expect(await adapter.updateBlockers()).toEqual([]);
    } finally { adapter.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  const turn = { turnId: 'turn-1', status: 'inProgress', turnStartedAtMs: 10, items: [
    { id: 'a', type: 'userMessage', content: [{ type: 'text', text: '你好' }] },
    { id: 'b', type: 'agentMessage', text: '正在处理' },
    { id: 'c', type: 'commandExecution', command: 'git status', status: 'completed', aggregatedOutput: 'never expose raw output by default' }
  ] };
  it('reads canonical paginated history used by 26.901 and retains active turn identity', () => {
    const result = normalizeSnapshot({ id: 'id', title: '任务', turnHistory: { kind: 'canonical', history: { entitiesByKey: { 'turn:1': turn } } } }, 'epoch');
    expect(result.messages.map(m => m.text)).toEqual(['你好', '正在处理', 'git status']); expect(result.busy).toBe(true); expect(result.turnId).toBe('turn-1');
  });
  it('handles legacy turns, deduplicates ids and bounds history', () => {
    const result = normalizeSnapshot({ id: 'id', turns: [turn, { ...turn, turnStartedAtMs: 20 }] }, 'epoch', 2);
    expect(result.messages).toHaveLength(2); expect(result.hasMore).toBe(true);
  });
  it('honors explicit idle runtime state over an orphaned in-progress turn', () => {
    const result = normalizeSnapshot({ id: 'id', threadRuntimeStatus: { type: 'idle' }, turns: [turn] }, 'epoch');
    expect(result.busy).toBe(false); expect(result.turnId).toBeNull(); expect(result.lastTurnStatus).toBe('interrupted');
    expect(result.messages.every(message => message.turnStatus === 'interrupted')).toBe(true);
    expect(turn.status).toBe('inProgress');
  });
  it('keeps a genuinely active long-running turn without imposing an age timeout', () => {
    const result = normalizeSnapshot({ id: 'id', threadRuntimeStatus: { type: 'active' }, turns: [{ ...turn, turnStartedAtMs: 1 }] }, 'epoch');
    expect(result.busy).toBe(true); expect(result.turnId).toBe('turn-1'); expect(result.lastTurnStatus).toBe('inProgress');
  });
  it('fails closed for unknown approval kinds', () => {
    const result = normalizeSnapshot({ id: 'id', requests: [{ id: 1, method: 'unknown', params: { code: 'arbitrary' } }] }, 'epoch');
    expect(result.requests[0].kind).toBe('unsupported');
  });
  it('bounds very large content below transport limits', () => {
    const result = normalizeSnapshot({ id: 'id', turns: [{ items: Array.from({ length: 100 }, (_, i) => ({ id: String(i), type: 'agentMessage', text: '中'.repeat(100000) })) }] }, 'epoch', 100);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1000000);
  });
  it('includes desktop tasks whose legacy has_user_event field remains zero', () => {
    const dir = mkdtempSync(join(tmpdir(), 'remote-index-test-'));
    const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
    db.exec("CREATE TABLE threads(id TEXT,name TEXT,title TEXT,cwd TEXT,updated_at_ms INTEGER,updated_at INTEGER,archived INTEGER,source TEXT,has_user_event INTEGER,project_id TEXT,rollout_path TEXT); INSERT INTO threads VALUES('a',NULL,'Task','C:/test',1000,1,0,'vscode',0,NULL,NULL),('b',NULL,'Hidden','C:/test',1000,1,0,'subagent',0,NULL,NULL);");
    db.prepare('UPDATE threads SET rollout_path=?').run(join(dir, 'state_5.sqlite')); db.close();
    const adapter = new CodexDesktop('unused', dir);
    expect(adapter.list(0).conversations.map(c => c.id)).toEqual(['a']); adapter.close(); rmSync(dir, { recursive: true, force: true });
  });
});
