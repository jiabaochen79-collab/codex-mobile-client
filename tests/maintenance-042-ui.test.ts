import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as subscription from '../src/shared/subscription.js';
import * as commerce from '../src/shared/commerce.js';
import * as feedback from '../src/shared/feedback.js';
import { mergeNotificationCount } from '../web/notification-count.js';
import { afterEach, expect, it } from 'vitest';
let api: (...args: any[]) => Promise<any> = async () => ({});
let registration: () => Promise<any> = async () => ({});
const cleanups: (() => void)[] = [], scopes: vue.EffectScope[] = [];
const drafts = new Map<string, any>();
Object.assign(globalThis, { window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, matchMedia: () => ({ matches: false }) }, document: { visibilityState: 'visible', documentElement: { classList: { toggle() {}, remove() {} } }, querySelector: () => null, addEventListener() {}, removeEventListener() {} }, location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1', search: '', hash: '' }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, cancelAnimationFrame() {}, innerWidth: 390, innerHeight: 844, visualViewport: { height: 844, offsetTop: 0 } });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Fixture', platform: 'Fixture', maxTouchPoints: 0 } });
function setup(file: string, props: any = {}) {
  const code = transformSync(compileScript(parse(readFileSync('web/' + file, 'utf8')).descriptor, { id: file }).content, { loader: 'ts', format: 'cjs', define: { 'import.meta.env.PROD': 'true' } }).code;
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', code)((id: string) => {
    if (id === 'vue') return { ...vue, onMounted() {}, onActivated() {}, onDeactivated() {}, onUnmounted: (fn: any) => cleanups.push(fn) };
    if (id === './api') return { api: (...args: any[]) => api(...args) };
    if (id === 'qrcode') return { toDataURL: async () => 'fixture-image' };
    if (id.endsWith('/subscription')) return subscription;
    if (id.endsWith('/commerce')) return commerce;
    if (id.endsWith('/feedback')) return feedback;
    if (id === './resume-reload') return { installResumeReload: () => ({ ready() {}, dispose() {} }) };
    if (id === './push-registration') return { pushRegistration: () => registration() };
    if (id === './mobile-viewport') return {};
    if (id === './use-chat-scroll') return { useChatScroll: () => ({ awayFromBottom: vue.ref(false), change: async (fn: any) => fn(), pause() {}, resume() {}, reset() {}, toBottom() {}, layoutChanged() {} }) };
    if (id === './use-attachments') return { useAttachments: () => ({ current: vue.ref([]), hasPending: vue.ref(false), uploading: vue.ref(false), clear() {}, restore() {} }) };
    if (id === './notification-count') return { mergeNotificationCount };
    if (id === './feedback-drafts') return { feedbackDraft: async (key: string, value?: any) => { if (value === undefined) return drafts.get(key); if (value === null) drafts.delete(key); else drafts.set(key, structuredClone(value)); } };
    if (id === './feedback-upload') return { uploadFeedbackPictures: async (_: any, images: any) => images };
    if (id === './prepare-photo' || id === './push-registration' || id === 'lucide-vue-next' || id.endsWith('.vue')) return {};
    throw new Error(id);
  }, module, module.exports);
  const scope = vue.effectScope(); scopes.push(scope);
  return scope.run(() => module.exports.default.setup(props, { expose() {}, emit() {} }));
}
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); scopes.splice(0).forEach(scope => scope.stop()); drafts.clear(); api = async () => ({}); registration = async () => ({}); localStorage.setItem = () => {}; });
const notification = (id: string, sequence: number) => ({ id, deviceId: '123456789', taskId: 'task', turnId: 'turn', sequence, readAt: null, createdAt: sequence });
it('F01 automatic eligibility refresh preserves a definite activation error', async () => {
  const p = setup('SubscriptionPanel.vue', { mode: 'mobile', deviceId: '123456789' });
  p.catalog.value = { termsVersion: 'terms' }; p.code.value = 'CM1_' + 'a'.repeat(32); p.accepted.value = true;
  api = async () => { throw new Error('AUTHORIZATION_CODE_USED'); };
  await p.activate(); expect(p.error.value).toBe('AUTHORIZATION_CODE_USED');
  api = async () => ({ catalog: { termsVersion: 'terms' }, subscription: { access: false }, trial: { available: false } });
  p.refreshEligibility(); await Promise.resolve(); await Promise.resolve();
  expect(p.error.value).toBe('AUTHORIZATION_CODE_USED');
});
function deferred() { let resolve!: (value: any) => void; return { promise: new Promise<any>(r => resolve = r), resolve: (value: any) => resolve(value) }; }
it('feedback unread badge ignores an older background read', async () => {
  const p = setup('FeedbackButton.vue', { mode: 'mobile', deviceId: '123456789' });
  const old = deferred(); let calls = 0;
  api = async () => ++calls === 1 ? old.promise : { count: 0 };
  const first = p.refresh(); await p.refresh(); expect(p.unread.value).toBe(0);
  old.resolve({ count: 1 }); await first; expect(p.unread.value).toBe(0);
});
it('stale system-push check cannot overwrite a successful registration', async () => {
  Object.assign(window, { Notification: {}, PushManager: {} });
  Object.assign(navigator, { serviceWorker: {} });
  Object.assign(globalThis, { Notification: { permission: 'granted' } });
  const p = setup('NotificationCenter.vue', { deviceId: '123456789', taskLabels: {}, resolveTasks: async () => {}, openTask: async () => true });
  p.settings.value.enabled = true; p.pushConfigured.value = true;
  p.vapidPublicKey.value = 'AQID';
  const subscription = { endpoint: 'https://fcm.googleapis.com/fixture', options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer }, toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fixture', keys: { p256dh: 'fixture', auth: 'fixture' } }) };
  registration = async () => ({ pushManager: { getSubscription: async () => subscription } });
  const old = deferred(), queried = deferred();
  api = async path => path.endsWith('/status') ? (queried.resolve(true), old.promise) : { id: 'registered' };
  const first = p.refreshSystemPushState(); await queried.promise;
  await p.registerPush(); expect(p.systemPushState.value).toBe('enabled');
  old.resolve({ active: false }); await first;
  expect(p.systemPushState.value).toBe('enabled');
});
it('HTTP read-all remembers its read watermark for delayed rows', async () => {
  const p = setup('NotificationCenter.vue', { deviceId: '123456789', resolveTasks: async () => {}, openTask: async () => true });
  p.loading.value = false; p.items.value = [notification('one', 1)]; p.unread.value = 1;
  api = async () => ({ throughSequence: 2, readAt: 100, unread: 0 }); await p.readAll();
  p.onIncoming({ detail: notification('two', 2) });
  expect(p.unread.value).toBe(0); expect(p.items.value.find((i: any) => i.id === 'two').readAt).toBe(100);
});
it('definitive feedback conflict preserves editable draft across reopening', async () => {
  const p = setup('FeedbackPanel.vue', { mode: 'mobile', deviceId: '123456789' });
  p.loaded.value = true; p.writing.value = true; p.text.value = 'Different text in second tab';
  api = async () => { throw Object.assign(new Error('Request payload conflict'), { code: 'CONFLICT' }); };
  await p.send(); expect(p.pending.value).toBeUndefined(); expect(p.error.value).toContain('核对已有工单');
  await p.saveDraft(); p.pending.value = undefined; await p.restore(); expect(p.pending.value).toBeFalsy(); expect(p.text.value).toBe('Different text in second tab');
  expect(readFileSync('web/FeedbackPanel.vue', 'utf8')).toContain(':disabled="busy || !!pending"');
});
it('catalog polling invalidates consent when the agreed price changes', async () => {
  const p = setup('OrdersPanel.vue', { mode: 'mobile', deviceId: '123456789' });
  let price = 600, revision = 1, submitted: any;
  const info = () => ({ catalog: { plans: [{ id: 'month', priceFen: price, revision, available: true }] } });
  const orders = () => ({ ownerRevision: 'owner', historyRevision: 'history', orders: [], licenses: [], refunds: [], readiness: { ready: true, channels: ['alipay'] } });
  api = async (path, body) => {
    if (path === '/api/subscription') return info();
    if (body) { submitted = body; return { payUrl: 'http://127.0.0.1/pay', order: { id: 'order' } }; }
    return orders();
  };
  await p.load(); p.accepted.value = true; expect(p.canBuy.value).toBe(true);
  price = 1500; revision = 2; await p.load();
  expect(p.accepted.value).toBe(false); expect(p.canBuy.value).toBe(false);
  await p.create(); expect(submitted).toBeUndefined(); p.accepted.value = true; await p.create(); expect(submitted.planRevision).toBe(2);
});
it('foreground notification refresh preserves pages the reader already loaded', async () => {
  const p = setup('NotificationCenter.vue', { deviceId: '123456789', taskLabels: {}, resolveTasks: async () => {}, openTask: async () => true });
  api = async path => path.includes('/settings') ? { settings: { enabled: false, completed: true, failed: true } } : { items: [notification('one', 1)], unread: 0, throughSequence: 2, nextCursor: 'page-2' };
  await p.load(); p.items.value.push(notification('older', 0)); p.nextCursor.value = 'page-3';
  await p.load(true); expect(p.items.value.map((row: any) => row.id)).toEqual(['one', 'older']); expect(p.nextCursor.value).toBe('page-3');
});
it('HTTP single-read fences only the acknowledged notification', async () => {
  const p = setup('NotificationCenter.vue', { deviceId: '123456789', resolveTasks: async () => {}, openTask: async () => true });
  p.loading.value = false; p.items.value = [notification('one', 1), notification('two', 2)]; p.unread.value = 2;
  api = async () => ({ throughSequence: 2, readAt: 100, unread: 1 });
  await p.readOne(p.items.value[0]);
  p.onIncoming({ detail: notification('one', 1) }); p.onIncoming({ detail: notification('two', 2) });
  expect(p.items.value.find((row: any) => row.id === 'one').readAt).toBe(100);
  expect(p.items.value.find((row: any) => row.id === 'two').readAt).toBeNull(); expect(p.unread.value).toBe(1);
});
it('notification recovery keeps history visible while the request is pending', async () => {
  const p = setup('NotificationCenter.vue', { deviceId: '123456789', resolveTasks: async () => {}, openTask: async () => true });
  p.settingsReady.value = true; p.loading.value = false; p.items.value = [notification('old', 1)]; p.nextCursor.value = 'older-page';
  const head = deferred();
  api = async path => path.endsWith('/settings') ? { settings: { enabled: false } } : head.promise;
  const reading = p.load(true);
  expect(p.loading.value).toBe(false); expect(p.items.value[0].id).toBe('old');
  head.resolve({ items: [notification('new', 4)], nextCursor: 'gap-page', unread: 2, throughSequence: 4 }); await reading;
  expect(p.items.value.map((row: any) => row.id)).toEqual(['new', 'old']); expect(p.nextCursor.value).toBe('gap-page');
});
it('unchanged catalogs keep purchase consent but a channel replacement invalidates it', async () => {
  const p = setup('OrdersPanel.vue', { mode: 'mobile', deviceId: '123456789' }); let channel = 'alipay';
  api = async path => path === '/api/subscription' ? { catalog: { plans: [{ id: 'month', priceFen: 600, revision: 1, available: true }] } } : { orders: [], licenses: [], refunds: [], readiness: { ready: true, channels: [channel] } };
  await p.load(); p.accepted.value = true; await p.load(); expect(p.accepted.value).toBe(true);
  channel = 'wechat'; await p.load(); expect(p.accepted.value).toBe(false); expect(p.canBuy.value).toBe(false);
});
it('successful authorization remains visible after the code field is reset', async () => {
  const p = setup('SubscriptionPanel.vue', { mode: 'mobile', deviceId: '123456789' });
  p.catalog.value = { termsVersion: 'terms' }; p.code.value = 'CM1_' + 'a'.repeat(32); p.accepted.value = true;
  api = async () => ({ catalog: { termsVersion: 'terms' }, subscription: { access: true }, trial: { used: true } });
  await p.activate(); await vue.nextTick(); expect(p.success.value).toBe(true); expect(p.code.value).toBe('');
});
