import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';
import MobilePanel from '../web/MobilePanel.vue';

const state = vi.hoisted(() => ({ api: vi.fn(), unmounted: [] as (() => void)[] }));
vi.mock('vue', async original => ({
  ...await original() as object,
  useSSRContext: () => ({ modules: new Set() }),
  onMounted() {}, onActivated() {}, onDeactivated() {},
  onUnmounted: (callback: () => void) => state.unmounted.push(callback)
}));
vi.mock('../web/api', () => ({ api: (...args: unknown[]) => state.api(...args) }));
vi.mock('../web/use-chat-scroll', async () => {
  const { ref } = await import('vue');
  return { useChatScroll: () => ({
    awayFromBottom: ref(false), change: async (update: () => void) => update(),
    reset() {}, pause() {}, resume() {}, toBottom() {}, layoutChanged() {}
  }) };
});

class FakeSocket {
  static OPEN = 1; static CONNECTING = 0; static latest: FakeSocket;
  readyState = 1; frames: any[] = []; onmessage?: (event: { data: string }) => void;
  constructor(_url: URL) { FakeSocket.latest = this; }
  send(value: string) { this.frames.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  reply(frame: any, result: unknown) { this.receive({ type: 'result', id: frame.id, result }); }
  reject(frame: any, message: string) { this.receive({ type: 'result', id: frame.id, error: { code: 'CLIENT_REJECTED', message } }); }
}
function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(callback => { resolve = callback; });
  return { promise, resolve };
}
const task = () => ({ id: crypto.randomUUID(), title: 'Fixture task', cwd: '', updatedAt: Date.now() });
const scopes: ReturnType<typeof effectScope>[] = [];
function setup() {
  const scope = effectScope(); scopes.push(scope);
  const page = scope.run(() => (MobilePanel as any).setup({ deviceId: '123456789', deviceName: 'Fixture' }, { expose() {}, emit() {} }));
  page.active.value = true; page.openSocket(); page.connected.value = true;
  page.status.value = {
    online: true, enabled: true,
    client: { available: true, capabilities: ['queued-send', 'activity', 'command-status'] },
    subscription: { access: true }
  };
  return page;
}
beforeEach(() => {
  vi.useFakeTimers();
  state.unmounted.length = 0; state.api.mockReset(); state.api.mockResolvedValue({});
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  vi.stubGlobal('sessionStorage', storage); vi.stubGlobal('localStorage', storage); vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('navigator', { userAgent: 'Fixture', platform: 'Fixture', maxTouchPoints: 0 });
  vi.stubGlobal('location', { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1' });
  vi.stubGlobal('history', { replaceState() {} });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {}, dispatchEvent() {} });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => {
  for (const callback of state.unmounted.splice(0)) callback();
  for (const scope of scopes.splice(0)) scope.stop();
  vi.clearAllTimers(); vi.useRealTimers();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('M01: queue response fencing', () => {
  it('preserves the new queue, draft and attachments after A-B-A navigation', async () => {
    const p = setup(), a = task(), b = task(); p.showConversation(a);
    p.draft.value = 'Keep this draft';
    const attachment = { id: crypto.randomUUID(), name: 'saved.txt', size: 4, offset: 4, mediaType: 'text/plain', ready: true };
    p.attachments.restore(a.id, [attachment]);
    const reading = p.readQueue(), frame = FakeSocket.latest.frames.at(-1);
    p.showConversation(b); p.showConversation(a); p.queuedMessages.value = [{ id: 'new entry' }];
    FakeSocket.latest.reply(frame, { queued: [{ id: 'obsolete entry' }] }); await reading;
    expect(p.queuedMessages.value).toEqual([{ id: 'new entry' }]);
    expect(p.draft.value).toBe('Keep this draft'); expect(p.attachments.current.value[0].attachment).toEqual(attachment);
    expect(FakeSocket.latest.frames.map(row => row.command.method)).toEqual(['queue.list']);
  });
  it('discards a queue read after settings or connection invalidation', async () => {
    const p = setup(), a = task(); p.showConversation(a);
    const reading = p.readQueue(), frame = FakeSocket.latest.frames.at(-1);
    p.invalidateMode(); p.queuedMessages.value = [{ id: 'current entry' }];
    FakeSocket.latest.reply(frame, { queued: [] }); await reading;
    expect(p.queuedMessages.value).toEqual([{ id: 'current entry' }]);
  });
  it('still applies a matching response', async () => {
    const p = setup(); p.showConversation(task());
    const reading = p.readQueue(); FakeSocket.latest.reply(FakeSocket.latest.frames.at(-1), { queued: [{ id: 'confirmed entry' }] }); await reading;
    expect(p.queuedMessages.value).toEqual([{ id: 'confirmed entry' }]);
  });
});

describe('M02: notification badge snapshot boundaries', () => {
  for (const withSequence of [true, false]) it(`keeps new arrivals during an auto-read (${withSequence ? 'sequenced' : 'legacy'})`, async () => {
    const p = setup(), a = task(), receipt = deferred();
    const old = { id: crypto.randomUUID(), taskId: a.id, turnId: 'old', sequence: 1 };
    p.selected.value = a; p.snapshot.value = { id: a.id, busy: false, lastTurnId: 'old' }; p.notificationUnread.value = 1;
    state.api.mockImplementation(path => path === '/api/notifications' ? Promise.resolve({ items: [old], unread: 1, throughSequence: 1 }) : receipt.promise);
    const reading = p.suppressVisibleNotification(old); await nextTick();
    expect(state.api).toHaveBeenCalledTimes(2);
    const newer = { id: crypto.randomUUID(), deviceId: '123456789', taskId: a.id, turnId: 'new', sequence: 2 };
    FakeSocket.latest.receive({ type: 'notification', notification: newer });
    receipt.resolve({ unread: 0, ...(withSequence ? { throughSequence: 1 } : {}) }); await reading;
    expect(p.notificationUnread.value).toBe(1);
  });
  it('does not count an arrival already covered by the server snapshot twice', async () => {
    const p = setup(), a = task(), receipt = deferred(); const old = { id: crypto.randomUUID(), taskId: a.id, turnId: 'old' };
    p.selected.value = a; p.snapshot.value = { id: a.id, busy: false, lastTurnId: 'old' }; p.notificationUnread.value = 1;
    state.api.mockImplementation(path => path === '/api/notifications' ? Promise.resolve({ items: [old] }) : receipt.promise);
    const reading = p.suppressVisibleNotification(old); await nextTick();
    FakeSocket.latest.receive({ type: 'notification', notification: { id: crypto.randomUUID(), deviceId: '123456789', taskId: a.id, turnId: 'new', sequence: 2 } });
    receipt.resolve({ unread: 1, throughSequence: 2 }); await reading;
    expect(p.notificationUnread.value).toBe(1);
  });
  it('preserves new arrivals during notification-link read receipts', async () => {
    const p = setup(), a = task(), receipt = deferred(), id = crypto.randomUUID();
    vi.stubGlobal('location', { href: `http://127.0.0.1/?notification=${id}`, origin: 'http://127.0.0.1' });
    state.api.mockImplementation(path => path.endsWith('/read') ? receipt.promise : Promise.resolve({ item: { id, taskId: a.id } }));
    p.notificationUnread.value = 1;
    const opening = p.openNotificationFromUrl(); await nextTick();
    FakeSocket.latest.reply(FakeSocket.latest.frames.at(-1), { id: a.id, title: a.title, busy: false, lastTurnId: 'old' });
    await vi.waitFor(() => expect(state.api).toHaveBeenCalledTimes(2));
    FakeSocket.latest.receive({ type: 'notification', notification: { id: crypto.randomUUID(), deviceId: '123456789', taskId: a.id, turnId: 'new', sequence: 2 } });
    receipt.resolve({ unread: 0, throughSequence: 1 }); await opening;
    expect(p.notificationUnread.value).toBe(1);
  });
  it('corrects an already-read notification while retaining arrivals after the list boundary', async () => {
    const p = setup(), a = task(), list = deferred(); const old = { id: crypto.randomUUID(), taskId: a.id, turnId: 'old' };
    p.selected.value = a; p.snapshot.value = { id: a.id, busy: false, lastTurnId: 'old' }; p.notificationUnread.value = 1;
    state.api.mockReturnValue(list.promise); const reading = p.suppressVisibleNotification(old);
    FakeSocket.latest.receive({ type: 'notification', notification: { id: crypto.randomUUID(), deviceId: '123456789', taskId: a.id, turnId: 'new', sequence: 2 } });
    list.resolve({ items: [{ ...old, readAt: 1 }], unread: 0, throughSequence: 1 }); await reading;
    expect(p.notificationUnread.value).toBe(1); expect(state.api).toHaveBeenCalledTimes(1);
  });
});

describe('M03: seen receipt completion identity', () => {
  it('does not clear a newer completion on the same mutable snapshot', async () => {
    const p = setup(), a = task();
    p.selected.value = a; p.snapshot.value = { id: a.id, busy: false, completionId: 'old:complete', lastTurnId: 'old' };
    p.activities[a.id] = { id: a.id, unread: true, completionId: 'old:complete' };
    p.groups.recent = { rows: [{ ...a, unread: true, completionId: 'old:complete' }] };
    const reading = p.markSeen(), frame = FakeSocket.latest.frames.at(-1);
    p.snapshot.value.completionId = 'new:complete'; p.snapshot.value.lastTurnId = 'new';
    p.activities[a.id] = { id: a.id, unread: true, completionId: 'new:complete' };
    p.groups.recent.rows[0].completionId = 'new:complete';
    FakeSocket.latest.reply(frame, { seen: true }); await reading;
    expect(p.activities[a.id].unread).toBe(true); expect(p.groups.recent.rows[0].unread).toBe(true);
    const latest = p.markSeen(); expect(FakeSocket.latest.frames.at(-1).command.params.completionId).toBe('new:complete');
    FakeSocket.latest.reply(FakeSocket.latest.frames.at(-1), { seen: true }); await latest;
    expect(p.activities[a.id].unread).toBe(false); expect(p.groups.recent.rows[0].unread).toBe(false);
  });
  it('does not clear list activity from a newer completion even if the snapshot is unchanged', async () => {
    const p = setup(), a = task(); p.selected.value = a;
    p.snapshot.value = { id: a.id, busy: false, completionId: 'old:complete' };
    const reading = p.markSeen(), frame = FakeSocket.latest.frames.at(-1);
    p.activities[a.id] = { id: a.id, unread: true, completionId: 'new:complete' };
    p.groups.recent = { rows: [{ ...a, unread: true, completionId: 'new:complete' }] };
    FakeSocket.latest.reply(frame, { seen: true }); await reading;
    expect(p.activities[a.id].unread).toBe(true); expect(p.groups.recent.rows[0].unread).toBe(true);
  });
  it('does not let an old rejected receipt reset the newer round acknowledgement', async () => {
    const p = setup(), a = task(); p.selected.value = a;
    p.snapshot.value = { id: a.id, busy: false, completionId: 'old:complete' };
    const old = p.markSeen(), oldFrame = FakeSocket.latest.frames.at(-1);
    p.snapshot.value = { id: a.id, busy: false, completionId: 'new:complete' };
    const newer = p.markSeen(), newFrame = FakeSocket.latest.frames.at(-1);
    FakeSocket.latest.reply(oldFrame, { seen: false }); await old;
    FakeSocket.latest.reply(newFrame, { seen: true }); await newer;
    await p.markSeen(); expect(FakeSocket.latest.frames).toHaveLength(2);
  });
});

describe('M04: new-task preparation identity', () => {
  it('ignores preparation after explicit task navigation', async () => {
    const p = setup(), a = task(); const preparing = p.newConversation('old-project'), frame = FakeSocket.latest.frames.at(-1);
    p.cancelNotificationNavigation(); p.showConversation({ ...a, projectId: 'new-project' }); p.draft.value = 'New draft';
    FakeSocket.latest.reply(frame, { projects: [{ id: 'old-project' }] }); await preparing;
    expect(p.projectModal.value).toBe(false); expect(p.selected.value.id).toBe(a.id); expect(p.draft.value).toBe('New draft');
  });
  it('ignores errors from obsolete preparation', async () => {
    const p = setup(); const preparing = p.newConversation('old-project'), frame = FakeSocket.latest.frames.at(-1);
    p.showConversation(task()); p.error.value = 'Current task error';
    FakeSocket.latest.reject(frame, 'Obsolete preparation error'); await preparing;
    expect(p.error.value).toBe('Current task error'); expect(p.projectModal.value).toBe(false);
  });
  it('keeps the most recently requested project', async () => {
    const p = setup(); const old = p.newConversation('old-project'), oldFrame = FakeSocket.latest.frames.at(-1);
    const newer = p.newConversation('new-project'), newFrame = FakeSocket.latest.frames.at(-1);
    FakeSocket.latest.reply(newFrame, { projects: [{ id: 'new-project' }] }); await newer;
    FakeSocket.latest.reply(oldFrame, { projects: [{ id: 'old-project' }] }); await old;
    expect(p.projectModal.value).toBe(true); expect(p.projectId.value).toBe('new-project');
  });
});

describe('M05: task-name resolution during pagination', () => {
  it('rescans for a newly requested ID behind the cursor and stops for a missing ID', async () => {
    const p = setup(), a = task(), b = task(), missing = task();
    const scanning = p.resolveNotificationTasks([a.id]);
    FakeSocket.latest.reply(FakeSocket.latest.frames.at(-1), { conversations: [b], hasMore: true, nextOffset: 1 });
    await vi.waitFor(() => expect(FakeSocket.latest.frames).toHaveLength(2));
    const additional = p.resolveNotificationTasks([b.id, missing.id]);
    FakeSocket.latest.reply(FakeSocket.latest.frames.at(-1), { conversations: [a], hasMore: false });
    await vi.waitFor(() => expect(FakeSocket.latest.frames).toHaveLength(3));
    expect(FakeSocket.latest.frames.at(-1).command.params.offset).toBe(0);
    FakeSocket.latest.reply(FakeSocket.latest.frames.at(-1), { conversations: [b], hasMore: true, nextOffset: 1 });
    await vi.waitFor(() => expect(FakeSocket.latest.frames).toHaveLength(4));
    FakeSocket.latest.reply(FakeSocket.latest.frames.at(-1), { conversations: [a], hasMore: false });
    await scanning; await additional;
    expect(p.notificationTasks[a.id]).toEqual(a); expect(p.notificationTasks[b.id]).toEqual(b);
    expect(p.notificationTasks[missing.id]).toBeUndefined(); expect(FakeSocket.latest.frames).toHaveLength(4);
  });
  it('does not apply names from a disconnected navigation generation', async () => {
    const p = setup(), a = task(); const scanning = p.resolveNotificationTasks([a.id]), frame = FakeSocket.latest.frames.at(-1);
    p.clearNavigation(true); FakeSocket.latest.reply(frame, { conversations: [a], hasMore: false }); await scanning;
    expect(p.notificationTasks[a.id]).toBeUndefined();
  });
});

describe('M06: durable send protection when storage fails', () => {
  for (const failingKey of ['chat-drafts:123456789', 'pending-sends:123456789']) it(`keeps draft and attachments when ${failingKey} cannot be saved`, async () => {
    const p = setup(), a = task(); p.showConversation(a); p.draft.value = 'Important draft'; p.status.value.online = false;
    const attachment = { id: crypto.randomUUID(), name: 'saved.txt', size: 4, offset: 4, mediaType: 'text/plain', ready: true };
    p.attachments.restore(a.id, [attachment]);
    const setItem = vi.fn((key: string): void => { if (key === failingKey) throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem, removeItem() {} });
    const command = { method: 'send', params: { id: a.id, epoch: 'fixture', text: p.draft.value, attachmentIds: [attachment.id] } };
    expect(await p.perform(command)).toBe(false);
    expect(FakeSocket.latest.frames).toEqual([]); expect(p.pendingSends[a.id]).toBeUndefined();
    expect(p.error.value).toContain('本次未发送'); expect(p.error.value).toContain('浏览器存储'); expect(p.error.value).not.toContain('Quota exceeded');
    expect(p.draft.value).toBe('Important draft'); expect(p.attachments.current.value[0].attachment).toEqual(attachment);
    setItem.mockImplementation(() => undefined);
    const retry = p.perform(command), frame = FakeSocket.latest.frames.at(-1);
    expect(frame.command).toEqual(command); FakeSocket.latest.reply(frame, { accepted: true }); expect(await retry).toBe(true);
    expect(FakeSocket.latest.frames).toHaveLength(1); expect(p.draft.value).toBe(''); expect(p.attachments.current.value).toHaveLength(0);
  });
  it('keeps the durable request identity after an ambiguous send result without auto-resending', async () => {
    const p = setup(), a = task(), saved = new Map<string, string>(); p.showConversation(a); p.draft.value = 'Unconfirmed draft'; p.status.value.online = false;
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem() {} });
    const sending = p.perform({ method: 'send', params: { id: a.id, epoch: 'fixture', text: p.draft.value } }), frame = FakeSocket.latest.frames.at(-1);
    FakeSocket.latest.receive({ type: 'result', id: frame.id, error: { code: 'OUTCOME_UNKNOWN', message: 'Lost acknowledgement' } });
    expect(await sending).toBe(false); expect(p.pendingSends[a.id].requestId).toBe(frame.id);
    expect(JSON.parse(saved.get('pending-sends:123456789')!)[a.id].requestId).toBe(frame.id);
    expect(p.draft.value).toBe('Unconfirmed draft'); expect(FakeSocket.latest.frames).toHaveLength(1);
  });
});
