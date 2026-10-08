import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as protocol from '../src/shared/protocol.js';
import * as subscription from '../src/shared/subscription.js';
import * as commerce from '../src/shared/commerce.js';
import { conversationTurns } from '../web/conversation-model.js';
import { mergeNotificationCount } from '../web/notification-count.js';
import { afterEach, beforeEach, expect, it } from 'vitest';

const scopes: vue.EffectScope[] = [], cleanup: (() => void)[] = [];
let api: (...args: any[]) => Promise<any> = async () => ({});
const entries = new Map<string, string>(), sessions = new Map<string, string>();
const storage = { get length() { return entries.size; }, key: (i: number) => [...entries.keys()][i] ?? null, getItem: (k: string) => entries.get(k) ?? null, setItem: (k: string, v: string) => entries.set(k, v), removeItem: (k: string) => entries.delete(k) };
Object.assign(globalThis, {
  window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) },
  document: { visibilityState: 'visible', querySelector: () => null, documentElement: { classList: { toggle() {}, remove() {} } }, addEventListener() {}, removeEventListener() {} },
  location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1', search: '', hash: '', pathname: '/', protocol: 'http:', host: '127.0.0.1' },
  history: { replaceState() {} }, localStorage: storage, sessionStorage: { getItem: (k: string) => sessions.get(k) ?? null, setItem: (k: string, v: string) => sessions.set(k, v), removeItem: (k: string) => sessions.delete(k) }, cancelAnimationFrame() {}, confirm: () => true
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Fixture', platform: 'Fixture', maxTouchPoints: 0 } });
let socketReply: (command: any) => any = () => ({});
class FixtureSocket {
  static OPEN = 1; readyState = 1; onmessage?: (event: any) => void;
  send(text: string) { const frame = JSON.parse(text); queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'result', id: frame.id, result: socketReply(frame.command) }) })); }
  close() {}
}
Object.assign(globalThis, { WebSocket: FixtureSocket });
function setup(file: string, props: any) {
  const script = compileScript(parse(readFileSync(resolve('web', file), 'utf8')).descriptor, { id: file });
  const code = transformSync(script.content, { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', code)((id: string) => {
    if (id === 'vue') return { ...vue, onMounted() {}, onActivated() {}, onDeactivated() {}, onUnmounted: (cb: any) => cleanup.push(cb) };
    if (id === './api') return { api: (...args: any[]) => api(...args) };
    if (id.endsWith('/protocol')) return protocol;
    if (id.endsWith('/subscription')) return subscription;
    if (id.endsWith('/commerce')) return commerce;
    if (id === './use-chat-scroll') return { useChatScroll: () => ({ awayFromBottom: vue.ref(false), change: async (fn: any) => fn(), reset() {}, pause() {}, resume() {}, toBottom() {} }) };
    if (id === './use-attachments') return { useAttachments: () => ({ current: vue.ref([]), hasPending: vue.ref(false), uploading: vue.ref(false), restore() {}, clear() {}, suspend() {} }) };
    if (id === './conversation-model') return { conversationTurns };
    if (id === './notification-count') return { mergeNotificationCount };
    if (id === 'lucide-vue-next' || id.endsWith('.vue') || id === './mobile-viewport') return {};
    throw new Error('Unexpected import: ' + id);
  }, module, module.exports);
  const scope = vue.effectScope(); scopes.push(scope);
  return scope.run(() => module.exports.default.setup(props, { expose() {}, emit() {} }));
}
beforeEach(() => { entries.clear(); sessions.clear(); socketReply = () => ({}); api = async () => ({}); });
afterEach(() => { for (const cb of cleanup.splice(0)) cb(); for (const scope of scopes.splice(0)) scope.stop(); });

it('logout deletes current-device pending bodies and tombstones without touching another device', () => {
  const deviceId = '123456789', taskId = crypto.randomUUID();
  const p = setup('MobilePanel.vue', { deviceId, deviceName: 'Fixture' });
  p.pendingSends[taskId] = { requestId: crypto.randomUUID(), text: 'private pending draft', message: 'unknown', attachments: [] }; p.savePendingSends(taskId);
  storage.setItem(`pending-send:${deviceId}:${crypto.randomUUID()}`, JSON.stringify({ outcome: 'succeeded' }));
  storage.setItem(`pending-send:987654321:${taskId}`, 'other device');
  p.clearNavigation(false);
  expect(storage.getItem(`pending-send:${deviceId}:${taskId}`)).toBeNull();
  expect(storage.length).toBe(1);
  expect(Object.keys(setup('MobilePanel.vue', { deviceId, deviceName: 'Fixture' }).pendingSends)).toEqual([]);
});
it('retains unconfirmed text after browser-session loss and when released to a draft', () => {
  const deviceId = '123456789', taskId = crypto.randomUUID();
  const p = setup('MobilePanel.vue', { deviceId, deviceName: 'Fixture' });
  p.selected.value = { id: taskId, title: 'Fixture' }; p.draft.value = 'important requirement';
  p.pendingSends[taskId] = { requestId: crypto.randomUUID(), text: p.draft.value, message: 'unknown', attachments: [] }; p.savePendingSends(taskId);
  sessions.clear();
  const next = setup('MobilePanel.vue', { deviceId, deviceName: 'Fixture' }); next.showConversation({ id: taskId, title: 'Fixture' });
  expect(next.draft.value).toBe('important requirement'); next.draft.value = ''; next.keepUnconfirmedDraft();
  expect(next.draft.value).toBe('important requirement'); expect(next.pendingSends[taskId]).toBeUndefined();
});
it('restores a failed send before its task is selected and preserves newer draft edits', () => {
  const p = setup('MobilePanel.vue', { deviceId: '123456789', deviceName: 'Fixture' }), taskId = crypto.randomUUID();
  const attempt = { requestId: crypto.randomUUID(), text: 'requirement', message: 'unknown', attachments: [] };
  p.pendingSends[taskId] = attempt; p.settleSend(taskId, attempt, { message: 'failed' });
  p.showConversation({ id: taskId, title: 'Fixture' }); expect(p.draft.value).toBe('requirement');
  p.pendingSends[taskId] = attempt; p.draft.value = 'newer edit'; p.keepUnconfirmedDraft(); expect(p.draft.value).toBe('newer edit');
});
it('replaces an authoritative overlapping tail after native undo without removing older history', async () => {
  const p = setup('MobilePanel.vue', { deviceId: '123456789', deviceName: 'Fixture' }), taskId = crypto.randomUUID();
  p.active.value = true; p.connected.value = true; p.status.value = { online: true, enabled: true, client: { available: true, capabilities: ['history-pages'] }, subscription: { access: true } };
  p.openSocket(); p.selected.value = { id: taskId, title: 'Fixture' };
  p.snapshot.value = { id: taskId, epoch: 'same', messages: [{ id: 'old', role: 'assistant', text: 'old' }, { id: 'overlap', role: 'assistant', text: 'kept' }, { id: 'undo-user', role: 'user', text: 'removed request' }, { id: 'undo-answer', role: 'assistant', text: 'removed answer' }], requests: [], busy: false, hasMore: true };
  socketReply = () => ({ id: taskId, epoch: 'same', messages: [{ id: 'overlap', role: 'assistant', text: 'kept' }], requests: [], busy: false, hasMore: true, historyCursor: 'overlap' });
  await p.read(); expect(p.snapshot.value.messages.map((m: any) => m.id)).toEqual(['old', 'overlap']);
});
it('keeps subscription closing enabled during polling and ignores a stale read after activation', async () => {
  let finish!: (value: any) => void;
  api = () => new Promise(resolve => finish = resolve);
  const p = setup('SubscriptionPanel.vue', { mode: 'mobile', deviceId: '123456789' });
  p.catalog.value = { plans: [], termsVersion: subscription.TERMS_VERSION };
  const polling = p.load(); expect(p.reading.value).toBe(true); expect(p.busy.value).toBe(false);
  const descriptor = parse(readFileSync(resolve('web/SubscriptionPanel.vue'), 'utf8')).descriptor;
  const script = compileScript(descriptor, { id: 'subscription' });
  expect(compileTemplate({ source: descriptor.template!.content, filename: 'SubscriptionPanel.vue', id: 'subscription', compilerOptions: { bindingMetadata: script.bindings } }).code).toMatch(/title: "关闭订阅",\s+disabled: \$setup.busy/);
  p.code.value = 'CM1_' + 'a'.repeat(32); p.accepted.value = true;
  api = async () => ({ catalog: p.catalog.value, subscription: { access: true }, trial: { used: true } });
  await p.activate(); finish({ catalog: p.catalog.value, subscription: { access: false } }); await polling;
  expect(p.subscription.value.access).toBe(true);
});
