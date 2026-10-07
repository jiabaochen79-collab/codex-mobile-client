import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileScript, parse } from '@vue/compiler-sfc';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as protocol from '../src/shared/protocol.js';
import * as subscription from '../src/shared/subscription.js';
import * as commerce from '../src/shared/commerce.js';
import * as feedback from '../src/shared/feedback.js';
import * as updates from '../src/shared/updates.js';
import { conversationTurns } from '../web/conversation-model.js';
import { mergeNotificationCount } from '../web/notification-count.js';
import { useAttachments } from '../web/use-attachments.js';

const api = vi.fn(), scopes: vue.EffectScope[] = [], cleanup: (() => void)[] = [];
const client = resolve('.');
function setup(file: string, props: any = {}, mount = false) {
  const mounted: (() => void)[] = [];
  const code = transformSync(compileScript(parse(readFileSync(resolve(client, 'web', file), 'utf8')).descriptor, { id: file }).content, { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', code)((id: string) => {
    if (id === 'vue') return { ...vue, onMounted: (cb: () => void) => mounted.push(cb), onActivated() {}, onDeactivated() {}, onUnmounted: (cb: () => void) => cleanup.push(cb) };
    if (id === './api') return { api };
    if (id.endsWith('/protocol')) return protocol;
    if (id.endsWith('/subscription')) return subscription;
    if (id.endsWith('/commerce')) return commerce;
    if (id.endsWith('/feedback')) return feedback;
    if (id.endsWith('/updates')) return updates;
    if (id === './feedback-drafts') return { feedbackDraft: vi.fn().mockResolvedValue(undefined) };
    if (id === './feedback-upload') return { uploadFeedbackPictures: vi.fn().mockResolvedValue([]) };
    if (id === './use-chat-scroll') return { useChatScroll: () => ({ awayFromBottom: vue.ref(false), change: async (fn: () => void) => fn(), reset() {}, pause() {}, resume() {}, toBottom() {} }) };
    if (id === './use-attachments') return { useAttachments: () => ({ current: vue.ref([]), hasPending: vue.ref(false), restore() {}, clear() {} }) };
    if (id === './conversation-model') return { conversationTurns };
    if (id === './notification-count') return { mergeNotificationCount };
    if (id === 'qrcode') return { default: { toDataURL: async () => 'data:fixture' } };
    if (id === 'lucide-vue-next' || id.endsWith('.vue') || ['./mobile-viewport','./push-registration','./prepare-photo'].includes(id)) return {};
    throw new Error('Unexpected import: ' + id);
  }, module, module.exports);
  const scope = vue.effectScope(); scopes.push(scope);
  const result = scope.run(() => module.exports.default.setup(props, { expose() {}, emit: vi.fn() }));
  if (mount) for (const cb of mounted) cb();
  return result;
}
class Socket {
  static OPEN = 1; static latest: Socket;
  readyState = 1; frames: any[] = []; onmessage?: (event: { data: string }) => void;
  constructor() { Socket.latest = this; }
  send(text: string) { this.frames.push(JSON.parse(text)); }
  close() { this.readyState = 3; }
}
const deferred = () => { let resolve!: (value: any) => void; let reject!: (value: any) => void; const promise = new Promise<any>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
function mobile() {
  const p = setup('MobilePanel.vue', { deviceId: '123456789', deviceName: 'Fixture' });
  p.active.value = true; p.openSocket(); p.connected.value = true;
  p.status.value = { online: true, enabled: true, client: { available: true, capabilities: ['history-pages', 'conditional-read', 'activity'] }, subscription: { access: true } };
  return p;
}
beforeEach(() => {
  vi.useFakeTimers(); api.mockReset().mockResolvedValue({});
  vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('sessionStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('location', { href: 'http://127.0.0.1/?order=fixture', pathname: '/', search: '?order=fixture', origin: 'http://127.0.0.1', hash: '' }); vi.stubGlobal('history', { replaceState() {} });
  vi.stubGlobal('navigator', { userAgent: 'Fixture', platform: 'Fixture', maxTouchPoints: 0 });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {}, dispatchEvent() {} });
  vi.stubGlobal('document', { visibilityState: 'visible', querySelector: () => null, documentElement: { classList: { toggle() {}, remove() {} } }, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => { for (const cb of cleanup.splice(0)) cb(); for (const scope of scopes.splice(0)) scope.stop(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('Regression: retained early messages resolve to the authoritative completed state', () => {
  const p = mobile(), turnId = crypto.randomUUID();
  const early = { id: 'early', turnId, turnStatus: 'inProgress', role: 'user', text: 'request' };
  const final = { id: 'final', turnId, turnStatus: 'completed', role: 'assistant', phase: 'final', text: 'done' };
  const merged = p.mergeMessages([early], [final]);
  expect(conversationTurns({ busy: false, turnId: null, lastTurnId: turnId, lastTurnStatus: 'completed', messages: merged } as any)[0].status).toBe('completed');
});
it('Regression: a late read POST cannot restore obsolete unread count after a newer read broadcast', async () => {
  const p = mobile(), wait = deferred(); api.mockReturnValue(wait.promise);
  const read = p.readNotification('notice');
  Socket.latest.onmessage?.({ data: JSON.stringify({ type: 'notification-read', deviceId: '123456789', unread: 0 }) });
  expect(p.notificationUnread.value).toBe(0);
  wait.resolve({ unread: 4, throughSequence: 10 }); await read;
  expect(p.notificationUnread.value).toBe(0);
});
it('Regression: newly inserted orders re-enable pagination after the last page was loaded', async () => {
  const p = setup('OrdersPanel.vue', { mode: 'mobile', deviceId: '123456789' });
  let rows = Array.from({ length: 200 }, (_, id) => ({ id: String(id), status: 'closed' }));
  api.mockImplementation(async path => {
    if (path.includes('subscription')) return { catalog: {} };
    const page = path.includes('page=') ? Number(path.split('page=')[1]) : 1, offset = (page - 1) * 100;
    return { orders: rows.slice(offset, offset + 100), licenses: [], refunds: [], hasMore: rows.length > offset + 100, readiness: { channels: [] } };
  });
  await p.load(); await p.loadMore(); expect(p.historyPage.value).toBe(2); expect(p.hasMore.value).toBe(false);
  rows = [...Array.from({ length: 201 }, (_, id) => ({ id: 'new-' + id, status: 'closed' })), ...rows];
  await p.load(); expect(p.hasMore.value).toBe(true);
  expect(p.data.value.orders).toHaveLength(300); expect(rows).toHaveLength(401);
  await p.loadMore(); await p.loadMore(); expect(p.data.value.orders.some((o: any) => o.id === 'new-200')).toBe(true);
});
it('CONTROL order refresh preserves rows from an overlapping load-more page', async () => {
  const p = setup('OrdersPanel.vue', { mode: 'mobile', deviceId: '123456789' }), more = deferred(), info = deferred();
  p.data.value = { orders: [{ id: 'a' }], licenses: [], refunds: [], readiness: { channels: [] } }; p.hasMore.value = true;
  api.mockImplementation(path => path.includes('page=2') ? more.promise : path.includes('subscription') ? info.promise : Promise.resolve({ orders: [{ id: 'a' }], licenses: [], refunds: [], hasMore: true, readiness: { channels: [] } }));
  const fetchingMore = p.loadMore(); const refreshing = p.load(); await Promise.resolve(); await Promise.resolve();
  more.resolve({ orders: [{ id: 'b' }], licenses: [], refunds: [], hasMore: false }); await fetchingMore;
  info.resolve({ catalog: {} }); await refreshing;
  // mergeRecords preserves b, but the first-page hasMore=true is not applied at historyPage=2.
  expect(p.historyPage.value).toBe(2); expect(p.data.value.orders.map((o: any) => o.id)).toEqual(['a','b']);
});
it('Regression: selecting the empty placeholder does not submit an answer', () => {
  const p = mobile(), request = { id: 'approval', questions: [] as any[] };
  const question = { id: 'choice', question: 'Confirm?', options: [{ label: 'First' }, { label: 'Second' }] }; request.questions.push(question);
  p.chooseAnswer(request, question, { currentTarget: { value: '1' } });
  p.chooseAnswer(request, question, { currentTarget: { value: '' } });
  expect(p.answerModes[p.answerKey(request, question)]).toBe('');
  expect(p.answers.value[p.answerKey(request, question)]).toBe(''); expect(p.answersComplete(request)).toBe(false);
});
it('Regression: expired subscription safety reads restore pending rejection actions', async () => {
  const p = mobile(); p.status.value.subscription = { access: false }; p.status.value.client.capabilities.push('safety-status');
  const id = crypto.randomUUID(); p.selected.value = { id, title: 'Fixture' };
  const reading = p.read(); const command = Socket.latest.frames.find((frame: any) => frame.type === 'command');
  Socket.latest.onmessage?.({ data: JSON.stringify({ type: 'result', id: command.id, ok: true, result: { id, epoch: 'epoch', busy: true, turnId: 'turn', requests: [{ id: 'approval', kind: 'command', title: 'Approval', detail: '' }] } }) });
  await reading; expect(p.snapshot.value.requests).toHaveLength(1); expect(p.snapshot.value.requests[0].id).toBe('approval');
});
it('Regression: successful payment polling clears obsolete payment-start errors', async () => {
  const p = setup('PayApp.vue');
  api.mockRejectedValueOnce(new Error('payment entry outcome unknown')); await p.pay();
  api.mockResolvedValueOnce({ order: { status: 'paid', serviceStatus: 'active' }, readiness: { ready: true } }); await p.load();
  expect(p.order.value.status).toBe('paid'); expect(p.error.value).toBe('');
});
it('Regression: two delete clicks cannot resurrect a deleted attachment', async () => {
  const first = deferred(), second = deferred(), request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const p = useAttachments({ request, thread: () => 'task', control: () => ({ clientId: 'fixture', allowed: true }) });
  p.restore('task', [{ id: crypto.randomUUID(), name: 'fixture.txt', size: 1, mediaType: 'text/plain', offset: 1, ready: true }]);
  const item = p.current.value[0], a = p.remove(item), b = p.remove(item);
  first.resolve({ removed: true }); await a; expect(p.current.value).toHaveLength(0);
  await b; expect(request).toHaveBeenCalledTimes(1);
  expect(p.current.value).toHaveLength(0);
});


it('Regression: an open feedback detail refreshes to display a later customer-support reply', async () => {
  let replied = false;
  const ticket = { ticket: { id: 'fixture', state: 'open' }, messages: [{ id: 'question', seq: 1, text: 'question', actor: 'user' }] };
  api.mockImplementation(async path => path.endsWith('/read') ? { ok: true } : path.split('?')[0].endsWith('/fixture') ? { ...ticket, messages: replied ? [...ticket.messages, { id: 'answer', seq: 2, text: 'support reply', actor: 'admin' }] : ticket.messages } : { rows: [], total: 0 });
  const p = setup('FeedbackPanel.vue', { mode: 'mobile', deviceId: '123456789' }, true); await p.show({ id: 'fixture' });
  p.text.value = 'unsent draft'; replied = true; api.mockClear(); await vi.advanceTimersByTimeAsync(120000);
  expect(api).toHaveBeenCalled(); expect(p.detail.value.messages.map((m: any) => m.text)).toEqual(['question', 'support reply']); expect(p.text.value).toBe('unsent draft');
});

it('an older detail poll cannot replace a new reply or status response', async () => {
  const p = setup('FeedbackPanel.vue', { mode: 'mobile', deviceId: '123456789' }), wait = deferred();
  const old = { ticket: { id: 'fixture', state: 'open' }, messages: [{ id: 'old', seq: 1 }] };
  p.detail.value = old; p.text.value = 'draft'; api.mockReturnValueOnce(wait.promise);
  const reading = p.refreshDetail(); const next = { ...old, messages: [...old.messages, { id: 'new', seq: 2 }] }; p.detail.value = next;
  wait.resolve(old); await reading; expect(p.detail.value).toEqual(next); expect(p.text.value).toBe('draft'); expect(api).toHaveBeenCalledTimes(1);
});
