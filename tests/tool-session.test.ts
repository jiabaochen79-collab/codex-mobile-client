import { describe, expect, it, vi } from 'vitest';
import { ToolSession, toolSessionCapabilities } from '../src/agent/tool-session.js';

const tools = ['read_thread', 'list_projects', 'list_threads', 'send_message_to_thread', 'create_thread'].map(name => ({ namespace: 'codex_app', name, inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, prompt: { type: 'string' } } } }));
const page = (id = 'task', turnId = 'new', hasMore = false, nextCursor?: string) => ({ schemaVersion: 1, thread: { id, kind: 'codex', hostId: 'local', title: 'Title', cwd: '/workspace', status: { type: 'idle' } }, turns: [{ id: turnId, status: 'completed', startedAt: turnId === 'new' ? 2 : 1, items: [{ id: turnId + '-answer', type: 'agentMessage', phase: 'final_answer', text: 'Answer' }] }], page: { hasMore, nextCursor } });

describe('native task tool transport', () => {
  it('negotiates actual tools without requiring an installed source registry', () => {
    const assessment = toolSessionCapabilities(tools);
    expect(assessment.capabilities).toEqual(expect.arrayContaining(['compatibility-checked', 'send-messages', 'create-tasks']));
    expect(assessment.capabilities).not.toContain('steering-text');
    expect(assessment.capabilities).not.toContain('stop-generation'); expect(assessment.capabilities).not.toContain('permission-settings');
    expect(toolSessionCapabilities(tools.filter(tool => tool.name !== 'send_message_to_thread')).capabilities).not.toContain('send-messages');
    expect(() => toolSessionCapabilities(tools.map(tool => ({ ...tool, namespace: 'other' })))).toThrow('尚未启动');
  });
  it('reads the original task and preserves loaded history when its latest turn refreshes', async () => {
    const call = vi.fn().mockResolvedValueOnce(page('task', 'new', true, 'older')).mockResolvedValueOnce(page('task', 'old')).mockResolvedValueOnce({ ...page(), thread: { ...page().thread, status: { type: 'active' } } });
    const session = new ToolSession(call);
    const first = await session.read('task'); expect(first.turns[0]).toMatchObject({ turnId: 'new', items: [{ phase: 'final' }] }); expect(session.hasMore('task')).toBe(true);
    await session.read('task', true); expect(call).toHaveBeenLastCalledWith('read_thread', expect.objectContaining({ hostId: 'local', threadId: 'task', cursor: 'older' }), 'task');
    expect(session.hasMore('task')).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 760));
    expect((await session.read('task')).turns.map((turn: any) => turn.turnId)).toEqual(['old', 'new']);
    expect(session.hasMore('task')).toBe(false);
    await session.read('task', true); expect(call).toHaveBeenCalledTimes(3);
  });
  it.each([
    { ...page(), thread: { ...page().thread, id: 'another-task' } },
    { ...page(), thread: { ...page().thread, hostId: 'remote' } },
    { ...page(), turns: [{ id: 'turn', status: 'completed', items: null }] },
    { ...page(), page: { hasMore: true } }
  ])('rejects mismatched or incomplete data without treating it as a completed task', async result => {
    const session = new ToolSession(vi.fn().mockResolvedValue(result)); await expect(session.read('task')).rejects.toThrow('数据不完整');
  });
  it('does not commit a stale read after a desktop disconnect', async () => {
    let resolve!: (value: unknown) => void;
    const session = new ToolSession(() => new Promise(done => { resolve = done; }));
    const pending = session.read('task'); session.clear(); resolve(page());
    await expect(pending).rejects.toMatchObject({ code: 'CLIENT_UNAVAILABLE' }); expect(session.hasMore('task')).toBe(false);
  });
});
