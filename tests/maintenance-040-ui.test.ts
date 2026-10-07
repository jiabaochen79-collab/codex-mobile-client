import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import { afterEach, expect, it } from 'vitest';
let api: (path: string) => Promise<any> = async () => ({});
const cleanup: (() => void)[] = [], scopes: vue.EffectScope[] = [];
Object.assign(globalThis, { window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, matchMedia: () => ({ matches: true }), Notification: {}, PushManager: {} }, document: { visibilityState: 'visible', querySelector: () => null, documentElement: { classList: { toggle() {}, remove() {} } }, addEventListener() {}, removeEventListener() {} }, location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1', search: '', hash: '', pathname: '/' }, history: { replaceState() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, cancelAnimationFrame() {}, innerWidth: 390, innerHeight: 844, visualViewport: { height: 844, offsetTop: 0 } });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Fixture', platform: 'Fixture', maxTouchPoints: 0, serviceWorker: { addEventListener() {}, removeEventListener() {} } } });
function setup(file: string, props: any = {}, emit: (...args: any[]) => void = () => {}) {
  const code = transformSync(compileScript(parse(readFileSync('web/' + file, 'utf8')).descriptor, { id: file }).content, { loader: 'ts', format: 'cjs', define: { 'import.meta.env.PROD': 'false' } }).code;
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', code)((id: string) => {
    if (id === 'vue') return { ...vue, onMounted() {}, onActivated() {}, onDeactivated() {}, onUnmounted: (cb: any) => cleanup.push(cb) };
    if (id === './api') return { api: (path: string) => api(path) };
    if (id.endsWith('/protocol')) return protocol; if (id.endsWith('/subscription')) return subscription;
    if (id.endsWith('/commerce')) return commerce; if (id.endsWith('/feedback')) return feedback;
    if (id.endsWith('/updates')) return updates; if (id.endsWith('/paired-devices')) return pairedDevices;
    if (id === './use-chat-scroll') return { useChatScroll: () => ({ awayFromBottom: vue.ref(false), change: async (fn: any) => fn(), reset() {}, pause() {}, resume() {}, toBottom() {}, layoutChanged() {} }) };
    if (id === './use-attachments') return { useAttachments: () => ({ current: vue.ref([]), hasPending: vue.ref(false), uploading: vue.ref(false), restore() {}, clear() {} }) };
    if (id === './conversation-model') return { conversationTurns };
    if (id === './push-registration') return { pushRegistration: async () => ({}) };
    if (id === 'qrcode') return { default: { toDataURL: async () => 'data:fixture' } };
    if (id === './resume-reload') return { installResumeReload: () => ({ ready() {}, dispose() {} }) };
    if (id === 'lucide-vue-next' || id.endsWith('.vue') || ['./mobile-viewport', './prepare-photo'].includes(id)) return {};
    throw new Error(id);
  }, module, module.exports);
  const scope = vue.effectScope(); scopes.push(scope); return scope.run(() => module.exports.default.setup(props, { expose() {}, emit }));
}
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); for (const scope of scopes.splice(0)) scope.stop(); api = async () => ({}); });
function deferred() { let resolve!: (value: any) => void; return { promise: new Promise<any>(r => resolve = r), resolve: (value: any) => resolve(value) }; }
it('B01 notification pagination retains unread events received after its snapshot', async () => {
  const p = setup('NotificationCenter.vue', { deviceId: '123456789', taskLabels: {}, resolveTasks: async () => {}, openTask: async () => true });
  p.loading.value = false; p.unread.value = 1; p.nextCursor.value = 'cursor';
  const wait = deferred(); api = async () => wait.promise; const work = p.loadMore();
  p.onIncoming({ detail: { id: 'new', deviceId: '123456789', taskId: 'task', readAt: null, createdAt: 2000, sequence: 2 } });
  wait.resolve({ items: [], unread: 1, throughSequence: 1, nextCursor: null }); await work; expect(p.unread.value).toBe(2);
});
it('B15 unmount fences in-flight notification pages and unread emissions', async () => {
  const emitted: any[] = [], p = setup('NotificationCenter.vue', { deviceId: '123456789', taskLabels: {}, resolveTasks: async () => {}, openTask: async () => true }, (...args) => emitted.push(args));
  p.loading.value = false; p.nextCursor.value = 'cursor'; const wait = deferred(); api = async () => wait.promise; const work = p.loadMore();
  for (const fn of cleanup.splice(0)) fn(); wait.resolve({ items: [], unread: 7, nextCursor: null }); await work;
  expect(emitted.some(row => row[0] === 'unread' && row[1] === 7)).toBe(false);
});
it('B02 rejects a history page requested for a previous order owner', async () => {
  const p = setup('OrdersPanel.vue', { mode: 'mobile', deviceId: '123456789' });
  p.data.value = { ownerRevision: 'old', historyRevision: 'same', orders: [], licenses: [], refunds: [] }; p.hasMore.value = true;
  const wait = deferred(); api = async path => path.includes('page=2') ? wait.promise : path.includes('subscription') ? { catalog: { plans: [] } } : { ownerRevision: 'new', historyRevision: 'same', orders: [], licenses: [], refunds: [], hasMore: false, readiness: { channels: [] } };
  const work = p.loadMore(); await p.load(); wait.resolve({ orders: [], licenses: [{ id: 'old-license' }], refunds: [], ownerRevision: 'old', hasMore: true }); await work;
  expect(p.data.value.licenses).toEqual([]); expect(p.historyPage.value).toBe(1);
});
class FakeSocket {
  static OPEN = 1; static CONNECTING = 0; static latest: FakeSocket;
  readyState = 1; frames: any[] = []; onmessage?: (v: any) => void;
  constructor() { FakeSocket.latest = this; }
  send(value: string) { this.frames.push(JSON.parse(value)); } close() { this.readyState = 3; }
  reply(frame: any, result: any) { this.onmessage?.({ data: JSON.stringify({ type: 'result', id: frame.id, result }) }); }
}
Object.assign(globalThis, { WebSocket: FakeSocket });
function mobile() {
  const p = setup('MobilePanel.vue', { deviceId: '123456789', deviceName: 'Fixture' }); p.active.value = true; p.openSocket(); p.connected.value = true;
  p.status.value = { online: true, enabled: true, client: { available: true, capabilities: ['history-pages'] }, subscription: { access: true } }; return p;
}
it('B13 enables continuation when a previously empty task list grows', async () => {
  const p = mobile(); let work = p.loadGroup(null); FakeSocket.latest.reply(FakeSocket.latest.frames.at(-1), { conversations: [], hasMore: false, nextOffset: 0 }); await work;
  work = p.loadGroup(null); FakeSocket.latest.reply(FakeSocket.latest.frames.at(-1), { conversations: Array.from({ length: 30 }, (_, i) => ({ id: randomUUID(), title: 'Fixture', updatedAt: i })), hasMore: true, nextOffset: 30 }); await work;
  expect(p.groups.recent.hasMore).toBe(true); expect(p.groups.recent.offset).toBe(30);
});
it('B14 discards a history page from the previous helper epoch and leaves it retryable', async () => {
  const p = mobile(), id = randomUUID(); p.showConversation({ id, title: 'Fixture', updatedAt: 1 });
  const work = p.read(); FakeSocket.latest.reply(FakeSocket.latest.frames.at(-1), { id, epoch: 'old', busy: false, messages: [{ id: 'current', role: 'assistant', text: 'current' }], requests: [], hasMore: true, historyCursor: 'current' }); await work;
  const older = p.loadHistory(), frame = FakeSocket.latest.frames.at(-1); p.snapshot.value = { ...p.snapshot.value, epoch: 'new' };
  FakeSocket.latest.reply(frame, { id, epoch: 'old', messages: [{ id: 'older', role: 'user', text: 'old image', images: [{ id: 'old-token', alt: 'fixture' }] }], hasMore: false }); await older;
  expect(p.snapshot.value.messages.map((m: any) => m.id)).toEqual(['current']);
});
