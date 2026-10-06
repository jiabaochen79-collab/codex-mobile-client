import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';
import MobilePanel from '../web/MobilePanel.vue';
import NotificationCenter from '../web/NotificationCenter.vue';
import DevicesPanel from '../web/DevicesPanel.vue';
import SubscriptionPanel from '../web/SubscriptionPanel.vue';
const state = vi.hoisted(() => ({ api: vi.fn(), mounted: [] as (() => any)[], unmounted: [] as (() => void)[], draft: vi.fn() }));
vi.mock('vue', async original => ({ ...await original() as object, useSSRContext: () => ({ modules: new Set() }), onMounted: (cb: () => any) => state.mounted.push(cb), onActivated() {}, onDeactivated() {}, onUnmounted: (cb: () => void) => state.unmounted.push(cb) }));
vi.mock('../web/api', () => ({ api: (...args: unknown[]) => state.api(...args) }));
vi.mock('../web/feedback-drafts', () => ({ feedbackDraft: (...args: unknown[]) => state.draft(...args) }));
vi.mock('../web/use-chat-scroll', async () => { const { ref } = await import('vue'); return { useChatScroll: () => ({ awayFromBottom: ref(false), change: async (update: () => void) => update(), reset() {}, pause() {}, resume() {}, toBottom() {}, layoutChanged() {} }) }; });
class Socket {
  static OPEN = 1; static CONNECTING = 0; static latest: Socket;
  readyState = 1; frames: any[] = []; onmessage?: (event: { data: string }) => void;
  constructor() { Socket.latest = this; }
  send(text: string) { this.frames.push(JSON.parse(text)); }
  close() { this.readyState = 3; }
  reply(frame: any, result: any) { this.onmessage?.({ data: JSON.stringify({ type: 'result', id: frame.id, result }) }); }
}
const scopes: ReturnType<typeof effectScope>[] = [];
const task = () => ({ id: crypto.randomUUID(), title: 'Audit fixture', cwd: '', updatedAt: Date.now() });
const defer = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(r => resolve = r); return { promise, resolve }; };
function setup(component: any, props: any, emit = vi.fn()) { const scope = effectScope(); scopes.push(scope); return scope.run(() => component.setup(props, { expose() {}, emit })); }
function mobile() { const p = setup(MobilePanel, { deviceId: '123456789', deviceName: 'Fixture' }); p.active.value = true; p.openSocket(); p.connected.value = true; p.status.value = { online: true, enabled: true, client: { available: true, capabilities: ['activity', 'safety-status', 'command-status'] }, subscription: { access: true } }; return p; }
beforeEach(() => {
  vi.useFakeTimers(); state.mounted.length = state.unmounted.length = 0; state.api.mockReset().mockResolvedValue({}); state.draft.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem() {}, removeItem() {} }); vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('navigator', { userAgent: 'Fixture', platform: 'Fixture', maxTouchPoints: 0 });
  vi.stubGlobal('location', { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1', hash: '', pathname: '/', search: '' }); vi.stubGlobal('history', { replaceState() {} });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {}, dispatchEvent() {} });
  vi.stubGlobal('document', { visibilityState: 'visible', querySelector: () => null, documentElement: { classList: { toggle() {}, remove() {} } }, addEventListener() {}, removeEventListener() {} }); vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('HTMLInputElement', class {});
});
afterEach(() => { for (const cb of state.unmounted.splice(0)) cb(); for (const scope of scopes.splice(0)) scope.stop(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('returning to custom answer destroys the previous manually entered text', async () => {
  const p = mobile(), r = { id: 'approval' }, q = { id: 'q', options: [{ label: 'Option' }] }; const key = p.answerKey(r, q);
  p.answers.value[key] = 'A long custom answer'; p.answerModes[key] = 'custom';
  p.chooseAnswer(r, q, { currentTarget: { value: '0' } }); p.chooseAnswer(r, q, { currentTarget: { value: 'custom' } });
  expect(p.answers.value[key]).toBe('A long custom answer');
});
it('a stale activity response resurrects cleared task state', async () => {
  const p = mobile(), a = task(); p.selected.value = a;
  const reading = p.refreshActivity(), frame = Socket.latest.frames.at(-1); p.clearNavigation(true);
  Socket.latest.reply(frame, { activities: [{ id: a.id, unread: true, completionId: 'old' }] }); await reading;
  expect(p.activities[a.id]).toBeUndefined();
});
it('expired-subscription safety status survives an A-B-A connection-cycle invalidation', async () => {
  const p = mobile(), a = task(), b = task(); p.showConversation(a); p.status.value.subscription.access = false;
  const reading = p.read(), frame = Socket.latest.frames.at(-1); p.showConversation(b); p.showConversation(a);
  p.snapshot.value = { id: a.id, epoch: 'new', busy: false, turnId: null }; p.invalidateMode();
  Socket.latest.reply(frame, { id: a.id, epoch: 'obsolete', busy: true, turnId: 'obsolete-round' }); await reading;
  expect(p.snapshot.value.epoch).toBe('new'); expect(p.snapshot.value.turnId).toBeNull();
});
it('a new completion notification silently discards an in-flight historical page', async () => {
  const props = { deviceId: '123456789', taskLabels: {}, resolveTasks: async () => {}, openTask: async () => true };
  const item = (sequence: number) => ({ id: crypto.randomUUID(), deviceId: props.deviceId, taskId: crypto.randomUUID(), turnId: 'fixture', status: 'completed', occurredAt: Date.now(), createdAt: Date.now(), readAt: null, sequence });
  const initial = item(10), history = item(9), incoming = item(11);
  state.api.mockImplementation(path => path.endsWith('/settings') ? Promise.resolve({ settings: { enabled: false } }) : Promise.resolve({ items: [initial], unread: 1, nextCursor: 'page-2' }));
  const p = setup(NotificationCenter, props); await p.load();
  const page = defer(); state.api.mockReturnValue(page.promise); const reading = p.loadMore();
  p.onIncoming({ detail: incoming }); page.resolve({ items: [history], unread: 2, nextCursor: 'page-3' }); await reading;
  expect(p.items.value.map((row: any) => row.id)).toEqual([incoming.id, initial.id, history.id]); expect(p.nextCursor.value).toBe('page-3'); expect(p.loadingMore.value).toBe(false);
});
it('directory polling invalidates every delayed response when latency exceeds the polling interval', async () => {
  const responses = [defer(), defer(), defer()]; let index = 0; state.api.mockImplementation(() => responses[index++].promise);
  const p = setup(DevicesPanel, {}); p.devices.value = [{ deviceId: '123456789', online: false }];
  const a = p.refreshDirectory(); await vi.advanceTimersByTimeAsync(15000); const b = p.refreshDirectory();
  responses[0].resolve({ devices: [{ deviceId: '123456789', online: true }] }); await a; expect(p.devices.value[0].online).toBe(true); expect(state.api).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15000); const c = p.refreshDirectory(); responses[1].resolve({ devices: [{ deviceId: '123456789', online: true }] }); await b;
  expect(p.devices.value[0].online).toBe(true); await c;
});
it('a native image dialog does not block completion acknowledgement', async () => {
  const p = mobile(), a = task(); p.selected.value = a; p.snapshot.value = { id: a.id, busy: false, lastTurnId: 'done-round' };
  vi.stubGlobal('document', { visibilityState: 'visible', querySelector: () => ({ open: true }), addEventListener() {}, removeEventListener() {} });
  const item = { id: crypto.randomUUID(), taskId: a.id, turnId: 'done-round', readAt: null };
  state.api.mockResolvedValue({ items: [item], unread: 1 }); await p.suppressVisibleNotification(item);
  expect(state.api.mock.calls.some(call => call[0].endsWith('/read'))).toBe(false);
});
it('registerPush accepts a subscription created with a different VAPID key', async () => {
  const subscription = { options: { applicationServerKey: new Uint8Array([1,2,3]).buffer }, unsubscribe: vi.fn().mockResolvedValue(true) };
  const subscribe = vi.fn().mockResolvedValue({ toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fixture', keys: { p256dh: 'fixture', auth: 'fixture' } }) }); const registration = { pushManager: { getSubscription: async () => subscription, subscribe } };
  vi.stubGlobal('navigator', { userAgent: 'Chrome', platform: 'Fixture', maxTouchPoints: 0, serviceWorker: { getRegistration: async () => registration, register: async () => registration, ready: Promise.resolve(registration) } });
  vi.stubGlobal('window', { Notification: {}, PushManager: {}, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('Notification', { permission: 'granted' });
  const p = setup(NotificationCenter, { deviceId: '123456789', taskLabels: {}, resolveTasks: async () => {}, openTask: async () => true });
  p.pushConfigured.value = true; p.vapidPublicKey.value = Buffer.from([4,5,6]).toString('base64url');
  await p.registerPush(); expect(subscription.unsubscribe).toHaveBeenCalledOnce(); expect(subscribe).toHaveBeenCalledOnce(); expect(p.systemPushState.value).toBe('enabled');
});
it('overlapping order-driven subscription loads allow old entitlement to overwrite the new one', async () => {
  const old = defer(), fresh = defer(); state.api.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const p = setup(SubscriptionPanel, { mode: 'mobile', deviceId: '123456789' });
  const a = p.load(), b = p.load();
  fresh.resolve({ catalog: {}, subscription: { access: false, state: 'refunded' }, trial: {} }); await b;
  old.resolve({ catalog: {}, subscription: { access: true, state: 'active' }, trial: {} }); await a;
  expect(p.subscription.value.access).toBe(false);
});
it('prepends history pages, retains them through polling and fences old task responses', async () => {
  const p = mobile(), a = task(), b = task(); p.showConversation(a);
  p.status.value.client.capabilities.push('history-pages');
  const snapshot = (id: string, ids: string[], hasMore = true) => ({ id, epoch: 'fixture', busy: false, turnId: null, messages: ids.map(id => ({ id, role: 'assistant', text: id })), requests: [], hasMore, historyCursor: ids[0], settings: { mode: 'default' } });
  const initial = p.read(); Socket.latest.reply(Socket.latest.frames.at(-1), snapshot(a.id, ['m2', 'm3'])); await initial;
  const older = p.loadHistory(); expect(Socket.latest.frames.at(-1).command.params.before).toBe('m2');
  Socket.latest.reply(Socket.latest.frames.at(-1), snapshot(a.id, ['m0', 'm1'])); await older;
  const fresh = p.read(); Socket.latest.reply(Socket.latest.frames.at(-1), snapshot(a.id, ['m3', 'm4'])); await fresh;
  expect(p.snapshot.value.messages.map((m: any) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  const obsolete = p.loadHistory(), frame = Socket.latest.frames.at(-1); p.showConversation(b); p.showConversation(a);
  p.snapshot.value = snapshot(a.id, ['new']); Socket.latest.reply(frame, snapshot(a.id, ['obsolete'], false)); await obsolete;
  expect(p.snapshot.value.messages.map((m: any) => m.id)).toEqual(['new']);
});
