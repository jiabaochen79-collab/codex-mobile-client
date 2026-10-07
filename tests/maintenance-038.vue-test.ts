import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, compileScript } from '@vue/compiler-sfc';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as protocol from '../src/shared/protocol.js';
import * as subscription from '../src/shared/subscription.js';
import * as commerce from '../src/shared/commerce.js';
import * as feedback from '../src/shared/feedback.js';
import * as updates from '../src/shared/updates.js';
import * as pairedDevices from '../src/shared/paired-devices.js';
import { conversationTurns } from '../web/conversation-model.js';
import { mergeNotificationCount } from '../web/notification-count.js';
import { ConversationImages } from '../src/agent/images.js';
import sharp from 'sharp';
const scopes: vue.EffectScope[] = [], cleanup: (() => void)[] = [];
let api: (...args: any[]) => Promise<any> = async () => ({});
let draft: (...args: any[]) => Promise<any> = async () => undefined;
let push: () => Promise<any> = async () => ({});
const browser: any = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, matchMedia: () => ({ matches: true }), Notification: {}, PushManager: {} };
Object.assign(globalThis, { window: browser, document: { visibilityState: 'visible', querySelector: () => null, documentElement: { classList: { toggle() {}, remove() {} } }, addEventListener() {}, removeEventListener() {} }, location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1', search: '', hash: '', pathname: '/' }, history: { replaceState() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, cancelAnimationFrame() {} });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Fixture', platform: 'Fixture', maxTouchPoints: 0, serviceWorker: {} } });
function setup(file: string, props: any = {}, emit: (...args: any[]) => void = () => {}) {
  const code = transformSync(compileScript(parse(readFileSync(resolve('web', file), 'utf8')).descriptor, { id: file }).content, { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', code)((id: string) => {
    if (id === 'vue') return { ...vue, onMounted() {}, onActivated() {}, onDeactivated() {}, onUnmounted: (cb: any) => cleanup.push(cb) };
    if (id === './api') return { api: (...args: any[]) => api(...args) };
    if (id.endsWith('/protocol')) return protocol;
    if (id.endsWith('/subscription')) return subscription;
    if (id.endsWith('/commerce')) return commerce;
    if (id.endsWith('/feedback')) return feedback;
    if (id.endsWith('/updates')) return updates;
    if (id.endsWith('/paired-devices')) return pairedDevices;
    if (id === './resume-reload') return { installResumeReload: () => ({ ready() {}, dispose() {} }) };
    if (id === './feedback-drafts') return { feedbackDraft: (...args: any[]) => draft(...args) };
    if (id === './feedback-upload') return { uploadFeedbackPictures: async () => [] };
    if (id === './use-chat-scroll') return { useChatScroll: () => ({ awayFromBottom: vue.ref(false), change: async (fn: any) => fn(), reset() {}, pause() {}, resume() {}, toBottom() {} }) };
    if (id === './use-attachments') return { useAttachments: () => ({ current: vue.ref([]), hasPending: vue.ref(false), restore() {}, clear() {} }) };
    if (id === './conversation-model') return { conversationTurns };
    if (id === './notification-count') return { mergeNotificationCount };
    if (id === './push-registration') return { pushRegistration: () => push() };
    if (id === 'qrcode') return { default: { toDataURL: async () => 'data:fixture' } };
    if (id === 'lucide-vue-next' || id.endsWith('.vue') || ['./mobile-viewport','./prepare-photo'].includes(id)) return {};
    throw new Error('Unexpected import: ' + id);
  }, module, module.exports);
  const scope = vue.effectScope(); scopes.push(scope);
  return scope.run(() => module.exports.default.setup(props, { expose() {}, emit }));
}
function deferred() { let resolve!: (v: any) => void; return { promise: new Promise<any>(r => resolve = r), resolve: (v: any) => resolve(v) }; }
let socketReply: (command: any) => any = () => ({});
class FixtureSocket {
  static OPEN = 1; readyState = 1; onmessage?: (event: any) => void;
  constructor(_url: any) {}
  send(text: string) { const frame = JSON.parse(text); queueMicrotask(() => { try { this.onmessage?.({ data: JSON.stringify({ type: 'result', id: frame.id, result: socketReply(frame.command) }) }); } catch (e: any) { this.onmessage?.({ data: JSON.stringify({ type: 'result', id: frame.id, error: { code: e.code, message: e.message } }) }); } }); }
  close() {}
}
Object.assign(globalThis, { WebSocket: FixtureSocket });
function mobileFixture(capabilities: string[]) { const p = setup('MobilePanel.vue', { deviceId: '123456789', deviceName: 'Fixture' }); p.active.value = true; p.connected.value = true; p.status.value = { online: true, enabled: true, client: { available: true, capabilities }, subscription: { access: true } }; p.openSocket(); return p; }

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
beforeEach(() => {
  api = async () => ({}); draft = async () => undefined; socketReply = () => ({});
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Fixture', platform: 'Fixture', maxTouchPoints: 0, serviceWorker: { addEventListener() {}, removeEventListener() {} } } });
});
afterEach(() => { for (const cb of cleanup.splice(0)) cb(); for (const scope of scopes.splice(0)) scope.stop(); vi.restoreAllMocks(); });

it('F02 notification navigation activates only for the existing controller', async () => {
  for (const role of ['controller', 'viewer']) {
    const p = mobileFixture(['multi-terminal']); p.status.value.control = { role, epoch: 'lease' };
    let activation: unknown;
    const taskId = crypto.randomUUID();
    socketReply = (c: any) => { activation = c.params.activate; return { id: taskId, title: 'Fixture', epoch: 'epoch', messages: [], requests: [], busy: false, hasMore: false }; };
    expect(await p.openNotificationTask(taskId)).toBe(true);
    expect(activation).toBe(role === 'controller');
  }
});
it('F09 a committed feedback result remains visible when local cleanup fails', async () => {
  api = async () => ({ ticket: { id: 'created-ticket', state: 'open' }, messages: [] });
  draft = async (_key, value) => { if (value === null) throw new Error('storage failure'); };
  const p = setup('FeedbackPanel.vue', { mode: 'mobile', deviceId: '123456789' });
  p.loaded.value = true; p.writing.value = true; p.text.value = 'issue'; await p.send();
  expect(p.detail.value.ticket.id).toBe('created-ticket');
  expect(p.writing.value).toBe(false); expect(p.error.value).toContain('已提交成功');
});
it('F10 a newer notification receipt wins over an old read-one response', async () => {
  const wait = deferred(); api = async () => wait.promise;
  const p = setup('NotificationCenter.vue', { deviceId: '123456789', taskLabels: {}, resolveTasks: async () => {}, openTask: async () => true });
  const item = { id: crypto.randomUUID(), deviceId: '123456789', taskId: crypto.randomUUID(), sequence: 1, readAt: null };
  p.items.value = [item]; p.unread.value = 4;
  const read = p.readOne(item); await Promise.resolve(); await Promise.resolve();
  p.onRead({ detail: { deviceId: '123456789', all: true, readAt: 1000, throughSequence: 4, unread: 0 } });
  wait.resolve({ throughSequence: 4, unread: 3 }); await read; expect(p.unread.value).toBe(0);
});
it('F10 a newer receipt also fences a delayed read-all response', async () => {
  const wait = deferred(); api = async () => wait.promise;
  const p = setup('NotificationCenter.vue', { deviceId: '123456789', taskLabels: {}, resolveTasks: async () => {}, openTask: async () => true });
  p.unread.value = 4; p.items.value = [{ id: 'one', sequence: 1, readAt: null }];
  const read = p.readAll();
  p.onRead({ detail: { deviceId: '123456789', all: true, readAt: 1000, throughSequence: 5, unread: 0 } });
  wait.resolve({ throughSequence: 4, unread: 1 }); await read; expect(p.unread.value).toBe(0);
});
it('F11 historical image references are refreshed after an epoch change without dropping messages', async () => {
  const p = mobileFixture(['history-pages']), task = crypto.randomUUID();
  p.selected.value = { id: task, title: 'Fixture' };
  p.snapshot.value = { id: task, epoch: 'old', messages: [{ id: 'photo', role: 'user', text: '', images: [{ id: 'old-token', alt: 'photo' }] }, { id: 'answer', role: 'assistant', text: 'answer' }], requests: [], busy: false, hasMore: true };
  socketReply = (c: any) => c.params.before ? { id: task, epoch: 'new', messages: [{ id: 'photo', role: 'user', text: '', images: [{ id: 'new-token', alt: 'photo' }] }], hasMore: false } : { id: task, title: 'Fixture', epoch: 'new', messages: [{ id: 'answer', role: 'assistant', text: 'answer' }], requests: [], busy: false, hasMore: true, historyCursor: 'answer' };
  await p.read(); await vi.waitFor(() => expect(p.snapshot.value.messages[0].images[0].id).toBe('new-token'));
  expect(p.snapshot.value.messages.map((m: any) => m.id)).toEqual(['photo','answer']);
});
it('F14 running projects arrive in one project response, with no archive scan', async () => {
  const p = mobileFixture(['project-navigation','task-list-cursor','live-activity']);
  const calls: any[] = [];
  socketReply = (c: any) => { calls.push(c); return c.method === 'projects' ? { projects: [{ id: 'running-project', name: 'Fixture', running: true }] } : { conversations: [], hasMore: false, cursor: 'fixture', nextOffset: 30 }; };
  await p.loadNavigation();
  expect(p.expandedProjects.has('running-project')).toBe(true);
  expect(calls.filter(c => c.method === 'list')).toHaveLength(2);
});
it('F15 loaded navigation refreshes only one head page while preserving its continuation', async () => {
  const p = mobileFixture(['task-list-cursor']), state = p.group('recent');
  state.rows = Array.from({ length: 1500 }, (_, i) => ({ id: String(i), title: 'Fixture' })); state.loaded = true; state.cursor = 'retained'; state.offset = 1500; state.hasMore = true;
  let calls = 0; socketReply = () => { calls++; return { conversations: [{ id: '0', title: 'Updated' }], hasMore: true }; };
  for (let i = 0; i < 4; i++) await p.loadGroup(null);
  expect(calls).toBe(4); expect(state.rows).toHaveLength(1500); expect(state.cursor).toBe('retained'); expect(state.offset).toBe(1500);
});
it('F17 cursor reset during append does not replace already loaded rows', async () => {
  const p = mobileFixture(['task-list-cursor']), state = p.group('recent');
  state.rows = [{ id: 'old' }]; state.loaded = true; state.offset = 30; state.cursor = 'expired';
  socketReply = () => ({ reset: true, conversations: [{ id: 'next' }], hasMore: false, cursor: 'restored', nextOffset: 60 });
  await p.loadGroup(null, true); expect(state.rows.map((r: any) => r.id)).toEqual(['old','next']);
});
it('F23 unchanged feedback polls request a revision and do not replace the conversation', async () => {
  const p = setup('FeedbackPanel.vue', { mode: 'mobile', deviceId: '123456789' });
  p.detail.value = { ticket: { id: 'fixture' }, messages: [{ id: 'old', seq: 12 }], revision: 'a'.repeat(64) };
  const current = p.detail.value; let url = ''; api = async path => { url = path; return { unchanged: true }; };
  p.text.value = 'draft'; await p.refreshDetail();
  expect(url).toContain('after=12'); expect(url).toContain('revision='); expect(p.detail.value).toBe(current); expect(p.text.value).toBe('draft');
});
it('F26 a disabled subscription closes its nested order view', async () => {
  const p = setup('SubscriptionPanel.vue', { mode: 'desktop' });
  p.ordersOpen.value = true; api = async () => ({ subscription: { disabled: true }, catalog: { plans: [] } });
  await p.load(); expect(p.ordersOpen.value).toBe(false); expect(p.subscription.value.disabled).toBe(true);
});
it('F28 iOS permission acquisition starts within the click, before the settings request', async () => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'iPhone CriOS', platform: 'iPhone', maxTouchPoints: 1, serviceWorker: {} } });
  const calls: string[] = [];
  Object.assign(globalThis, { Notification: { permission: 'default', requestPermission: async () => { calls.push('permission'); return 'denied'; } } });
  api = async () => { calls.push('save'); return { settings: { enabled: true, completed: true, failed: true } }; };
  const p = setup('NotificationCenter.vue', { deviceId: '123456789', taskLabels: {}, resolveTasks: async () => {}, openTask: async () => true });
  p.loading.value = false; p.settingsReady.value = true; p.standalone.value = true; p.pushConfigured.value = true; p.vapidPublicKey.value = 'AQ';
  await p.enable(); expect(calls).toEqual(['permission','save']); expect(p.systemPushState.value).not.toBe('enabled');
});
it('F29 the model form has no backdrop dismissal', () => {
  const source = readFileSync('web/MobilePanel.vue','utf8');
  expect(source).not.toMatch(/@click.self="modelModal\s*=\s*false"/);
});
it('F28 a synchronous permission error releases the form without saving settings', async () => {
  Object.assign(globalThis, { Notification: { permission: 'default', requestPermission: () => { throw new Error('permission blocked'); } } });
  const calls: string[] = []; api = async () => { calls.push('save'); return {}; };
  const p = setup('NotificationCenter.vue', { deviceId: '123456789', taskLabels: {}, resolveTasks: async () => {}, openTask: async () => true });
  p.loading.value = false; p.settingsReady.value = true; p.standalone.value = true; p.pushConfigured.value = true; p.vapidPublicKey.value = 'AQ';
  await p.enable(); expect(p.busy.value).toBe(false); expect(p.error.value).toBe('permission blocked'); expect(calls).toEqual([]);
});
it('F23 replies preserve loaded feedback pages and their continuation', async () => {
  const p = setup('FeedbackPanel.vue', { mode: 'mobile', deviceId: '123456789' });
  p.loaded.value = true; p.detail.value = { ticket: { id: 'fixture', state: 'open' }, messages: [{ id: 'older', seq: 1 }, { id: 'recent', seq: 51 }], nextBefore: 1 }; p.text.value = 'reply';
  api = async () => ({ ticket: { id: 'fixture', state: 'open' }, messages: [{ id: 'recent', seq: 51 }, { id: 'reply', seq: 52 }], nextBefore: 51 });
  await p.send(); expect(p.detail.value.messages.map((m: any) => m.id)).toEqual(['older', 'recent', 'reply']); expect(p.detail.value.nextBefore).toBe(1);
});
it('F30 iPad desktop-mode diagnostics consistently identify iOS', () => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 } });
  const p = setup('FeedbackPanel.vue', { mode: 'mobile', deviceId: '123456789' });
  expect(p.diagnostics.value[0].system).toBe('iOS');
});

it('A06 uncertain submissions survive opening a new tab without crossing devices', () => {
  const persistent = new Map<string, string>();
  const storage = { getItem: (k: string) => persistent.get(k) ?? null, setItem: (k: string, v: string) => persistent.set(k, v), removeItem: (k: string) => persistent.delete(k) };
  Object.assign(globalThis, { localStorage: storage });
  const p = setup('MobilePanel.vue', { deviceId: '123456789' }), task = crypto.randomUUID();
  p.pendingSends[task] = { requestId: crypto.randomUUID(), text: 'uncertain fixture', attachments: [] }; p.savePendingSends();
  expect(setup('MobilePanel.vue', { deviceId: '123456789' }).pendingSends[task].text).toBe('uncertain fixture');
  expect(Object.keys(setup('MobilePanel.vue', { deviceId: '234567891' }).pendingSends)).toHaveLength(0);
  persistent.clear();
});
it('A08 revoked device switch shows the pairing view immediately', async () => {
  const p = setup('DevicesPanel.vue'); p.restoring.value = false;
  const old = { deviceId: '123456789', authorized: true }, next = { deviceId: '234567891', authorized: true };
  p.devices.value = [old, next]; p.activeId.value = old.deviceId; p.directoryOpen.value = true;
  api = async () => ({ devices: [old, { ...next, authorized: false }] }); await p.switchTo(next);
  expect(p.loginVisible.value).toBe(true);
});
it('A09 disconnected feedback ranges retain a way to fetch the middle page', () => {
  const p = setup('FeedbackPanel.vue', { mode: 'mobile', deviceId: '123456789' });
  p.detail.value = { ticket: { id: 'ticket' }, messages: Array.from({ length: 50 }, (_, i) => ({ id: String(i + 1), seq: i + 1 })) };
  p.mergeDetail({ ticket: { id: 'ticket' }, messages: Array.from({ length: 50 }, (_, i) => ({ id: String(i + 101), seq: i + 101 })), nextBefore: 101 });
  expect(p.detail.value.nextBefore).toBe(101); expect(p.detail.value.messages).toHaveLength(100);
});
it('A11 open previews adopt renewed image tokens and close ambiguous replacements', async () => {
  const props = vue.reactive({ conversationId: 'task', deviceId: '123456789', images: [{ id: 'old', alt: 'photo' }] });
  const p = setup('MessageImages.vue', props); await p.preview(props.images[0]);
  props.images = [{ id: 'new', alt: 'photo' }]; await vue.nextTick(); expect(p.selected.value.id).toBe('new');
  props.images = [{ id: 'a', alt: 'photo' }, { id: 'b', alt: 'photo' }]; await vue.nextTick(); expect(p.selected.value).toBeUndefined();
});
it('A13 matching authoritative state clears uncertain actions but not definite rejection', async () => {
  const p = setup('DesktopPanel.vue'); p.state.value = { enabled: false };
  api = async path => { if (path !== '/local/state') throw Object.assign(new Error('unknown'), { code: 'OUTCOME_UNKNOWN' }); return { enabled: true }; };
  await p.action('/local/enabled', { enabled: true }); await p.refresh(); expect(p.error.value).toBe('');
  api = async path => { if (path !== '/local/state') throw Object.assign(new Error('rejected'), { code: 'CLIENT_REJECTED' }); return { enabled: true }; };
  await p.action('/local/enabled', { enabled: true }); await p.refresh(); expect(p.error.value).toBe('rejected');
});
it('A15 open notification settings synchronize changes from another terminal', async () => {
  const p = setup('NotificationCenter.vue', { deviceId: '123456789', taskLabels: {}, resolveTasks: async () => {}, openTask: async () => true });
  p.settings.value = { enabled: true, completed: true, failed: true }; p.loading.value = false;
  api = async () => ({ settings: { enabled: false, completed: true, failed: true }, pushConfigured: false }); await p.refreshSettings(); expect(p.settings.value.enabled).toBe(false);
});
it('A16 loading older notifications accepts a decreased authoritative unread count', async () => {
  const p = setup('NotificationCenter.vue', { deviceId: '123456789', taskLabels: {}, resolveTasks: async () => {}, openTask: async () => true });
  p.loading.value = false; p.unread.value = 10; p.nextCursor.value = 'cursor'; api = async () => ({ items: [], unread: 0, nextCursor: null });
  await p.loadMore(); expect(p.unread.value).toBe(0);
});
it('A17 retention cleanup resets cached feedback content rather than retaining old screenshots', () => {
  const p = setup('FeedbackPanel.vue', { mode: 'mobile', deviceId: '123456789' });
  p.detail.value = { ticket: { id: 'ticket' }, contentCounts: { images: 1, diagnostics: 1 }, messages: [{ id: 'old', images: [{ id: 'gone' }] }] };
  p.mergeDetail({ ticket: { id: 'ticket' }, contentCounts: { images: 0, diagnostics: 0 }, messages: [{ id: 'current', images: [] }], reset: true });
  expect(p.detail.value.messages.map((m: any) => m.id)).toEqual(['current']);
});
it('A19 changed order ownership clears historical records and refund targets', async () => {
  const p = setup('OrdersPanel.vue', { mode: 'mobile', deviceId: '123456789' });
  p.historyPage.value = 20; p.data.value = { ownerRevision: 'old', orders: [], licenses: [{ id: 'old' }], refunds: [] }; p.refundTarget.value = { id: 'old' };
  api = async path => path.includes('subscription') ? { catalog: { plans: [] } } : { ownerRevision: 'new', orders: [], licenses: [], refunds: [], readiness: { channels: [] }, hasMore: false };
  await p.load(); expect(p.data.value.licenses).toEqual([]); expect(p.historyPage.value).toBe(1); expect(p.refundTarget.value).toBeUndefined();
});
it('A23 missing notification task lookup uses one targeted command, or at most three legacy pages', async () => {
  for (const capabilities of [['task-list-lookup'], []]) {
    const p = mobileFixture(capabilities); let calls = 0;
    socketReply = (c: any) => { calls++; if (capabilities.length) expect(c.params.ids).toHaveLength(1); return { conversations: [], hasMore: true, nextOffset: calls * 30 }; };
    await p.resolveNotificationTasks([crypto.randomUUID()]); expect(calls).toBe(capabilities.length ? 1 : 3);
  }
});
it('A24 ordinary order polling reads the head page only', async () => {
  const p = setup('OrdersPanel.vue', { mode: 'mobile', deviceId: '123456789' }); p.historyPage.value = 20; p.data.value = { orders: [], licenses: [], refunds: [] };
  const calls: string[] = []; api = async path => { calls.push(path); return path.includes('subscription') ? { catalog: { plans: [] } } : { orders: [], licenses: [], refunds: [], readiness: { channels: [] } }; };
  await p.load(); expect(calls).toHaveLength(2);
});
it('A28 feedback list polling updates state without overwriting a new draft', async () => {
  const p = setup('FeedbackPanel.vue', { mode: 'mobile', deviceId: '123456789' });
  api = async () => ({ rows: [{ id: 'ticket', state: 'resolved' }], total: 1 }); p.refreshView(); await vi.waitFor(() => expect(p.rows.value[0].state).toBe('resolved'));
  p.writing.value = true; p.text.value = 'draft'; api = async () => { throw new Error('must not refresh while drafting'); }; p.refreshView(); expect(p.text.value).toBe('draft');
});

