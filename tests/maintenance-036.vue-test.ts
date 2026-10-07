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
import { mergeNotificationCount } from '../web/notification-count.js';

const client = resolve('.');
const api = vi.fn(), draft = vi.fn(), upload = vi.fn();
const scopes: vue.EffectScope[] = [];
const cleanup: (() => void)[] = [];
function setup(file: string, props: any = {}, emit = vi.fn()) {
  const path = file.startsWith('Admin') ? resolve('web', file) : resolve(client, 'web', file);
  const code = transformSync(compileScript(parse(readFileSync(path, 'utf8')).descriptor, { id: file }).content, { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', code)((id: string) => {
    if (id === 'vue') return { ...vue, onMounted() {}, onActivated() {}, onDeactivated() {}, onUnmounted: (cb: () => void) => cleanup.push(cb) };
    if (id === './api') return { api };
    if (id.endsWith('/protocol')) return protocol;
    if (id.endsWith('/subscription')) return subscription;
    if (id.endsWith('/commerce')) return commerce;
    if (id.endsWith('/feedback')) return feedback;
    if (id.endsWith('/updates')) return updates;
    if (id === './feedback-drafts') return { feedbackDraft: draft };
    if (id === './feedback-upload') return { uploadFeedbackPictures: upload };
    if (id === './use-chat-scroll') return { useChatScroll: () => ({ awayFromBottom: vue.ref(false), change: async (fn: () => void) => fn(), reset() {}, pause() {}, resume() {}, toBottom() {} }) };
    if (id === './use-attachments') return { useAttachments: () => ({ current: vue.ref([]), hasPending: vue.ref(false), restore() {}, clear() {} }) };
    if (id === './conversation-model') return { conversationTurns: () => [] };
    if (id === './notification-count') return { mergeNotificationCount };
    if (id === 'qrcode') return { default: { toDataURL: async () => 'data:fixture' } };
    if (id === 'lucide-vue-next' || id.endsWith('.vue') || ['./mobile-viewport','./push-registration','./prepare-photo'].includes(id)) return {};
    throw new Error('Unexpected import: ' + id);
  }, module, module.exports);
  const scope = vue.effectScope(); scopes.push(scope);
  return scope.run(() => module.exports.default.setup(props, { expose() {}, emit }));
}
class Socket {
  static OPEN = 1; static latest: Socket;
  readyState = 1; frames: any[] = []; onmessage?: (event: { data: string }) => void;
  constructor() { Socket.latest = this; }
  send(text: string) { this.frames.push(JSON.parse(text)); }
  close() { this.readyState = 3; }
  reply(result: any, frame = this.frames.at(-1)) { this.onmessage?.({ data: JSON.stringify({ type: 'result', id: frame.id, result }) }); }
}
const task = (title = 'Fixture') => ({ id: crypto.randomUUID(), title, cwd: '', updatedAt: Date.now() });
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(r => resolve = r); return { promise, resolve }; };
function mobile() {
  const p = setup('MobilePanel.vue', { deviceId: '123456789', deviceName: 'Fixture' });
  p.active.value = true; p.openSocket(); p.connected.value = true;
  p.status.value = { online: true, enabled: true, client: { available: true, capabilities: ['history-pages', 'conditional-read', 'activity'] }, subscription: { access: true } };
  return p;
}
const snap = (id: string, messages: string[], cursor = messages[0]) => ({ id, epoch: 'fixture', revision: 'same', busy: false, turnId: null, messages: messages.map(id => ({ id, role: 'assistant', text: id })), requests: [], settings: { mode: 'default' }, hasMore: true, historyCursor: cursor });
beforeEach(() => {
  vi.useFakeTimers(); api.mockReset().mockResolvedValue({}); draft.mockReset().mockResolvedValue(undefined); upload.mockReset().mockResolvedValue([]);
  vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('sessionStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('location', { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1', hash: '' }); vi.stubGlobal('history', { replaceState() {} });
  vi.stubGlobal('navigator', { userAgent: 'Fixture', platform: 'Fixture', maxTouchPoints: 0 });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {}, dispatchEvent() {} });
  vi.stubGlobal('document', { visibilityState: 'visible', querySelector: () => null, documentElement: { classList: { toggle() {}, remove() {} } }, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => { for (const cb of cleanup.splice(0)) cb(); for (const scope of scopes.splice(0)) scope.stop(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('B01 notification task entry initializes a usable history cursor', async () => {
  const p = mobile(), a = task(); const opening = p.openNotificationTask(a.id);
  Socket.latest.reply(snap(a.id, ['m100','m101'])); await opening;
  const count = Socket.latest.frames.length;
  const older = p.loadHistory(); expect(Socket.latest.frames.length).toBe(count + 1); expect(Socket.latest.frames.at(-1).command.params.before).toBe('m100');
  Socket.latest.reply({ ...snap(a.id, ['m98','m99']), hasMore: false }); await older;
  expect(p.snapshot.value.messages.map((m: any) => m.id)).toEqual(['m98','m99','m100','m101']);
});
it('B02 recovery fills multiple middle pages before continuing older history', async () => {
  const p = mobile(), a = task(); p.showConversation(a);
  const read = p.read(); Socket.latest.reply(snap(a.id, ['m100','m101'])); await read;
  const history = p.loadHistory(); Socket.latest.reply(snap(a.id, ['m98','m99'])); await history;
  const recovered = p.read(); Socket.latest.reply(snap(a.id, ['m300','m301'])); await recovered;
  expect(p.snapshot.value.messages.map((m: any) => m.id)).toEqual(['m98','m99','m100','m101','m300','m301']);
  expect(Socket.latest.frames.at(-1).command.params.before).toBe('m300');
  Socket.latest.reply(snap(a.id, ['m200','m299'])); await vi.waitFor(() => expect(Socket.latest.frames.at(-1).command.params.before).toBe('m200'));
  Socket.latest.reply(snap(a.id, ['m100','m101','m102'])); await vi.waitFor(() => expect(p.historyLoading.value).toBe(false));
  expect(p.snapshot.value.messages.map((m: any) => m.id)).toEqual(['m98','m99','m100','m101','m102','m200','m299','m300','m301']);
  const earlier = p.loadHistory(); expect(Socket.latest.frames.at(-1).command.params.before).toBe('m98'); Socket.latest.reply({ ...snap(a.id, ['m96','m97']), hasMore: false }); await earlier;
});
it('recovery rejects a missing continuation cursor without losing the gap', async () => {
  const p = mobile(), a = task(); p.showConversation(a); const first = p.read(); Socket.latest.reply(snap(a.id, ['old'])); await first;
  const newer = p.read(); Socket.latest.reply(snap(a.id, ['new'])); await newer;
  Socket.latest.reply({ ...snap(a.id, ['middle']), historyCursor: undefined }); await vi.waitFor(() => expect(p.historyLoading.value).toBe(false));
  expect(p.historyError.value).toContain('重试'); const retry = p.loadHistory(); expect(Socket.latest.frames.at(-1).command.params.before).toBe('new');
  Socket.latest.reply(snap(a.id, ['old','middle'])); await retry; expect(p.snapshot.value.messages.map((m: any) => m.id)).toEqual(['old','middle','new']);
});
it('a gap response from an earlier visit cannot overwrite a later visit to the same task', async () => {
  const p = mobile(), a = task(), b = task(); p.showConversation(a); const first = p.read(); Socket.latest.reply(snap(a.id, ['old'])); await first;
  const newer = p.read(); Socket.latest.reply(snap(a.id, ['new'])); await newer; const gapFrame = Socket.latest.frames.at(-1);
  p.showConversation(b); p.showConversation(a); const current = p.read(); Socket.latest.reply(snap(a.id, ['current'])); await current;
  Socket.latest.reply(snap(a.id, ['old','middle']), gapFrame); await vue.nextTick();
  expect(p.snapshot.value.messages.map((m: any) => m.id)).toEqual(['current']);
});
it('excluded B03 the normally reachable feedback overlay retains the more-menu guard', async () => {
  const p = mobile(), a = task(); p.selected.value = a; p.snapshot.value = { id: a.id, busy: false, completionId: 'complete', lastTurnId: 'turn' };
  p.moreMenu.value = true;
  vi.stubGlobal('document', { visibilityState: 'visible', querySelector: (selector: string) => selector === '.feedback-backdrop' ? {} : null, removeEventListener() {} });
  const count = Socket.latest.frames.length; await p.markSeen(); expect(Socket.latest.frames.length).toBe(count);
});
it('B04 polling refreshes earlier loaded service rows', async () => {
  const p = setup('OrdersPanel.vue', { mode: 'mobile', deviceId: '123456789' });
  p.data.value = { historyRevision: 'old', orders: [], licenses: [{ id: 'old', refunded: null }], refunds: [], readiness: { channels: [] } }; p.historyPage.value = 2;
  api.mockImplementation(async path => path === '/api/orders' ? { orders: [], licenses: [{ id: 'new' }], refunds: [], readiness: { channels: [] } } : path === '/api/orders?page=2' ? { orders: [], licenses: [{ id: 'old', refunded: 42 }], refunds: [{ id: 'refund', billing_order_id: 'old', state: 'succeeded' }] } : { catalog: {} });
  await p.load(); expect(p.data.value.licenses.find((r: any) => r.id === 'old').refunded).toBe(42); expect(api).toHaveBeenCalledWith('/api/orders?page=2', undefined, expect.anything());
});
it('B05 a late refund success preserves a different refund form', async () => {
  const p = setup('OrdersPanel.vue', { mode: 'mobile', deviceId: '123456789' }); const wait = deferred();
  p.refundTarget.value = { id: 'a' }; p.explanation.value = 'first explanation'; api.mockImplementation(path => path.includes('/refund') ? wait.promise : Promise.resolve({ orders: [], licenses: [], refunds: [], readiness: { channels: [] }, catalog: {} }));
  const sending = p.refund(); p.refundTarget.value = undefined; p.refundTarget.value = { id: 'b' }; p.explanation.value = 'new explanation';
  wait.resolve({}); await sending; expect(p.refundTarget.value.id).toBe('b'); expect(p.explanation.value).toBe('new explanation');
});
it('excluded B06 read-all preserves the cursor so history can be retried', async () => {
  const p = setup('NotificationCenter.vue', { deviceId: '123456789', taskLabels: {}, resolveTasks: async () => {}, openTask: async () => true });
  p.nextCursor.value = 'older'; p.unread.value = 1; p.items.value = [{ id: 'a', sequence: 1 }]; const wait = deferred();
  api.mockImplementation(path => path.includes('?cursor') ? wait.promise : Promise.resolve({ throughSequence: 1, unread: 0, readAt: Date.now() }));
  const loading = p.loadMore(); await p.readAll(); wait.resolve({ items: [{ id: 'b', sequence: 0 }], nextCursor: 'oldest', unread: 0 }); await loading;
  expect(p.items.value.map((r: any) => r.id)).toEqual(['a']); expect(p.nextCursor.value).toBe('older');
});
it('B08 failed notification settings cannot be edited and can be reloaded', async () => {
  const p = setup('NotificationCenter.vue', { deviceId: '123456789', taskLabels: {}, resolveTasks: async () => {}, openTask: async () => true });
  api.mockRejectedValueOnce(new Error('offline')); await p.load(); expect(p.loading.value).toBe(false); expect(p.settings.value.enabled).toBe(false);
  const template = readFileSync(resolve(client, 'web/NotificationCenter.vue'), 'utf8');
  expect(p.settingsReady.value).toBe(false); await p.enable(); expect(api).toHaveBeenCalledTimes(2);
  expect(template).toContain('@click="load(true)"');
  api.mockImplementation(async path => path.endsWith('/settings') ? { settings: { enabled: true, completed: true, failed: false }, revision: 'current' } : { items: [], unread: 0 });
  await p.load(); expect(p.settingsReady.value).toBe(true); expect(p.settings.value.failed).toBe(false);
});
it('B10 homepage recent tasks render before the full project scan', async () => {
  const p = mobile(); p.status.value.client.capabilities.push('project-navigation','live-activity'); const loading = p.loadNavigation();
  const recent = task(); expect(Socket.latest.frames.at(-1).command.method).toBe('list');
  Socket.latest.reply({ conversations: [recent], hasMore: false }); await vi.waitFor(() => expect(Socket.latest.frames.at(-1).command.method).toBe('projects'));
  expect(p.groups.recent.rows[0].id).toBe(recent.id);
  Socket.latest.reply({ projects: [{ id: 'project', running: true }] }); await vi.waitFor(() => expect(Socket.latest.frames.at(-1).command.method).toBe('list'));
  expect(Socket.latest.frames.at(-1).command.params.projectId).toBe('project');
  Socket.latest.reply({ conversations: [], hasMore: false }); await loading;
});
it('B11 corrupted screenshots unlock the form without losing its content', async () => {
  const p = setup('FeedbackPanel.vue', { mode: 'mobile', deviceId: '123456789' }); p.loaded.value = true; p.text.value = 'description';
  draft.mockResolvedValue(undefined); upload.mockRejectedValue(Object.assign(new Error('corrupt screenshot'), { code: 'UPLOAD_CORRUPT' }));
  p.images.value = [{ data: 'fixture', uploadId: 'stale' }];
  await p.send(); expect(p.pending.value).toBeUndefined(); expect(p.error.value).toContain('corrupt screenshot'); expect(p.text.value).toBe('description'); expect(p.images.value).toEqual([{ data: 'fixture' }]);
});
it('excluded B12 task-list errors are exposed by the shared visible-error computation', async () => {
  const p = mobile(); const loading = p.loadGroup('project');
  const frame = Socket.latest.frames.at(-1);
  Socket.latest.onmessage?.({ data: JSON.stringify({ type: 'result', id: frame.id, error: { code: 'INTERNAL', message: 'fixture list failure' } }) });
  await loading; expect(p.groups.project.error).toBe('fixture list failure'); expect(p.groups.project.loaded).toBe(false);
  p.expandedProjects.add('project'); p.projects.value = [{ id: 'project' }];
  expect(p.visibleError.value).toBe('fixture list failure');
});
it('B13 activity prioritizes the selected task and rotates all remaining tasks', async () => {
  const p = mobile(); const a = task(); p.selected.value = a;
  p.groups.recent = { rows: Array.from({ length: 151 }, () => task()), loaded: true };
  p.activities[a.id] = { id: a.id, running: true, unread: true };
  const reading = p.refreshActivity(); const ids = Socket.latest.frames.at(-1).command.params.ids;
  expect(ids).toHaveLength(150); expect(ids).toContain(a.id);
  Socket.latest.reply({ activities: [{ id: a.id, running: false, unread: false }] }); await reading;
  expect(p.taskState({ ...a, running: false, unread: false }).running).toBe(false);
  p.status.value.client.capabilities.push('live-activity');
  expect(p.taskState({ ...a, running: false, unread: false }).running).toBe(false);
  const second = p.refreshActivity(); const nextIds = Socket.latest.frames.at(-1).command.params.ids; Socket.latest.reply({ activities: [] }); await second;
  expect(new Set([...ids, ...nextIds]).size).toBe(152);
});
it('B14 trial eligibility refreshes after the computer reconnects and preserves entered data', async () => {
  const p = setup('SubscriptionPanel.vue', { mode: 'mobile', deviceId: '123456789' });
  api.mockResolvedValue({ catalog: {}, subscription: {}, trial: { enabled: true, used: false, available: false, reason: 'computer offline' } });
  await p.load(); api.mockResolvedValue({ catalog: {}, subscription: {}, trial: { enabled: true, used: false, available: true } });
  p.code.value = 'draft'; p.accepted.value = true; p.refreshEligibility(); await vi.waitFor(() => expect(p.trial.value.available).toBe(true));
  expect(api).toHaveBeenCalledTimes(2); expect(p.code.value).toBe('draft'); expect(p.accepted.value).toBe(true);
  const source = readFileSync(resolve(client, 'web/SubscriptionPanel.vue'), 'utf8');
  expect(source).toContain('setInterval(refreshEligibility, 15000)'); expect(source).toContain('@click="load"');
});
it('B15 feedback diagnostics include whitelisted Codex version and connection code', () => {
  const p = setup('FeedbackPanel.vue', { mode: 'desktop', deviceId: '123456789', status: { helperVersion: '0.4.35', client: { version: '26.930.41038' }, connection: 'offline', connectionError: { code: 'TLS_CERT' } } });
  expect(p.diagnostics.value[0]).toMatchObject({ helperVersion: '0.4.35', connection: 'offline' });
  expect(p.diagnostics.value[0].clientVersion).toBe('26.930.41038'); expect(p.diagnostics.value[0].errorCode).toBe('TLS_CERT');
});
it('B17 a cross-terminal receipt cannot be overwritten by an older in-flight notification list', async () => {
  const p = setup('NotificationCenter.vue', { deviceId: '123456789', taskLabels: {}, resolveTasks: async () => {}, openTask: async () => true }); const wait = deferred();
  api.mockImplementation(path => path.endsWith('/settings') ? Promise.resolve({ settings: { enabled: false, completed: true, failed: true } }) : wait.promise);
  const loading = p.load(); p.onRead({ detail: { deviceId: '123456789', id: 'a', readAt: 100, unread: 0, throughSequence: 1 } });
  wait.resolve({ items: [{ id: 'a', taskId: 'task', sequence: 1, readAt: null, createdAt: 50 }], unread: 1, throughSequence: 1 }); await loading;
  expect(p.items.value[0].readAt).toBe(100); expect(p.unread.value).toBe(0);
  api.mockImplementation(path => path.endsWith('/settings') ? Promise.resolve({ settings: { enabled: false } }) : Promise.resolve({ items: [{ id: 'b', sequence: 2, readAt: null, createdAt: 150 }], unread: 1, throughSequence: 2 }));
  await p.load(); expect(p.unread.value).toBe(1);
});
