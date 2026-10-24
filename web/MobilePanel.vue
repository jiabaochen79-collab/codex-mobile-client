<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onUnmounted, reactive, ref, watch } from 'vue';
import { ArrowDown, ArrowRight, ArrowUp, Bell, Check, ChevronDown, ChevronRight, CircleStop, Ellipsis, Folder, ListOrdered, LogOut, Menu, Monitor, Plus, RefreshCw, Search, X, File, Brain, MonitorSmartphone, Images, Camera, Ticket, CornerUpRight, Lightbulb, Shield, ShieldCheck, ShieldAlert, Target } from 'lucide-vue-next';
import { api } from './api';
import MessageContent from './MessageContent.vue';
import TurnProcess from './TurnProcess.vue';
import { conversationTurns } from './conversation-model';
import { mergeNotificationCount, type NotificationCount } from './notification-count';
import { useChatScroll } from './use-chat-scroll';
import { measureViewport, viewportSize, viewportOriginCorrection, viewportOriginHorizontalCorrection } from './mobile-viewport';
import { useAttachments } from './use-attachments';
import TaskStatus from './TaskStatus.vue';
import SubscriptionPanel from './SubscriptionPanel.vue';
import FeedbackButton from './FeedbackButton.vue';
import WebUpdateButton from './WebUpdateButton.vue';
import TrialNotice from './TrialNotice.vue';
import QueuedMessages from './QueuedMessages.vue';
import PlanRequest from './PlanRequest.vue';
import NotificationCenter from './NotificationCenter.vue';
import ClientRecoveryPanel from './ClientRecoveryPanel.vue';
import TaskGoal from './TaskGoal.vue';
import { goalPrompt } from './goal-mode';
import type { Subscription } from '../src/shared/subscription';
import type { Conversation, Snapshot, Command, Interaction, Project, ModelOption, Activity, ThreadSettings, QueuedMessage, PermissionMode, Attachment, Message } from '../src/shared/protocol';
import { commandSchema, readMethods } from '../src/shared/protocol';

const props = defineProps<{ deviceId: string; deviceName: string; obscured?: boolean }>();
const emit = defineEmits<{ devices: []; expired: [deviceId: string, message: string]; logout: [deviceId: string] }>();
const subscriptionOpen = ref(false);
const notificationOpen = ref(false); const notificationUnread = ref(0);
const recoveryOpen = ref(false); const recoveryBusy = ref(false); const recoveryError = ref('');
let recoveryRevision = 0;
let pendingRecovery: { action: 'launch' | 'pause' | 'enable'; attempts: number; recoveredAt: number } | undefined;
const notificationTasks = reactive<Record<string, Conversation>>({});
const notificationTaskIds = new Set<string>();
const notificationTaskChecked = new Map<string, number>();
let resolvingNotificationTasks: Promise<void> | undefined;
let openingNotification = false;
let notificationNavigationRevision = 0;
const session = ref({ deviceId: props.deviceId }); const active = ref(false);
const status = ref<any>({ online: false }); const connected = ref(false); const error = ref(''); const busy = ref(false);
const selected = ref<Conversation | null>(null); const snapshot = ref<Snapshot | null>(null); const draft = ref(''); const limit = ref(100);
const readError = ref(''); const navigationError = ref(''); const searchError = ref(''); const connectionError = ref('');
const readRecovering = ref(false);
const historyLoading = ref(false); const historyError = ref('');
let historyCursor: string | undefined; let historyMore = false;
let historyGaps: string[] = [];
let imageRefresh: { taskId: string; epoch: string; before: string; ids: Set<string> } | undefined;
let refreshingImages = false;
const readRetryDelays = [1000, 2000, 4000];
const retryableReadErrors = new Set(['CLIENT_REJECTED', 'CLIENT_UNAVAILABLE', 'READ_TIMEOUT', 'READ_DISCONNECTED', 'OUTCOME_UNKNOWN', 'OFFLINE', 'UNAVAILABLE', 'BUSY']);
let readFailures = 0; let readRetry: ReturnType<typeof setTimeout> | undefined;
const taskSynced = ref(false);
type PendingSend = { requestId: string; text: string; message: string; attachments: Attachment[]; goal?: boolean };
const pendingSends = reactive<Record<string, PendingSend>>({});
const checkingSend = ref(false);
function pendingSendKey(id: string) { return `pending-send:${props.deviceId}:${id}`; }
function storedPendingSend(value: string | null): PendingSend | undefined {
  try {
    const row = JSON.parse(value ?? 'null') as PendingSend & { outcome?: string };
    if (!row || row.outcome || !/^[a-f0-9-]{36}$/.test(row.requestId) || typeof row.text !== 'string' || row.text.length > 32000) return;
    return { requestId: row.requestId, text: row.text, message: '发送结果待核对，内容已保留，不会自动重发。', ...(row.goal === true ? { goal: true } : {}), attachments: Array.isArray(row.attachments) ? row.attachments.filter(a => /^[a-f0-9-]{36}$/.test(a?.id) && typeof a.name === 'string' && a.name.length <= 180 && a.ready === true && Number.isSafeInteger(a.size) && a.size > 0 && a.size <= 25 * 1024 * 1024 && a.offset === a.size && typeof a.mediaType === 'string').slice(0,5) : [] };
  } catch { return; }
}
try {
  const legacyKey = 'pending-sends:' + props.deviceId;
  const legacy = JSON.parse(localStorage.getItem(legacyKey) ?? sessionStorage.getItem(legacyKey) ?? '{}');
  for (const [id, row] of Object.entries(legacy)) if (/^[a-f0-9-]{36}$/.test(id) && storedPendingSend(JSON.stringify(row)) && localStorage.getItem(pendingSendKey(id)) === null) localStorage.setItem(pendingSendKey(id), JSON.stringify(row));
  localStorage.removeItem(legacyKey); sessionStorage.removeItem(legacyKey);
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index); const id = key?.startsWith(`pending-send:${props.deviceId}:`) ? key.slice(`pending-send:${props.deviceId}:`.length) : '';
    const row = key && storedPendingSend(localStorage.getItem(key)); if (/^[a-f0-9-]{36}$/.test(id) && row) pendingSends[id] = row;
  }
} catch {}
const pendingSend = computed(() => selected.value ? pendingSends[selected.value.id] : undefined);
const modeSynced = ref(false); const modeChanging = ref(false); let modeSyncCycle = 0;
const goalDrafts = reactive(new Set<string>());
try { const saved = JSON.parse(sessionStorage.getItem('goal-drafts:' + props.deviceId) ?? '[]'); if (Array.isArray(saved)) for (const id of saved) if (typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)) goalDrafts.add(id); } catch {}
const goalComposer = computed(() => !!selected.value && goalDrafts.has(selected.value.id));
watch(goalDrafts, () => { try { sessionStorage.setItem('goal-drafts:' + props.deviceId, JSON.stringify([...goalDrafts])); } catch {} });
const newGoal = ref(false);
const queuedMessages = ref<QueuedMessage[]>([]); const sendMenu = ref(false); let readingQueue = false;
const navigationType = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type;
const clientKey = `remote-client-id:${props.deviceId}`;
const clientId = ref<string>(crypto.randomUUID());
try {
  if (navigationType === 'reload') { clientId.value = sessionStorage.getItem(clientKey) ?? sessionStorage.getItem('remote-client-id') ?? clientId.value; sessionStorage.removeItem('remote-client-id'); }
  sessionStorage.setItem(clientKey, clientId.value);
} catch {}
const modelModal = ref(false); const modelTarget = ref<'current'|'new'>('current'); const models = ref<ModelOption[]>([]); const chosenModel = ref(''); const chosenEffort = ref(''); const editingSettings = ref<ThreadSettings>();
let editingTask: { id: string; epoch: string } | undefined;
const newModel = ref(''); const newEffort = ref(''); const terminalsModal = ref(false);
const fileInput = ref<HTMLInputElement>(); const activities = reactive<Record<string, Activity>>({}); const drafts = new Map<string,string>();
try { const saved = JSON.parse(sessionStorage.getItem('chat-drafts:' + props.deviceId) ?? '[]'); if (Array.isArray(saved)) for (const item of saved) if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') drafts.set(item[0], item[1]); } catch {}
const photoInput = ref<HTMLInputElement>(); const cameraInput = ref<HTMLInputElement>(); const attachmentPicker = ref(false);
const permissionPicker = ref(false); const fullAccessConfirm = ref(false); const permissionChanging = ref(false);
const drawer = ref(false); const moreMenu = ref(false); const search = ref(''); const searchRows = ref<Conversation[]>([]); const searchMore = ref(false); const searchLoading = ref(false);
const projects = ref<Project[]>([]); const navigationLoading = ref(false); const expandedProjects = reactive(new Set<string>());
const automaticProjects = new Set<string>();
let navigationEpoch = 0; let focusedNavigationEpoch = -1; let projectInteraction = 0;
type Group = { rows: Conversation[]; loading: boolean; loaded: boolean; hasMore: boolean; error?: string; cursor?: string; offset?: number };
const groups = reactive<Record<string, Group>>({});
const visibleErrorGroup = computed(() => [groups.recent, ...projects.value.filter(p => expandedProjects.has(p.id)).map(p => groups[p.id])].find(g => g?.error));
const visibleError = computed(() => error.value || connectionError.value || (listVisible.value ? search.value.trim() ? searchError.value : navigationError.value || visibleErrorGroup.value?.error : snapshot.value ? readError.value : ''));
function dismissError() {
  if (error.value) error.value = '';
  else if (connectionError.value) connectionError.value = '';
  else if (listVisible.value) {
    if (search.value.trim()) searchError.value = '';
    else if (navigationError.value) navigationError.value = '';
    else if (visibleErrorGroup.value) visibleErrorGroup.value.error = '';
  } else if (snapshot.value) readError.value = '';
}
const projectModal = ref(false); const projectId = ref(''); const newText = ref('');
try {
  const saved = JSON.parse(sessionStorage.getItem('new-task-draft:' + props.deviceId) ?? 'null');
  if (saved && typeof saved.text === 'string' && saved.text.length <= 32000 && typeof saved.projectId === 'string') {
    newText.value = saved.text; projectId.value = saved.projectId; newGoal.value = saved.goal === true;
    if (typeof saved.model === 'string') newModel.value = saved.model;
    if (typeof saved.effort === 'string') newEffort.value = saved.effort;
  }
} catch {}
type PendingCreate = { requestId: string; command: Extract<Command, { method: 'create' }> };
const pendingCreate = ref<PendingCreate>();
try {
  const saved = JSON.parse(localStorage.getItem('pending-create:' + props.deviceId) ?? sessionStorage.getItem('pending-create:' + props.deviceId) ?? 'null');
  const command = commandSchema.safeParse(saved?.command);
  if (/^[a-f0-9-]{36}$/.test(saved?.requestId) && command.success && command.data.method === 'create') pendingCreate.value = { requestId: saved.requestId, command: command.data };
} catch {}
const answers = ref<Record<string, string>>({}); const answerModes = reactive<Record<string, string>>({});
const customAnswers: Record<string, string> = {};
const shell = ref<HTMLElement>(); const scroll = ref<HTMLElement>(); const content = ref<HTMLElement>(); const input = ref<HTMLTextAreaElement>(); const navigation = ref<HTMLElement>();
const chatScroll = useChatScroll(scroll, content); const turns = computed(() => conversationTurns(snapshot.value));
const modalControls = 'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]';
let modalReturnFocus: HTMLElement | undefined;
function topModal() { return Array.from(shell.value?.querySelectorAll<HTMLElement>('.modal-backdrop [aria-modal="true"]') ?? []).filter(element => element.getClientRects().length).at(-1); }
function containModalFocus(event: FocusEvent) { const modal = topModal(); if (modal && !modal.contains(event.target as Node)) modal.querySelector<HTMLElement>(modalControls)?.focus(); }
function modalKeydown(event: KeyboardEvent) {
  if (event.key !== 'Tab') return;
  const modal = topModal(); if (!modal) return;
  const controls = Array.from(modal.querySelectorAll<HTMLElement>(modalControls)).filter(element => element.getClientRects().length);
  if (!controls.length) { event.preventDefault(); return; }
  const index = controls.indexOf(document.activeElement as HTMLElement);
  if (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0].focus(); }
}
watch([permissionPicker, fullAccessConfirm, attachmentPicker, projectModal, modelModal, terminalsModal, subscriptionOpen, notificationOpen, recoveryOpen], async () => {
  const previous = document.activeElement as HTMLElement;
  await nextTick(); const modal = topModal();
  if (modal) { if (!modalReturnFocus) modalReturnFocus = previous; if (!modal.contains(document.activeElement)) modal.querySelector<HTMLElement>(modalControls)?.focus(); }
  else { const target = modalReturnFocus; modalReturnFocus = undefined; if (target?.isConnected) target.focus(); }
}, { flush: 'post' });
const viewportHeight = ref('100dvh'); const viewportTop = ref('0px'); const keyboardOpen = ref(false);
const viewportProbe = ref<HTMLElement>();
let viewportWatchdog: ReturnType<typeof setInterval> | undefined;
const disposed = ref(false); let socket: WebSocket | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined; let poll: ReturnType<typeof setInterval> | undefined; let navigationPoll: ReturnType<typeof setInterval> | undefined; let searchTimer: ReturnType<typeof setTimeout> | undefined;
let viewportFrame = 0; let viewportTimers: ReturnType<typeof setTimeout>[] = [];
let viewportPass = 0;
let previousViewportBounds: DOMRect | undefined;
let reading = false; let dirty = false; let searchRevision = 0; let searchCursor: string | undefined; let searchOffset = 0;
let activateSelected = false;
let reconnectFailures = 0; let lastFrameAt = 0;
let socketHeartbeat: ReturnType<typeof setInterval> | undefined;
let changedTimer: ReturnType<typeof setTimeout> | undefined;
const pendingActivations = new Set<string>();
const pending = new Map<string, { resolve: (r: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout>; readOnly: boolean }>();
const canReach = computed(() => connected.value && status.value.online && status.value.enabled && status.value.client?.available);
const serviceActive = computed(() => status.value.subscription?.access !== false);
const canRead = computed(() => canReach.value && serviceActive.value);
const canUse = (feature: string) => !hasCapability('compatibility-checked') || hasCapability(feature);
const ownsControl = computed(() => canReach.value && (status.value.control ? status.value.control.role === 'controller' : true));
const canStop = computed(() => ownsControl.value && canUse('stop-generation'));
const canPauseGoal = computed(() => ownsControl.value && hasCapability('goal-mode') && snapshot.value?.goal?.status === 'active' && !busy.value);
const canDecline = computed(() => ownsControl.value && canUse('respond-approval'));
const canControl = computed(() => canRead.value && !recoveryBusy.value && !recoveryActive.value && (status.value.control ? status.value.control.role === 'controller' : true));
const canCreate = computed(() => canControl.value && canUse('create-tasks'));
const canApprove = computed(() => canControl.value && canUse('respond-approval'));
const hasCapability = (name:string) => status.value.client?.capabilities?.includes(name) === true;
const recoveryReason = computed(() => !connected.value || !status.value.online ? '电脑助手未连接，请等待重连' : !status.value.enabled ? '电脑端已关闭远程控制' : !hasCapability('desktop-recovery') ? '请升级电脑助手以使用客户端恢复' : !serviceActive.value ? '订阅未开通或已到期' : status.value.control?.role === 'viewer' ? '请升级电脑助手以支持所有终端操作' : '');
const recoveryActive = computed(() => ['backoff', 'launching', 'connecting'].includes(status.value.client?.recovery?.phase));
const modeReason = computed(() => {
  if (!connected.value || !status.value.online) return '电脑未连接';
  if (!status.value.enabled) return '电脑端已关闭远程控制';
  if (!status.value.client?.available) return status.value.client?.reason || 'Codex 客户端未就绪';
  if (!serviceActive.value) return '订阅未开通或已到期';
  if (!canControl.value) return '请升级电脑助手以支持所有终端操作';
  if (!hasCapability('task-mode')) return hasCapability('compatibility-checked') ? '计划接口暂不兼容，请更新助手' : '请将电脑助手升级至 0.4.4 或更新版本';
  if (modeChanging.value) return '正在切换计划模式';
  if (!modeSynced.value || !snapshot.value?.settings?.mode) return '任务模式尚未同步';
  if (busy.value) return '正在处理操作';
  return '';
});
const canToggleMode = computed(() => !modeReason.value);
const goalReason = computed(() => !canControl.value ? connectionLabel.value : !hasCapability('goal-mode') ? '请更新电脑助手以使用目标模式' : !modeReady.value ? '任务尚未同步' : busy.value ? '正在处理操作' : pendingSend.value ? '正在核对发送结果' : snapshot.value?.goal && snapshot.value.goal.status !== 'complete' ? '当前任务已有目标，请在消息中补充要求' : '');
const modeReady = computed(() => taskSynced.value && (!hasCapability('task-mode') || modeSynced.value));
const permissionNames: Record<PermissionMode | 'custom', string> = { ask: '请求批准', approve: '帮我批准', full: '完全访问', custom: '自定义' };
const permissionSynced = computed(() => !!snapshot.value?.settings && Object.prototype.hasOwnProperty.call(snapshot.value.settings, 'permission'));
const permissionReason = computed(() => {
  if (!connected.value || !status.value.online) return '电脑未连接';
  if (!status.value.enabled) return '电脑端已关闭远程控制';
  if (!status.value.client?.available) return status.value.client?.reason || 'Codex 客户端未就绪';
  if (!serviceActive.value) return '订阅未开通或已到期';
  if (!canControl.value) return '请升级电脑助手以支持所有终端操作';
  if (!hasCapability('permission-settings')) return '请更新电脑助手以更改权限';
  if (permissionChanging.value) return '正在更改任务权限';
  if (!taskSynced.value || !permissionSynced.value) return '任务权限尚未同步';
  if (busy.value) return '正在处理操作';
  return '';
});
const canChangePermission = computed(() => !permissionReason.value);
const permissionLabel = computed(() => permissionNames[snapshot.value?.settings?.permission ?? 'custom']);
const attachmentReason = computed(() => !canControl.value ? connectionLabel.value : !hasCapability('attachments') ? '请更新电脑助手以使用附件' : !snapshot.value ? '任务尚未同步' : pendingSend.value ? '正在核对发送结果' : busy.value ? '正在处理操作' : '');
const attachments = useAttachments({request,thread:()=>selected.value?.id,deviceId:props.deviceId,control:()=>({clientId:clientId.value,epoch:status.value.control?.epoch,allowed:canControl.value})});
const projectNavigation = computed(() => status.value.client?.capabilities?.includes('project-navigation') === true);
const hasDraft = computed(() => !!draft.value.trim() || !!attachments.current.value.length);
const canSend = computed(() => canControl.value && canUse('send-messages') && modeReady.value && !!snapshot.value && (!snapshot.value.busy || hasCapability('queued-send')) && !busy.value && !pendingSend.value && hasDraft.value && (!goalComposer.value || !goalReason.value && !!draft.value.trim() && draft.value.trim().length <= 4000 && snapshot.value.settings?.mode !== 'plan') && attachments.current.value.every(a=>a.attachment?.ready&&!a.error&&!a.removing&&!a.cancelled));
const canSteer = computed(() => !goalComposer.value && canControl.value && modeReady.value && !!snapshot.value?.busy && !!snapshot.value?.turnId && !busy.value && !pendingSend.value && !!draft.value.trim() && !attachments.current.value.length && hasCapability('steering-text'));
const canRemoveQueued = computed(() => connected.value && status.value.online && status.value.enabled && !busy.value && status.value.control?.role === 'controller');
watch([hasDraft, () => snapshot.value?.busy], () => { if (!hasDraft.value || !snapshot.value?.busy) sendMenu.value = false; });
const connectionLabel = computed(() => !connected.value ? '正在重连' : !status.value.online ? '电脑离线' : !status.value.enabled ? '远控已关闭' : !status.value.client?.available ? recoveryActive.value ? '正在恢复客户端' : '客户端未就绪' : !serviceActive.value ? '订阅未开通或已到期' : status.value.client?.reason ? '兼容受限' : !canControl.value ? '等待授权同步' : '已连接');
const formattedId = computed(() => String(session.value?.deviceId ?? '').replace(/(\d{3})(?=\d)/g, '$1 '));
const listVisible = computed(() => !!session.value && (!selected.value || drawer.value));
const projectNames = computed(() => new Map(projects.value.map(p => [p.id, p.name])));
const notificationTaskLabels = computed(() => Object.fromEntries(Object.values(notificationTasks).map(task => [task.id, {
  title: task.title, project: projectNames.value.get(task.projectId ?? '')
}])));

function request(command: Command, id: string = crypto.randomUUID()): Promise<any> {
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('连接尚未恢复。'));
  return new Promise((resolve, reject) => {
    const readOnly = readMethods.has(command.method);
    const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error(readOnly ? '网络响应较慢，正在重新同步。' : '未收到操作确认，请核对电脑端结果。'), { code: readOnly ? 'READ_TIMEOUT' : 'OUTCOME_UNKNOWN' })); }, readOnly ? 45000 : 25000);
    pending.set(id, { resolve, reject, timer, readOnly }); socket!.send(JSON.stringify({ type: 'command', id, command, ...(status.value.control?.epoch ? {controlEpoch:status.value.control.epoch} : {}) }));
  });
}
const notificationHeaders = () => ({ 'X-Remote-Device': props.deviceId });
let refreshingNotifications = false;
let notificationReadRevision = 0;
let notificationReceipt: NotificationCount | undefined;
const notificationEvents = new Map<string, any>();
function updateNotificationCount(result: any, fallback: number) {
  notificationReceipt = mergeNotificationCount(notificationReceipt, result);
  if (!notificationReceipt) { notificationUnread.value = fallback; return; }
  for (const [id, item] of notificationEvents) if (item.sequence <= notificationReceipt.through) notificationEvents.delete(id);
  notificationUnread.value = notificationReceipt.unread + [...notificationEvents.values()].filter(item => !item.readAt).length;
}
const incomingDuringBadge = new Map<string, any>();
const notificationReads = new Set<Map<string, any>>();
async function refreshNotificationBadge() {
  if (refreshingNotifications) return; refreshingNotifications = true; incomingDuringBadge.clear();
  const revision = notificationReadRevision;
  try {
    const result = await api('/api/notifications', undefined, notificationHeaders());
    if (revision !== notificationReadRevision) return;
    const ids = new Set((result.items ?? []).map((item: any) => item.id));
    updateNotificationCount(result, (Number(result.unread) || 0) + [...incomingDuringBadge.values()].filter(item => !item.readAt && (typeof result.throughSequence === 'number' && typeof item.sequence === 'number' ? item.sequence > result.throughSequence : !ids.has(item.id))).length);
  } catch {} finally { refreshingNotifications = false; incomingDuringBadge.clear(); }
}
async function suppressVisibleNotification(item: any) {
  if (item.status === 'decision_required') return;
  const viewed = () => active.value && document.visibilityState === 'visible' && !resultObscured.value && !document.querySelector('dialog[open]') && !chatScroll.awayFromBottom.value && selected.value?.id === item.taskId && snapshot.value && !snapshot.value.busy && snapshot.value.lastTurnId === item.turnId;
  if (!viewed()) return;
  const incoming = new Map<string, any>(); notificationReads.add(incoming);
  const revision = notificationReadRevision;
  try {
    const result = await api('/api/notifications', undefined, notificationHeaders());
    const row = (result.items ?? []).find((entry: any) => entry.id === item.id);
    if (!viewed() || revision !== notificationReadRevision) return;
    if (row && !row.readAt) await readNotification(item.id);
    else {
      const ids = new Set((result.items ?? []).map((entry: any) => entry.id));
      updateNotificationCount(result, (Number(result.unread) || 0) + [...incoming.values()].filter(entry => !entry.readAt && (typeof result.throughSequence === 'number' && typeof entry.sequence === 'number' ? entry.sequence > result.throughSequence : !ids.has(entry.id))).length);
    }
  } catch {} finally { notificationReads.delete(incoming); }
}
async function readNotification(id: string) {
  const incoming = new Map<string, any>(); notificationReads.add(incoming);
  const revision = ++notificationReadRevision;
  try {
    const result = await api(`/api/notifications/${encodeURIComponent(id)}/read`, undefined, notificationHeaders(), 'POST');
    if (revision !== notificationReadRevision) return;
    updateNotificationCount(result, typeof result.throughSequence === 'number'
      ? (Number(result.unread) || 0) + [...incoming.values()].filter(item => item.id !== id && !item.readAt && typeof item.sequence === 'number' && item.sequence > result.throughSequence).length
      : Math.max(0, notificationUnread.value - 1));
  } finally { notificationReads.delete(incoming); }
}
function knownNotificationTask(taskId: string) {
  return Object.values(groups).flatMap(group => group.rows).find(row => row.id === taskId) ?? searchRows.value.find(row => row.id === taskId) ?? notificationTasks[taskId];
}
async function resolveNotificationTasks(ids: string[]) {
  const now = performance.now();
  for (const id of ids) {
    notificationTaskIds.add(id);
    const known = Object.values(groups).flatMap(group => group.rows).find(row => row.id === id) ?? searchRows.value.find(row => row.id === id);
    if (known) { notificationTasks[id] = known; notificationTaskChecked.set(id, now); }
    else if (now - (notificationTaskChecked.get(id) ?? -Infinity) >= 60000) delete notificationTasks[id];
  }
  if (!active.value || !canRead.value || resolvingNotificationTasks || ids.every(id => notificationTasks[id])) return resolvingNotificationTasks;
  const epoch = navigationEpoch;
  resolvingNotificationTasks = (async () => {
    const attempted = new Set<string>();
    try {
      for (;;) {
        const wanted = [...notificationTaskIds].filter(id => !notificationTasks[id] && !attempted.has(id));
        if (!wanted.length) return;
        for (const id of wanted) attempted.add(id);
        let offset = 0; let cursor = hasCapability('task-list-cursor') ? 'new' : undefined;
        if (hasCapability('task-list-lookup')) {
          for (let start = 0; start < wanted.length; start += 30) {
            const result = await request({ method: 'list', params: { offset: 0, ids: wanted.slice(start, start + 30) } });
            if (!active.value || !canRead.value || epoch !== navigationEpoch) return;
            for (const task of result.conversations as Conversation[]) { notificationTasks[task.id] = task; notificationTaskChecked.set(task.id, performance.now()); }
          }
          continue;
        }
        // IDs added behind the cursor get one further pass; missing tasks never loop.
        for (let page = 0; page < 3; page++) {
          const result = await request({ method: 'list', params: { offset, ...(cursor ? { cursor } : {}) } }); cursor = result.cursor;
          if (!active.value || !canRead.value || epoch !== navigationEpoch) return;
          for (const task of result.conversations as Conversation[]) if (notificationTaskIds.has(task.id)) { notificationTasks[task.id] = task; notificationTaskChecked.set(task.id, performance.now()); }
          const next = result.nextOffset ?? offset + result.conversations.length;
          if (!result.hasMore || next <= offset || wanted.every(id => notificationTasks[id])) break;
          offset = next;
        }
      }
    } catch { /* Offline and deleted tasks retain their task-number fallback. */ }
  })();
  try { await resolvingNotificationTasks; } finally { resolvingNotificationTasks = undefined; }
}
async function openNotificationTask(taskId: string, stillRequested = () => true) {
  if (!active.value || !canRead.value) throw new Error(`暂时无法查看任务：${connectionLabel.value}。恢复连接后请重试。`);
  if (busy.value || modeChanging.value || permissionChanging.value) throw new Error('操作正在确认，请稍后查看提醒。');
  const cycle = modeSyncCycle;
  const revision = notificationNavigationRevision;
  const next: Snapshot = await request({ method: 'read', params: { id: taskId, limit: 100, activate: canControl.value } });
  if (!active.value || !canRead.value || cycle !== modeSyncCycle || revision !== notificationNavigationRevision || !stillRequested()) return false;
  if (next.id !== taskId) throw new Error('会话状态不匹配，已保留当前会话，请稍后重试。');
  const known = knownNotificationTask(taskId);
  showConversation({ ...known, id: taskId, title: next.title, cwd: known?.cwd ?? '', updatedAt: known?.updatedAt ?? Date.now() });
  await chatScroll.change(() => { historyCursor = next.historyCursor; historyMore = next.hasMore; snapshot.value = next; queuedMessages.value = next.queued ?? []; }, 'bottom');
  if (!active.value || selected.value?.id !== taskId || !stillRequested()) return false;
  modeSynced.value = !!next.settings?.mode;
  taskSynced.value = true;
  notificationTasks[taskId] = selected.value!;
  return true;
}
async function openNotificationFromUrl() {
  if (!active.value || !canRead.value || openingNotification || busy.value || modeChanging.value || permissionChanging.value) return;
  const url = new URL(location.href);
  const id = url.searchParams.get('notification');
  const targetDevice = url.searchParams.get('notificationDevice');
  if (!id || !/^[0-9a-f-]{36}$/i.test(id) || targetDevice && targetDevice !== props.deviceId) return;
  const revision = notificationNavigationRevision;
  const stillRequested = () => {
    const current = new URL(location.href);
    return revision === notificationNavigationRevision && current.searchParams.get('notification') === id && current.searchParams.get('notificationDevice') === targetDevice;
  };
  openingNotification = true;
  try {
    const { item } = await api(`/api/notifications/${encodeURIComponent(id)}`, undefined, notificationHeaders());
    if (!stillRequested() || !active.value || !canRead.value) return;
    if (!await openNotificationTask(item.taskId, stillRequested)) return;
    if (!item.readAt) await readNotification(id);
    notificationOpen.value = false;
    if (stillRequested()) {
      const current = new URL(location.href); current.searchParams.delete('notification'); current.searchParams.delete('notificationDevice');
      history.replaceState(null, '', current.pathname + current.search + current.hash);
    }
  } catch (e: any) { if (active.value && stillRequested()) error.value = e.code === 'NOT_FOUND' ? '提醒对应的任务已归档或删除，暂时无法查看。' : e.message; }
  finally { openingNotification = false; if (!stillRequested()) void openNotificationFromUrl(); }
}
watch([canRead, busy, modeChanging, permissionChanging], () => {
  void openNotificationFromUrl();
  if (notificationOpen.value) void resolveNotificationTasks([...notificationTaskIds]);
});
function pageRestored(event: PageTransitionEvent) { resyncViewport(); if (event.persisted) { navigationEpoch++; void loadNavigation(); } }
function openSocket() {
  if (disposed.value || !active.value) return;
  clearTimeout(reconnect); clearInterval(socketHeartbeat);
  const url = new URL('/ws/mobile', location.origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('clientId',clientId.value);
  url.searchParams.set('remoteDevice', props.deviceId);
  const ws = new WebSocket(url); socket = ws;
  let firstStatus = true;
  lastFrameAt = Date.now();
  socketHeartbeat = setInterval(() => {
    if (socket !== ws || document.visibilityState !== 'visible') return;
    if (Date.now() - lastFrameAt > 75000) { restartSocket(); return; }
    if (ws.readyState === WebSocket.OPEN && status.value.transport?.heartbeat) ws.send(JSON.stringify({ type: 'ping', id: crypto.randomUUID() }));
  }, 20000);
  ws.onopen = () => { if (socket === ws && active.value) connected.value = true; };
  ws.onmessage = event => {
    if (socket !== ws) return;
    let m: any; try { m = JSON.parse(event.data); } catch { return; }
    lastFrameAt = Date.now();
    if (m.type === 'status') {
      const becameReady = !status.value.client?.available || !status.value.online || status.value.subscription?.access === false && m.subscription?.access === true;
      status.value = m;
      recoveryRevision++;
      const recovery = m.client?.recovery;
      if (pendingRecovery && recovery && (pendingRecovery.action === 'launch' ? recovery.attempts > pendingRecovery.attempts || (recovery.recoveredAt ?? 0) > pendingRecovery.recoveredAt : recovery.autoEnabled === (pendingRecovery.action === 'enable'))) { pendingRecovery = undefined; recoveryError.value = ''; }
      connectionError.value = '';
      if (firstStatus || becameReady || !canReach.value) invalidateMode();
      reconnectFailures = 0;
      if (m.enabled && m.client?.available && (firstStatus || becameReady || !groups.recent?.loaded)) { if (selected.value) void read(activateSelected && canControl.value); if (listVisible.value) void loadNavigation(); }
      if (firstStatus || becameReady) { void refreshNotificationBadge(); void openNotificationFromUrl(); void reconcileSends(); }
      firstStatus = false;
    } else if (m.type === 'result') {
      const p = pending.get(m.id); if (!p) { const attempt = Object.entries(pendingSends).find(([, value]) => value.requestId === m.id); if (attempt && !['OUTCOME_UNKNOWN', 'INTERNAL'].includes(m.error?.code)) settleSend(attempt[0], attempt[1], m.error); return; } pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code })); else p.resolve(m.result);
    } else if (m.type === 'notification-read' && m.deviceId === props.deviceId) {
      notificationReadRevision++;
      updateNotificationCount(m, Math.max(0, Number(m.unread) || 0));
      window.dispatchEvent(new CustomEvent('remote-notification-read', { detail: m }));
    } else if (m.type === 'notification') {
      const item = m.notification;
      if (item?.deviceId === props.deviceId) {
        if (refreshingNotifications) incomingDuringBadge.set(item.id, item);
        for (const incoming of notificationReads) incoming.set(item.id, item);
        if (!notificationEvents.has(item.id) && (!notificationReceipt || item.sequence > notificationReceipt.through)) { notificationEvents.set(item.id, item); notificationUnread.value += item.readAt ? 0 : 1; }
        window.dispatchEvent(new CustomEvent('remote-notification', { detail: item }));
        setTimeout(() => { void suppressVisibleNotification(item); }, 200);
      }
    } else if (m.type === 'changed') {
      if ((m.conversationIds ?? [m.conversationId]).includes(selected.value?.id)) dirty = true;
      changedTimer ??= setTimeout(() => { changedTimer = undefined; if (dirty && !reading) { dirty = false; void read(); } if (listVisible.value) void refreshActivity(); }, 250);
    }
  };
  ws.onclose = event => {
    if (socket !== ws) return; clearInterval(socketHeartbeat); connected.value = false; invalidateMode();
    // Discard navigation failures from the closed connection, just like task reads.
    navigationEpoch++; searchRevision++; searchLoading.value = false;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error(p.readOnly ? '连接已中断，正在重新同步。' : '连接已中断，请核对原会话，勿重复提交。'), { code: p.readOnly ? 'READ_DISCONNECTED' : 'OUTCOME_UNKNOWN' })); } pending.clear();
    if (disposed.value || !active.value) return;
    if (event.code === 4002) { clientId.value=crypto.randomUUID();try { sessionStorage.setItem(clientKey,clientId.value); } catch {} reconnect=setTimeout(openSocket,500);return; }
    if (event.code === 4004) connectionError.value = '已达到 3 个在线终端，请关闭一个页面；正在自动重试连接。';
    if ([4001, 4003, 4005].includes(event.code)) {
      error.value = event.code === 4005 ? '该设备已被管理员封禁，请联系运营方。' : event.code === 4003 ? '设备正由另一台手机控制，请更新电脑助手。' : '授权已失效，请使用当前连接密码重新连接。';
      if (event.code === 4001 || event.code === 4005) { clearNavigation(true); emit('expired', props.deviceId, error.value); } return;
    }
    reconnect = setTimeout(openSocket, Math.min(15000, 1000 * 2 ** Math.min(++reconnectFailures, 4)) + Math.floor(Math.random() * 500));
  };
}
function group(key: string) { groups[key] ??= { rows: [], loading: false, loaded: false, hasMore: false }; return groups[key]; }
async function loadGroup(id: string | null, append = false) {
  if (!canRead.value) return;
  const state = group(id ?? 'recent'); if (state.loading) return; state.loading = true;
  const epoch = navigationEpoch;
  try {
    const rows: Conversation[] = []; let hasMore = false, reset = false; let cursor = hasCapability('task-list-cursor') ? append ? state.cursor ?? 'new' : 'new' : undefined;
    let offset = append ? state.offset ?? state.rows.length : 0;
    const target = append ? 30 : Math.max(30, state.rows.length);
    do {
      const params = { offset, ...(cursor ? { cursor } : {}), ...(projectNavigation.value ? { projectId: id } : {}) };
      const r = await request({ method: 'list', params }); cursor = r.cursor; rows.push(...r.conversations); hasMore = r.hasMore;
      if (r.reset) { reset = true; rows.splice(0, rows.length - r.conversations.length); }
      const next = r.nextOffset ?? offset + r.conversations.length; if (next <= offset && !r.reset) break; offset = next;
      if (r.conversations.length < 30) break;
    } while (hasMore && rows.length < target);
    if (groups[id ?? 'recent'] !== state || epoch !== navigationEpoch) return;
    const ids = new Set(rows.map(row => row.id));
    state.rows = append && !reset ? [...state.rows.filter(row => !ids.has(row.id)), ...rows] : rows;
    state.cursor = cursor; state.offset = offset; state.hasMore = hasMore;
    state.loaded = true; state.error = '';
    for (const row of rows) if (activities[row.id]) activities[row.id] = { ...activities[row.id], running: row.running === true, unread: row.unread === true };
  } catch (e: any) { if (groups[id ?? 'recent'] === state && epoch === navigationEpoch) state.error = e.message; } finally { state.loading = false; }
}
async function loadNavigation() {
  if (!canRead.value || navigationLoading.value) return; navigationLoading.value = true;
  const epoch = navigationEpoch; const interaction = projectInteraction;
  try {
    await loadGroup(null); if (epoch !== navigationEpoch) return;
    if (projectNavigation.value) {
      const r = await request({ method: 'projects', params: {} }); if (epoch !== navigationEpoch) return; projects.value = r.projects;
      if (focusedNavigationEpoch !== epoch) {
        const running = new Set(projects.value.filter(project => project.running).map(project => project.id));
        if (!running || epoch !== navigationEpoch) return;
        if (interaction === projectInteraction) {
          for (const id of automaticProjects) if (!running.has(id)) { expandedProjects.delete(id); automaticProjects.delete(id); }
          for (const project of projects.value) if (running.has(project.id) && !expandedProjects.has(project.id)) { expandedProjects.add(project.id); automaticProjects.add(project.id); }
        }
        focusedNavigationEpoch = epoch;
      }
      for (const id of expandedProjects) if (projects.value.some(p => p.id === id)) await loadGroup(id);
    }
    if (search.value.trim()) await runSearch();
    if (epoch === navigationEpoch) navigationError.value = '';
  } catch (e: any) { if (epoch === navigationEpoch) navigationError.value = e.message; }
  finally { navigationLoading.value = false; if (epoch !== navigationEpoch && !disposed.value && document.visibilityState === 'visible' && canRead.value) void loadNavigation(); }
}
function refreshPage() {
  if (busy.value || recoveryBusy.value || modeChanging.value || attachments.hasPending.value) { error.value = '请先完成当前操作并发送或移除待发送附件，再刷新网页。'; return; }
  if (selected.value) drafts.set(selected.value.id, draft.value);
  try {
    sessionStorage.setItem('chat-drafts:' + props.deviceId, JSON.stringify([...drafts]));
    sessionStorage.setItem('new-task-draft:' + props.deviceId, JSON.stringify({ text: newText.value, projectId: projectId.value, model: newModel.value, effort: newEffort.value, goal: newGoal.value }));
  } catch { error.value = '草稿保存失败，未刷新网页。'; return; }
  location.reload();
}
async function toggleProject(id: string) { projectInteraction++; automaticProjects.delete(id); if (expandedProjects.has(id)) expandedProjects.delete(id); else { expandedProjects.add(id); await loadGroup(id); } }
async function runSearch(append = false) {
  if (!canRead.value) { searchLoading.value = false; return; }
  const query = search.value.trim(); const revision = ++searchRevision;
  if (!query) { searchRows.value = []; searchMore.value = false; searchLoading.value = false; searchError.value = ''; return; }
  if (!projectNavigation.value) { searchRows.value = group('recent').rows.filter(c => c.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())); searchLoading.value = false; searchMore.value = false; searchError.value = ''; return; }
  searchLoading.value = true;
  try {
    const rows: Conversation[] = []; const target = append ? 30 : Math.max(30, searchRows.value.length); let hasMore = false; let cursor = hasCapability('task-list-cursor') ? append ? searchCursor ?? 'new' : 'new' : undefined;
    let offset = append ? searchOffset : 0;
    do {
      const result = await request({ method: 'list', params: { offset, query, ...(cursor ? { cursor } : {}) } });
      if (revision !== searchRevision || search.value.trim() !== query) return;
      if (result.reset) { append = false; rows.length = 0; } cursor = result.cursor; rows.push(...result.conversations); hasMore = result.hasMore;
      const next = result.nextOffset ?? offset + result.conversations.length; if (!result.reset && next <= offset) break; offset = next;
    } while (hasMore && rows.length < target);
    searchRows.value = append ? [...searchRows.value, ...rows] : rows; searchCursor = cursor; searchOffset = offset; searchMore.value = hasMore; searchError.value = '';
  } catch (e: any) { if (revision === searchRevision) searchError.value = e.message; }
  finally { if (revision === searchRevision) searchLoading.value = false; }
}
watch(search, () => { clearTimeout(searchTimer); searchRevision++; searchRows.value = []; searchMore.value = false; searchLoading.value = !!search.value.trim(); searchError.value = ''; searchTimer = setTimeout(() => { void runSearch(); }, 200); });
async function select(conversation: Conversation) {
  if (!canRead.value) { subscriptionOpen.value = !serviceActive.value; return; }
  cancelNotificationNavigation();
  showConversation(conversation, true); await read(true);
}
function cancelNotificationNavigation() {
  notificationNavigationRevision++;
  const url = new URL(location.href);
  if (!url.searchParams.has('notification')) return;
  // A pending notification must not override a newer explicit task action.
  url.searchParams.delete('notification'); url.searchParams.delete('notificationDevice');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}
function showConversation(conversation: Conversation, activate = false) {
  resetReadRecovery();
  historyCursor = undefined; historyMore = false; historyGaps = []; historyError.value = '';
  imageRefresh = undefined;
  modelModal.value = false; editingTask = undefined; permissionPicker.value = false; fullAccessConfirm.value = false;
  activateSelected = activate; pendingActivations.clear();
  attachmentPicker.value = false;
  for (const key of Object.keys(answers.value)) delete answers.value[key]; for (const key of Object.keys(answerModes)) delete answerModes[key]; for (const key of Object.keys(customAnswers)) delete customAnswers[key];
  invalidateMode();
  queuedMessages.value = []; sendMenu.value = false;
  if(selected.value)drafts.set(selected.value.id,draft.value);
  selected.value = conversation; drawer.value = false; moreMenu.value = false; snapshot.value = null; readError.value = ''; error.value = ''; limit.value = 100; draft.value = drafts.get(conversation.id) ?? pendingSends[conversation.id]?.text ?? ''; chatScroll.reset();
  if (pendingSends[conversation.id]) attachments.restore(conversation.id, pendingSends[conversation.id].attachments);
}
function resetReadRecovery() { clearTimeout(readRetry); readRetry = undefined; readFailures = 0; readRecovering.value = false; }
function retryRead(activate = false) { resetReadRecovery(); readError.value = ''; void read(activate); }
async function read(activate = false) {
  if (!selected.value) return;
  if (activate && canControl.value) pendingActivations.add(selected.value.id);
  if (!canReach.value) { void readQueue(); return; }
  if (!serviceActive.value) {
    if (reading || !hasCapability('safety-status')) return; reading = true;
    const id = selected.value.id; const cycle = modeSyncCycle;
    try { const state = await request({ method: 'safety.status', params: { id } }); if (active.value && cycle === modeSyncCycle && state.id === id && selected.value?.id === id) { if (!snapshot.value) snapshot.value = { id, title: selected.value.title, epoch: state.epoch, busy: state.busy, turnId: state.turnId, messages: [], requests: state.requests ?? [], hasMore: false }; else { snapshot.value.busy = state.busy; snapshot.value.turnId = state.turnId; snapshot.value.epoch = state.epoch; snapshot.value.requests = state.requests ?? []; } } }
    catch { /* Keep the last known stop target if the desktop is unavailable. */ }
    finally { reading = false; }
    return;
  }
  if (readRetry) return;
  if (reading) { dirty = true; return; } reading = true;
  const id = selected.value.id; const initial = !snapshot.value; const cycle = modeSyncCycle;
  const activateTask=pendingActivations.has(id) && canControl.value;
  try { const next = await request({ method: 'read', params: { id, limit: limit.value, ...(hasCapability('multi-terminal') ? {activate:activateTask} : {}), ...(hasCapability('conditional-read') && modeSynced.value && snapshot.value?.revision ? { ifRevision: snapshot.value.revision } : {}) } }); if (next.id !== id) throw new Error('会话状态不匹配，已保留当前会话，请稍后重试。'); if (selected.value?.id === id && cycle === modeSyncCycle) { pendingActivations.delete(id); resetReadRecovery(); readError.value = ''; if (!next.notModified) await chatScroll.change(() => { if (hasCapability('history-pages')) {
      const previous = snapshot.value?.messages ?? [];
      if (snapshot.value && snapshot.value.epoch !== next.epoch) {
        const freshIds = new Set(next.messages.map((message: Message) => message.id));
        const staleImages = previous.filter(message => message.images?.length && !freshIds.has(message.id));
        imageRefresh = staleImages.length && next.historyCursor ? { taskId: id, epoch: next.epoch, before: next.historyCursor, ids: new Set(staleImages.map(message => message.id)) } : undefined;
      }
      if (!previous.length || !next.hasMore) { historyCursor = next.historyCursor; historyMore = next.hasMore; if (!next.hasMore) { historyGaps = []; imageRefresh = undefined; } }
      else if (next.hasMore && next.historyCursor && next.messages.length && !next.messages.some((message: Message) => previous.some(old => old.id === message.id)) && !historyGaps.includes(next.historyCursor)) historyGaps.push(next.historyCursor);
      next.messages = mergeMessages(previous, next.messages, !next.hasMore, true); next.hasMore = historyMore || historyGaps.length > 0;
    } snapshot.value = next; queuedMessages.value = next.queued ?? []; }, initial ? 'bottom' : 'auto'); if (!modeChanging.value && cycle === modeSyncCycle) { modeSynced.value = !!snapshot.value?.settings?.mode; taskSynced.value = true; } if (historyGaps.length && !historyError.value) void loadHistory(); void refreshHistoryImages(); void markSeen(); void reconcileSends(); } }
  catch (e: any) {
    if (selected.value?.id !== id || cycle !== modeSyncCycle) return;
    if (e.code === 'NOT_FOUND') {
      resetReadRecovery();
      for (const state of Object.values(groups)) state.rows = state.rows.filter(c => c.id !== id);
      searchRows.value = searchRows.value.filter(c => c.id !== id);
      selected.value = null; snapshot.value = null; drawer.value = false; moreMenu.value = false;
      error.value = '会话已归档或删除，已从列表移除。'; void loadNavigation();
    } else {
      modeSynced.value = false; taskSynced.value = false;
      if (e.code === 'CLIENT_UNAVAILABLE' && activateSelected && canControl.value) pendingActivations.add(id);
      const delay = retryableReadErrors.has(e.code) ? readRetryDelays[readFailures++] : undefined;
      readRecovering.value = delay !== undefined;
      if (delay !== undefined) {
        readError.value = '';
        readRetry = setTimeout(() => {
          readRetry = undefined;
          if (active.value && selected.value?.id === id && canRead.value && document.visibilityState === 'visible') void read();
        }, delay);
      } else readError.value = e.code === 'CLIENT_REJECTED' ? '会话暂时读取失败，稍后会自动重试。' : e.message;
    }
  } finally { reading = false; if (dirty) { dirty = false; void read(); } }
}
function mergeMessages(previous: Message[], incoming: Message[], complete = false, tail = false) {
  if (complete) return incoming;
  if (tail) {
    const incomingIds = new Set(incoming.map(message => message.id));
    const boundary = previous.findIndex(message => incomingIds.has(message.id));
    if (boundary >= 0) return previous.slice(0, boundary).concat(incoming);
  }
  const updates = new Map(incoming.map(message => [message.id, message]));
  const ids = new Set(previous.map(message => message.id));
  return previous.map(message => updates.get(message.id) ?? message).concat(incoming.filter(message => !ids.has(message.id)));
}
async function refreshHistoryImages() {
  const refresh = imageRefresh, cycle = modeSyncCycle;
  if (!refresh || refreshingImages || !canRead.value) return;
  refreshingImages = true;
  try {
    while (imageRefresh === refresh && refresh.ids.size) {
      const page = await request({ method: 'read', params: { id: refresh.taskId, limit: 100, before: refresh.before } });
      if (cycle !== modeSyncCycle || snapshot.value?.id !== refresh.taskId || page.epoch !== refresh.epoch || imageRefresh !== refresh) return;
      if (page.id !== refresh.taskId || page.hasMore && (!page.messages.length || !page.historyCursor || page.historyCursor === refresh.before)) throw new Error('历史图片状态暂未同步。');
      await chatScroll.change(() => {
        const updated = new Map<string, Message>(page.messages.map((message: Message) => [message.id, message]));
        snapshot.value!.messages = snapshot.value!.messages.map(message => updated.get(message.id) ?? message);
        for (const message of page.messages) refresh.ids.delete(message.id);
      }, 'preserve');
      if (!page.hasMore || !page.historyCursor) break;
      refresh.before = page.historyCursor;
    }
    if (imageRefresh === refresh) imageRefresh = undefined;
  } catch { /* Retry token refresh after the next successful task read. */ }
  finally { refreshingImages = false; }
}
async function loadHistory() {
  const id = selected.value?.id; if (!id || !canRead.value || historyLoading.value) return;
  if (!hasCapability('history-pages')) {
    if (limit.value >= 500) { historyError.value = '请升级电脑助手以继续加载历史消息。'; return; }
    limit.value += 100; await read(); return;
  }
  const gap = historyGaps[0]; const before = gap ?? historyCursor; if (!before) return;
  const cycle = modeSyncCycle, epoch = snapshot.value?.epoch; historyLoading.value = true; historyError.value = '';
  try {
    const page = await request({ method: 'read', params: { id, limit: 100, before } });
    if (!active.value || cycle !== modeSyncCycle || snapshot.value?.id !== id || snapshot.value.epoch !== epoch || page.epoch !== epoch || (gap ? historyGaps[0] !== gap : historyCursor !== before)) return;
    if (page.id !== id || page.hasMore && (!page.messages.length || !page.historyCursor || page.historyCursor === before)) throw new Error('历史消息未能继续加载，请重试。');
    await chatScroll.change(() => {
      if (gap) {
        const previous = snapshot.value!.messages; const ids = new Set(previous.map(message => message.id));
        const index = previous.findIndex(message => message.id === gap);
        if (index < 0) throw new Error('历史位置已变化，请重新读取会话。');
        const updates = new Map<string, Message>(page.messages.map((message: Message) => [message.id, message]));
        const retained = previous.map(message => updates.get(message.id) ?? message);
        snapshot.value!.messages = [...retained.slice(0, index), ...page.messages.filter((message: Message) => !ids.has(message.id)), ...retained.slice(index)];
        if (!page.hasMore || page.messages.some((message: Message) => ids.has(message.id))) historyGaps.shift();
        else historyGaps[0] = page.historyCursor;
      } else { snapshot.value!.messages = mergeMessages(page.messages, snapshot.value!.messages); historyCursor = page.historyCursor; historyMore = page.hasMore; }
      snapshot.value!.hasMore = historyMore || historyGaps.length > 0;
    }, 'preserve');
  } catch (e: any) { if (cycle === modeSyncCycle && selected.value?.id === id) historyError.value = e.message; }
  finally { historyLoading.value = false; if (cycle === modeSyncCycle && historyGaps.length && !historyError.value && canRead.value) void loadHistory(); }
}
async function readQueue() {
  const id = selected.value?.id; if (!id || readingQueue || !hasCapability('queued-send') || !connected.value || !status.value.online || !status.value.enabled) return;
  const cycle = modeSyncCycle;
  readingQueue = true; try { const result = await request({ method: 'queue.list', params: { id } }); if (active.value && selected.value?.id === id && cycle === modeSyncCycle && JSON.stringify(result.queued) !== JSON.stringify(queuedMessages.value)) await chatScroll.change(() => { queuedMessages.value = result.queued; }); } catch {} finally { readingQueue = false; }
}
async function queueAction(queuedId: string, action: 'remove' | 'resume') {
  const id = selected.value?.id; if (!id) return;
  if (action === 'remove' && canRemoveQueued.value) {
    if (await perform({ method: 'queue.remove', params: { id, queuedId } }) && selected.value?.id === id) await chatScroll.change(() => { queuedMessages.value = queuedMessages.value.filter(item => item.id !== queuedId); });
  }
  else if (action === 'resume' && canControl.value && modeReady.value && !busy.value && snapshot.value) await perform({ method: 'queue.resume', params: { id, queuedId, epoch: snapshot.value.epoch } });
  await readQueue();
}
function queueResized() { void nextTick(chatScroll.layoutChanged); }
function savePendingSends(id?: string) {
  if (selected.value) drafts.set(selected.value.id, draft.value);
  sessionStorage.setItem('chat-drafts:' + props.deviceId, JSON.stringify([...drafts]));
  if (id && pendingSends[id]) localStorage.setItem(pendingSendKey(id), JSON.stringify(pendingSends[id]));
}
function clearPendingSend(id: string, attempt: PendingSend, outcome: 'succeeded' | 'failed' | 'released') {
  if (pendingSends[id]?.requestId !== attempt.requestId) return;
  try { const saved = JSON.parse(localStorage.getItem(pendingSendKey(id)) ?? 'null'); if (saved?.requestId === attempt.requestId) localStorage.setItem(pendingSendKey(id), JSON.stringify({ requestId: attempt.requestId, outcome })); } catch {}
  delete pendingSends[id]; try { savePendingSends(); } catch {}
}
function syncPendingSend(event: StorageEvent) {
  const prefix = `pending-send:${props.deviceId}:`; if (!event.key?.startsWith(prefix)) return;
  const id = event.key.slice(prefix.length); if (!/^[a-f0-9-]{36}$/.test(id)) return;
  if (event.newValue === null) { delete pendingSends[id]; return; }
  const saved = storedPendingSend(event.newValue);
  if (saved) { pendingSends[id] = saved; return; }
  try {
    const result = JSON.parse(event.newValue ?? 'null'), attempt = pendingSends[id];
    if (attempt?.requestId !== result?.requestId) return;
    if (result.outcome === 'succeeded') settleSend(id, attempt);
    else if (result.outcome === 'failed' || result.outcome === 'released') delete pendingSends[id];
  } catch {}
}
function settleSend(id: string, attempt: PendingSend, failure?: { message: string }) {
  if (!attempt || pendingSends[id]?.requestId !== attempt.requestId) return;
  if (!failure) {
    if (attempt.goal && (selected.value?.id === id && draft.value === attempt.text || drafts.get(id) === attempt.text)) goalDrafts.delete(id);
    if (selected.value?.id === id && draft.value === attempt.text) draft.value = '';
    if (drafts.get(id) === attempt.text) drafts.delete(id);
    attachments.clear(id);
  } else { recoverPendingDraft(id, attempt); if (selected.value?.id === id) error.value = failure.message; }
  clearPendingSend(id, attempt, failure ? 'failed' : 'succeeded');
  const awaiting = pending.get(attempt.requestId);
  if (awaiting) { pending.delete(attempt.requestId); clearTimeout(awaiting.timer); if (failure) awaiting.reject(Object.assign(new Error(failure.message), { code: 'SEND_REJECTED' })); else awaiting.resolve({ accepted: true }); }
}
async function reconcileSends() {
  if (checkingSend.value || !connected.value || !status.value.online || !status.value.enabled || !hasCapability('command-status')) return;
  checkingSend.value = true;
  try {
    for (const [id, attempt] of Object.entries(pendingSends)) {
      const result = await request({ method: 'command.status', params: { id, requestId: attempt.requestId } });
      if (result.state === 'succeeded') settleSend(id, attempt);
      else if (result.state === 'failed' && result.error?.message) settleSend(id, attempt, result.error);
    }
  } catch {} finally { checkingSend.value = false; }
}
function recoverPendingDraft(id: string, attempt: PendingSend) {
  if (attempt.goal && (!drafts.get(id) || drafts.get(id) === attempt.text)) goalDrafts.add(id);
  if (selected.value?.id === id && !draft.value) draft.value = attempt.text;
  if (!drafts.get(id)) drafts.set(id, attempt.text);
  attachments.restore(id, attempt.attachments);
}
function keepUnconfirmedDraft() {
  const id = selected.value?.id;
  if (!id || busy.value || !pendingSends[id] || !confirm('请先核对电脑端及待发送队列。保留为草稿后再次发送，可能重复执行；确定已完成核对？')) return;
  recoverPendingDraft(id, pendingSends[id]);
  clearPendingSend(id, pendingSends[id], 'released');
}
async function perform(command: Command) {
  busy.value = true; error.value = '';
  const requestId = crypto.randomUUID();
  let sendAttempt: PendingSend | undefined;
  try {
    if (command.method === 'send') {
      const saved = storedPendingSend(localStorage.getItem(pendingSendKey(command.params.id)));
      if (saved) { pendingSends[command.params.id] = saved; return false; }
      sendAttempt = { requestId, text: draft.value, message: '正在等待电脑确认发送，内容已保留。', ...(goalComposer.value ? { goal: true } : {}), attachments: attachments.current.value.flatMap(item => item.attachment ? [item.attachment] : []) };
      pendingSends[command.params.id] = sendAttempt;
      try { savePendingSends(command.params.id); }
      catch { throw new Error('无法保存发送确认记录，本次未发送。草稿和附件已保留，请检查浏览器存储权限或释放空间，恢复后再次点击发送。'); }
    }
    const result = await request(command, requestId);
    if (command.method === 'goal.pause' && result.accepted && snapshot.value?.id === command.params.id) snapshot.value.goal = result.goal;
    if (command.method === 'send' && sendAttempt) settleSend(command.params.id, sendAttempt);
    return true;
  }
  catch (e: any) {
    if (command.method === 'send' && ['OUTCOME_UNKNOWN', 'INTERNAL'].includes(e.code)) { const attempt = pendingSends[command.params.id]; if (attempt?.requestId === requestId) { attempt.message = '发送结果待核对，内容已保留，不会自动重发。'; try { savePendingSends(command.params.id); } catch {} } }
    else { if (command.method === 'send' && pendingSends[command.params.id]?.requestId === requestId) clearPendingSend(command.params.id, pendingSends[command.params.id], 'failed'); if (active.value && (!('id' in command.params) || selected.value?.id === command.params.id)) error.value = e.message; }
    return false;
  }
  finally { busy.value = false; await read(); }
}
async function send(mode?: 'steer') {
  if (!(mode === 'steer' ? canSteer.value : canSend.value) || !snapshot.value) return;
  cancelNotificationNavigation();
  sendMenu.value = false; const id = snapshot.value.id; const text = goalComposer.value ? goalPrompt(draft.value) : draft.value; const queued = mode !== 'steer' && (snapshot.value.busy || queuedMessages.value.length > 0);
  chatScroll.toBottom();
  await perform({ method: 'send', params: { id, text, epoch: snapshot.value.epoch, ...(mode === 'steer' ? { mode, turnId: snapshot.value.turnId! } : queued ? { mode: 'queue' } : {}), ...(attachments.current.value.length ? { attachmentIds: attachments.current.value.map(a => a.attachment!.id) } : {}) } });
}
let buttonSendAt = 0;
function sendFromButton(event?: Event) {
  event?.preventDefault();
  const now = performance.now(); if (buttonSendAt && now - buttonSendAt < 500) return; buttonSendAt = now; void send();
}
function composerPointerdown(event: PointerEvent) {
  if (event.button !== 0 || event.isPrimary === false) return;
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.composer-field .send-button') : null;
  if (!button || button.disabled || button.classList.contains('stop')) return;
  sendFromButton(event);
}
async function stop() { sendMenu.value = false; const s = snapshot.value; if (s?.turnId) await perform({ method: 'stop', params: { id: s.id, turnId: s.turnId, epoch: s.epoch } }); }
async function pauseGoal() { const s = snapshot.value; if (s?.goal && canPauseGoal.value) await perform({ method: 'goal.pause', params: { id: s.id, epoch: s.epoch, revision: s.goal.revision } }); }
async function respond(r: Interaction, decision?: 'accept' | 'decline') {
  const s = snapshot.value; if (!s) return;
  const accepted = await perform({ method: 'respond', params: { id: s.id, requestId: r.id, epoch: s.epoch, ...(decision ? { decision } : { answers: Object.fromEntries((r.questions ?? []).map(q => [q.id, [answers.value[answerKey(r, q)] ?? '']])) }) } });
  if (accepted && !decision && selected.value?.id === s.id) for (const question of r.questions ?? []) { delete answers.value[answerKey(r, question)]; delete answerModes[answerKey(r, question)]; }
}
const customAnswerMode = 'custom';
function answerKey(request: Interaction, question: NonNullable<Interaction['questions']>[number]) { return JSON.stringify([request.id, question.id]); }
function questionId(request: Interaction, question: NonNullable<Interaction['questions']>[number]) { return `question-${encodeURIComponent(answerKey(request, question))}`; }
function chooseAnswer(request: Interaction, question: NonNullable<Interaction['questions']>[number], event: Event) {
  const key = answerKey(request, question);
  const select = event.currentTarget as HTMLSelectElement; const mode = select.value;
  if (answerModes[key] === customAnswerMode) customAnswers[key] = answers.value[key] ?? '';
  answerModes[key] = mode;
  if (mode === customAnswerMode) {
    answers.value[key] = customAnswers[key] ?? '';
    void nextTick(() => { const field = select.nextElementSibling; if (field instanceof HTMLInputElement) field.focus(); });
    return;
  }
  const index = mode === '' ? NaN : Number(mode); answers.value[key] = Number.isInteger(index) ? question.options[index]?.label ?? '' : '';
}
function answersComplete(r: Interaction) { return (r.questions ?? []).every(question => !!answers.value[answerKey(r, question)]?.trim()); }
function invalidateMode() { modeSyncCycle++; modeSynced.value = false; taskSynced.value = false; }
async function setPlanMode(mode: 'plan'|'default') {
  const s = snapshot.value; const settings = s?.settings;
  if (!s || !settings || !canToggleMode.value) return;
  attachmentPicker.value = false;
  if (settings.mode === mode) { if (mode === 'plan') goalDrafts.delete(s.id); return; }
  invalidateMode(); modeChanging.value = true; busy.value = true; error.value = '';
  try { await request({ method: 'mode.update', params: { id: s.id, epoch: s.epoch, revision: settings.revision, mode } }); if (mode === 'plan') goalDrafts.delete(s.id); }
  catch (e: any) { if (selected.value?.id === s.id && active.value) error.value = e.message; }
  finally { invalidateMode(); modeChanging.value = false; busy.value = false; if (active.value) await read(); }
}
async function setGoalMode(enabled: boolean) {
  const s = snapshot.value; if (!s || goalReason.value) return;
  attachmentPicker.value = false;
  if (enabled && s.settings?.mode === 'plan') {
    await setPlanMode('default');
    if (!active.value || snapshot.value?.id !== s.id || snapshot.value?.settings?.mode !== 'default' || goalReason.value) return;
  }
  if (enabled) goalDrafts.add(s.id); else goalDrafts.delete(s.id);
}
function openPermissionMenu(event?: Event) { if (event?.currentTarget instanceof HTMLElement) modalReturnFocus = event.currentTarget; permissionPicker.value = true; attachmentPicker.value = false; moreMenu.value = false; }
function choosePermission(permission: PermissionMode) {
  if (!canChangePermission.value) return;
  if (snapshot.value?.settings?.permission === permission) { permissionPicker.value = false; return; }
  if (permission === 'full') { permissionPicker.value = false; fullAccessConfirm.value = true; return; }
  void setPermission(permission);
}
async function setPermission(permission: PermissionMode) {
  const s = snapshot.value; const settings = s?.settings;
  if (!s || !settings || !canChangePermission.value) return;
  permissionPicker.value = false; fullAccessConfirm.value = false;
  invalidateMode(); permissionChanging.value = true; busy.value = true; error.value = '';
  try { await request({ method: 'permissions.update', params: { id: s.id, epoch: s.epoch, revision: settings.revision, permission } }); }
  catch (e: any) { if (selected.value?.id === s.id && active.value) error.value = e.message; }
  finally { invalidateMode(); permissionChanging.value = false; busy.value = false; if (active.value) await read(); }
}
async function respondPlan(r: Interaction, action: 'implement'|'revise', feedback?: string) {
  const s = snapshot.value; if (!s || !r.plan || busy.value || !modeReady.value || !canControl.value || !hasCapability('plan-implementation')) return;
  await perform({ method: 'plan.respond', params: { id: s.id, epoch: s.epoch, requestId: String(r.id), revision: r.plan.revision, action, ...(action === 'revise' ? { feedback } : {}) } });
}
function subscriptionChanged(subscription: Subscription) { status.value.subscription = subscription; void loadNavigation(); void read(); }
function clearNavigation(preserveDrafts = false) {
  resetReadRecovery();
  notificationReadRevision++; notificationReceipt = undefined; notificationEvents.clear(); notificationUnread.value = 0;
  if (preserveDrafts && selected.value) { drafts.set(selected.value.id, draft.value); try { savePendingSends(); } catch {} }
  notificationTaskIds.clear(); notificationTaskChecked.clear(); for (const id of Object.keys(notificationTasks)) delete notificationTasks[id];
  navigationEpoch++; focusedNavigationEpoch = -1; projectInteraction++; automaticProjects.clear();
  subscriptionOpen.value = false; notificationOpen.value = false; permissionPicker.value = false; fullAccessConfirm.value = false;
  selected.value = null; snapshot.value = null; drawer.value = false; moreMenu.value = false; projectModal.value = false;
  readError.value = ''; navigationError.value = ''; searchError.value = '';
  pendingActivations.clear(); activateSelected = false;
  if (!preserveDrafts) {
    try { for (let index = localStorage.length - 1; index >= 0; index--) { const key = localStorage.key(index); if (key?.startsWith(`pending-send:${props.deviceId}:`)) localStorage.removeItem(key); } } catch {}
    for (const id of Object.keys(pendingSends)) delete pendingSends[id];
    pendingCreate.value = undefined;
    goalDrafts.clear(); newGoal.value = false;
    try { sessionStorage.removeItem('goal-drafts:' + props.deviceId); } catch {}
    try { sessionStorage.removeItem('pending-sends:' + props.deviceId); sessionStorage.removeItem('chat-drafts:' + props.deviceId); sessionStorage.removeItem('pending-create:' + props.deviceId); localStorage.removeItem('pending-sends:' + props.deviceId); localStorage.removeItem('pending-create:' + props.deviceId); } catch {}
    try { for (let index = sessionStorage.length - 1; index >= 0; index--) { const key = sessionStorage.key(index); if (key?.startsWith(`plan-feedback:${props.deviceId}:`)) sessionStorage.removeItem(key); } } catch {}
    attachments.clear(); drafts.clear();
  }
  modelModal.value=false;terminalsModal.value=false;draft.value='';for(const key of Object.keys(activities))delete activities[key];
  attachmentPicker.value = false;
  queuedMessages.value = []; sendMenu.value = false;
  for (const key of Object.keys(groups)) delete groups[key]; projects.value = []; expandedProjects.clear();
  search.value = ''; searchRows.value = []; searchMore.value = false;
  for (const key of Object.keys(answers.value)) delete answers.value[key]; for (const key of Object.keys(answerModes)) delete answerModes[key];
}
async function logout() {
  try { await api('/api/logout', {}, { 'X-Remote-Device': props.deviceId }); suspend(); clearNavigation(); error.value = ''; emit('logout', props.deviceId); }
  catch (e: any) { error.value = e.message; }
}
async function newConversation(project?: string) {
  if (!canControl.value || !canUse('create-tasks')) return;
  cancelNotificationNavigation();
  const revision = notificationNavigationRevision; const cycle = modeSyncCycle;
  const stillPreparing = () => active.value && canControl.value && revision === notificationNavigationRevision && cycle === modeSyncCycle;
  moreMenu.value = false; error.value = '';
  try { const r = await request({ method: 'projects', params: {} }); if (!stillPreparing()) return; projects.value = r.projects; projectId.value = pendingCreate.value?.command.params.projectId ?? project ?? (newText.value && r.projects.some((p: Project) => p.id === projectId.value) ? projectId.value : selected.value?.projectId ?? r.projects[0]?.id ?? ''); if (pendingCreate.value) { const text = pendingCreate.value.command.params.text; newGoal.value = text.startsWith('/goal '); newText.value = newGoal.value ? text.slice(6) : text; } projectModal.value = true; }
  catch (e: any) { if (stillPreparing()) error.value = e.message; }
}
async function create() {
  if (busy.value || !canControl.value || !canUse('create-tasks') || !projectId.value || !newText.value.trim() || !pendingCreate.value && newGoal.value && (!hasCapability('goal-mode') || newText.value.trim().length > 4000)) return; cancelNotificationNavigation(); busy.value = true;
  const revision = notificationNavigationRevision;
  const reconciling = !!pendingCreate.value;
  const attempt = pendingCreate.value ?? { requestId: crypto.randomUUID(), command: { method: 'create' as const, params: { projectId: projectId.value, text: newGoal.value ? goalPrompt(newText.value) : newText.value, ...(newModel.value ? { model: newModel.value, effort: newEffort.value as any } : {}) } } };
  try {
    pendingCreate.value = attempt; localStorage.setItem('pending-create:' + props.deviceId, JSON.stringify(attempt)); sessionStorage.removeItem('pending-create:' + props.deviceId);
    const r = await request(attempt.command, attempt.requestId);
    if (!r?.threadId) throw Object.assign(new Error('创建结果尚未确认，请在电脑端核对。'), { code: 'OUTCOME_UNKNOWN' });
    pendingCreate.value = undefined; localStorage.removeItem('pending-create:' + props.deviceId); sessionStorage.removeItem('pending-create:' + props.deviceId); sessionStorage.removeItem('new-task-draft:' + props.deviceId); newText.value = ''; newGoal.value = false;
    const navigate = active.value && revision === notificationNavigationRevision && projectModal.value;
    if (navigate) projectModal.value = false;
    await loadNavigation();
    if (navigate && active.value && revision === notificationNavigationRevision && r.threadId) await select({ id: r.threadId, title: '新任务', cwd: '', updatedAt: Date.now(), projectId: attempt.command.params.projectId });
  } catch (e: any) {
    if (!reconciling && e.code && !['OUTCOME_UNKNOWN', 'INTERNAL'].includes(e.code)) { pendingCreate.value = undefined; try { localStorage.removeItem('pending-create:' + props.deviceId); sessionStorage.removeItem('pending-create:' + props.deviceId); } catch {} }
    if (active.value && revision === notificationNavigationRevision) error.value = e.message;
  } finally { busy.value = false; }
}
function releasePendingCreate() {
  if (busy.value || !confirm('请先在电脑端核对新任务。恢复编辑后再次创建可能重复执行，确定已经核对？')) return;
  pendingCreate.value = undefined; try { localStorage.removeItem('pending-create:' + props.deviceId); sessionStorage.removeItem('pending-create:' + props.deviceId); } catch {}
}
function taskState(c:Conversation){const state=activities[c.id]??c;return{...state,running:hasCapability('live-activity')&&state.running};}
let activityLoading=false;let seenKey='';let activityOffset=0;
const resultObscured = computed(() => props.obscured || drawer.value || moreMenu.value || subscriptionOpen.value || notificationOpen.value || recoveryOpen.value || projectModal.value || modelModal.value || terminalsModal.value || permissionPicker.value || fullAccessConfirm.value || attachmentPicker.value);
async function refreshActivity(){
  if(!canRead.value||!hasCapability('activity')||activityLoading)return;activityLoading=true;
  const cycle = modeSyncCycle, navigation = navigationEpoch;
  try{const candidates=[...new Set([...Object.values(groups).flatMap(g=>g.rows.map(c=>c.id)),...searchRows.value.map(c=>c.id)])].filter(id=>id!==selected.value?.id);if(activityOffset>=candidates.length)activityOffset=0;const page=candidates.slice(activityOffset,activityOffset+149);activityOffset+=page.length;const ids=[...(selected.value?[selected.value.id]:[]),...page];if(ids.length){const r=await request({method:'activity',params:{ids}});if(active.value && cycle === modeSyncCycle && navigation === navigationEpoch)for(const a of r.activities)activities[a.id]=a;}}
  catch{}finally{activityLoading=false;}
}
async function markSeen() {
  const s = snapshot.value;
  if (!active.value || !s || s.busy || !s.completionId || resultObscured.value || document.querySelector('dialog[open]') || document.visibilityState !== 'visible' || chatScroll.awayFromBottom.value || !hasCapability('activity')) return;
  const id = s.id, completionId = s.completionId, lastTurnId = s.lastTurnId, cycle = modeSyncCycle;
  const key = id + ':' + completionId; if (seenKey === key) return; seenKey = key;
  try {
    const turnId = lastTurnId && completionId.startsWith(`${lastTurnId}:`) ? lastTurnId : undefined;
    const result = await request({ method: 'seen', params: { id, completionId, ...(turnId ? { turnId } : {}) } });
    if (result.seen !== true || !active.value || resultObscured.value || document.querySelector('dialog[open]') || cycle !== modeSyncCycle || snapshot.value?.id !== id || snapshot.value.busy || snapshot.value.completionId !== completionId || snapshot.value.lastTurnId !== lastTurnId) {
      if (seenKey === key) seenKey = ''; return;
    }
    if (activities[id]?.completionId === completionId) activities[id].unread = false;
    for (const g of Object.values(groups)) for (const c of g.rows) if (c.id === id && (!c.completionId || c.completionId === completionId)) c.unread = false;
  } catch { if (seenKey === key) seenKey = ''; }
}
watch([()=>chatScroll.awayFromBottom.value,resultObscured],()=>{void markSeen();});
function chooseAttachmentSource(source:'photos'|'camera'|'files') {
  if(attachmentReason.value)return;
  attachmentPicker.value=false;
  // Keep the picker call synchronous with the tap so iOS retains user activation.
  (source==='photos'?photoInput.value:source==='camera'?cameraInput.value:fileInput.value)?.click();
}
function openAttachmentMenu() { attachmentPicker.value = true; permissionPicker.value = false; moreMenu.value = false; }
async function chooseFiles(event:Event,photosOnly=false){const element=event.target as HTMLInputElement;const files=Array.from(element.files??[]);element.value='';if(!files.length)return;error.value='';try{await attachments.add(files,photosOnly);}catch(e:any){error.value=e.message;}}
const availableEfforts=computed(()=>models.value.find(m=>m.id===chosenModel.value)?.efforts??[]);
const effortNames:Record<string,string>={none:'默认',minimal:'最少',low:'低',medium:'中',high:'高',xhigh:'极高',max:'最大',ultra:'超高'};
watch(chosenModel,()=>{if(!availableEfforts.value.includes(chosenEffort.value))chosenEffort.value=models.value.find(m=>m.id===chosenModel.value)?.defaultEffort??availableEfforts.value[0]??'';});
async function openModels(target:'current'|'new'='current'){const s=snapshot.value;const cycle=modeSyncCycle;try{const result=await request({method:'models',params:{}});if(!active.value||cycle!==modeSyncCycle||target==='current'&&(!s||snapshot.value?.id!==s.id||snapshot.value?.epoch!==s.epoch))return;models.value=result.models;modelTarget.value=target;editingTask=target==='current'?{id:s!.id,epoch:s!.epoch}:undefined;editingSettings.value=s?.settings;chosenModel.value=(target==='new'?newModel.value:s?.settings?.model)||models.value[0]?.id||'';chosenEffort.value=(target==='new'?newEffort.value:s?.settings?.effort)||models.value.find(m=>m.id===chosenModel.value)?.defaultEffort||'';modelModal.value=true;moreMenu.value=false;}catch(e:any){if(active.value&&cycle===modeSyncCycle)error.value=e.message;}}
async function saveModel(){if(modelTarget.value==='new'){newModel.value=chosenModel.value;newEffort.value=chosenEffort.value;modelModal.value=false;return;}const s=snapshot.value;if(!s||!editingTask||s.id!==editingTask.id||s.epoch!==editingTask.epoch||!editingSettings.value||busy.value)return;busy.value=true;invalidateMode();try{const result=await request({method:'settings.update',params:{id:s.id,epoch:s.epoch,revision:editingSettings.value.revision,model:chosenModel.value,effort:chosenEffort.value as any}});if(snapshot.value?.id===s.id)snapshot.value.settings=result.settings;modelModal.value=false;}catch(e:any){error.value=e.message;modelModal.value=false;}finally{invalidateMode();busy.value=false;if(active.value)await read();}}
function openTerminals(){terminalsModal.value=true;moreMenu.value=false;}
function openNotifications() { notificationOpen.value = true; moreMenu.value = false; }
function openRecovery() { recoveryOpen.value = true; recoveryError.value = ''; moreMenu.value = false; }
async function recoverClient(action: 'launch' | 'pause' | 'enable') {
  if (recoveryBusy.value || recoveryReason.value) return;
  const current = socket, revision = recoveryRevision; const uncertain = { action, attempts: status.value.client?.recovery?.attempts ?? 0, recoveredAt: status.value.client?.recovery?.recoveredAt ?? 0 }; recoveryBusy.value = true; recoveryError.value = ''; pendingRecovery = undefined;
  try {
    const result = await request({ method: 'client.recover', params: { action } });
    if (active.value && socket === current && revision === recoveryRevision) status.value = { ...status.value, client: { ...status.value.client, recovery: result } };
  } catch (e: any) {
    if (active.value && socket === current) { if (['OUTCOME_UNKNOWN', 'READ_DISCONNECTED'].includes(e.code)) { pendingRecovery = uncertain; recoveryError.value = '恢复操作结果待核对，将等待电脑状态同步，不会自动重试。'; } else recoveryError.value = e.message; }
  } finally { recoveryBusy.value = false; }
}
async function openDrawer() {
  drawer.value = true; moreMenu.value = false;
  navigationEpoch++;
  await loadNavigation();
  await nextTick(); navigation.value?.focus({ preventScroll: true });
  navigation.value?.querySelector('.nav-conversation.active')?.scrollIntoView({ block: 'nearest' });
}
function fitInput() { const element = input.value; if (!element) return; element.style.height = '0px'; element.style.height = `${Math.min(160, Math.max(44, element.scrollHeight))}px`; }
let inputObserver: ResizeObserver | undefined;
watch(input, element => {
  inputObserver?.disconnect();
  if (!element) return;
  let width = -1;
  inputObserver = new ResizeObserver(entries => { const nextWidth = entries[0].contentRect.width; if (active.value && nextWidth > 0 && width !== nextWidth) { width = nextWidth; fitInput(); } });
  if (active.value) inputObserver.observe(element);
}, { flush: 'post' });
watch(draft, async () => { await nextTick(); fitInput(); if (active.value && selected.value) { drafts.set(selected.value.id, draft.value); try { sessionStorage.setItem('chat-drafts:' + props.deviceId, JSON.stringify([...drafts])); } catch {} } });
function updateViewport(event?: Event | string) {
  if (disposed.value || !active.value || document.visibilityState !== 'visible') return;
  const pass = ++viewportPass;
  const metrics = measureViewport(viewportProbe.value); const size = viewportSize(metrics);
  const reason = typeof event === 'string' ? event : event?.type ?? 'measure';
  keyboardOpen.value = size.keyboard;
  // Pin measured pixels; CSS dvh can lag behind a restored browser's visible viewport.
  if (size.height > 0) viewportHeight.value = `${size.height}px`;
  viewportTop.value = `${size.top}px`;
  // iOS can retain root scrolling after dismissing the keyboard or restoring a page.
  if (!size.keyboard && (!metrics.visual || Math.abs(metrics.visual.scale - 1) < 0.02) && (window.scrollY || window.scrollX)) window.scrollTo(0, 0);
  void nextTick(() => {
    if (pass !== viewportPass || disposed.value || !active.value || document.visibilityState !== 'visible' || !shell.value) return;
    const bounds = shell.value.getBoundingClientRect();
    const applied = parseFloat(shell.value.style.getPropertyValue('--chat-origin-correction')) || 0;
    const appliedHorizontal = parseFloat(shell.value.style.getPropertyValue('--chat-origin-horizontal-correction')) || 0;
    const correction = viewportOriginCorrection(metrics, size, bounds.top, applied);
    const horizontalCorrection = viewportOriginHorizontalCorrection(metrics, bounds.left, appliedHorizontal);
    if (correction !== applied) {
      // WebKit can pan the fixed-position origin while scrollY stays zero.
      // Write synchronously so the next measurement sees the applied correction.
      shell.value.style.setProperty('--chat-origin-correction', `${correction}px`);
    }
    if (horizontalCorrection !== appliedHorizontal) shell.value.style.setProperty('--chat-origin-horizontal-correction', `${horizontalCorrection}px`);
    const updatedBounds = shell.value.getBoundingClientRect();
    if (!previousViewportBounds || updatedBounds.width !== previousViewportBounds.width || updatedBounds.height !== previousViewportBounds.height || updatedBounds.top !== previousViewportBounds.top || updatedBounds.left !== previousViewportBounds.left) {
      previousViewportBounds = updatedBounds; chatScroll.layoutChanged();
    }
  });
}
function cancelViewportSync() { cancelAnimationFrame(viewportFrame); viewportFrame = 0; for (const timer of viewportTimers) clearTimeout(timer); viewportTimers = []; }
function stopViewportWatchdog() { clearInterval(viewportWatchdog); viewportWatchdog = undefined; }
function resetViewportCache(blur = false) {
  keyboardOpen.value = false; viewportHeight.value = '100dvh'; viewportTop.value = '0px';
  if (blur) {
    const focused = document.activeElement;
    if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) focused.blur();
  }
}
function resyncViewport(event?: Event) {
  cancelViewportSync();
  if (disposed.value || !active.value) return;
  if (document.visibilityState !== 'visible') { stopViewportWatchdog(); return; }
  viewportWatchdog ??= setInterval(() => updateViewport('watchdog'), 1000);
  updateViewport(event);
  // Mobile browsers may settle their viewport after pageshow without another resize event.
  viewportFrame = requestAnimationFrame(() => { viewportFrame = 0; updateViewport('settle'); });
  viewportTimers = [100, 300, 700].map(delay => setTimeout(() => updateViewport('settle'), delay));
}
function pageHidden() { cancelViewportSync(); stopViewportWatchdog(); resetViewportCache(true); }
function restartSocket() {
  const previous = socket; socket = undefined;
  if (previous) { previous.onclose = null; previous.onmessage = null; previous.close(); }
  connected.value = false; invalidateMode(); clearInterval(socketHeartbeat);
  navigationEpoch++; searchRevision++; searchLoading.value = false;
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error(p.readOnly ? '正在恢复连接。' : '连接已中断，请核对原会话，勿重复提交。'), { code: p.readOnly ? 'READ_DISCONNECTED' : 'OUTCOME_UNKNOWN' })); } pending.clear();
  openSocket();
}
function foreground() { if (!active.value) return; if (document.visibilityState !== 'visible') { navigationEpoch++; resetViewportCache(); } resyncViewport(); if (document.visibilityState === 'visible') { void refreshNotificationBadge(); void openNotificationFromUrl(); if (socket && Date.now() - lastFrameAt > 45000) restartSocket(); else if (socket?.readyState === WebSocket.OPEN) { void loadNavigation(); void read(); void reconcileSends(); } else if (socket?.readyState !== WebSocket.CONNECTING) { clearTimeout(reconnect); openSocket(); } } }
watch(session, () => resyncViewport(), { flush: 'post' });
function closeOverlays(event: KeyboardEvent) { if (event.key === 'Escape') { if(recoveryOpen.value)recoveryOpen.value=false;else if(sendMenu.value)sendMenu.value=false;else if(fullAccessConfirm.value)fullAccessConfirm.value=false;else if(permissionPicker.value)permissionPicker.value=false;else if(attachmentPicker.value)attachmentPicker.value=false;else if(modelModal.value)modelModal.value=false;else if(terminalsModal.value)terminalsModal.value=false;else if(notificationOpen.value)notificationOpen.value=false;else {drawer.value = false; moreMenu.value = false; projectModal.value = false;} } }
onActivated(async () => {
  active.value = true; await nextTick(); if (!active.value || disposed.value) return; chatScroll.resume(); resyncViewport();
  if (input.value) { fitInput(); inputObserver?.observe(input.value); }
  try { if (sessionStorage.getItem(`notification-setup:${props.deviceId}`) === '1') { sessionStorage.removeItem(`notification-setup:${props.deviceId}`); notificationOpen.value = true; } } catch {}
  resyncViewport(); window.visualViewport?.addEventListener('resize', resyncViewport); window.visualViewport?.addEventListener('scroll', updateViewport); window.addEventListener('resize', resyncViewport); window.addEventListener('keydown', closeOverlays);
  window.addEventListener('scroll', updateViewport, { passive: true });
  window.addEventListener('focus', resyncViewport); window.addEventListener('orientationchange', resyncViewport); document.addEventListener('focusin', resyncViewport); document.addEventListener('focusout', resyncViewport);
  openSocket();
  window.addEventListener('pageshow', pageRestored);
  window.addEventListener('pagehide', pageHidden);
  window.addEventListener('pointerdown', composerPointerdown, true);
  window.addEventListener('storage', syncPendingSend);
  for (const id of Object.keys(pendingSends)) syncPendingSend({ key: pendingSendKey(id), newValue: localStorage.getItem(pendingSendKey(id)) } as StorageEvent);
  document.addEventListener('visibilitychange', foreground); void refreshNotificationBadge(); void openNotificationFromUrl(); poll = setInterval(() => { if (document.visibilityState === 'visible') {if(selected.value)void read();if(listVisible.value)void refreshActivity();void reconcileSends();} }, 10000);
  navigationPoll = setInterval(() => { if (document.visibilityState === 'visible' && listVisible.value) void loadNavigation(); }, 15000);
});
function suspend() {
  resetReadRecovery();
  active.value = false; chatScroll.pause(); connected.value = false; invalidateMode();
  navigationEpoch++; searchRevision++; searchLoading.value = false;
  inputObserver?.disconnect();
  recoveryOpen.value = false; recoveryRevision++; subscriptionOpen.value = false; notificationOpen.value = false; modelModal.value = false; projectModal.value = false; terminalsModal.value = false; attachmentPicker.value = false; permissionPicker.value = false; fullAccessConfirm.value = false; sendMenu.value = false; moreMenu.value = false;
  cancelViewportSync(); stopViewportWatchdog(); clearTimeout(reconnect); clearTimeout(searchTimer); clearTimeout(changedTimer); changedTimer = undefined; clearInterval(socketHeartbeat); clearInterval(poll); clearInterval(navigationPoll);
  const previous = socket; socket = undefined; previous?.close(1000, 'Device switch');
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error('已切换电脑，发送结果将保留待核对。'), { code: p.readOnly ? 'DEVICE_SWITCH' : 'OUTCOME_UNKNOWN' })); } pending.clear();
  document.removeEventListener('visibilitychange', foreground);
  window.removeEventListener('pageshow', pageRestored);
  window.removeEventListener('pagehide', pageHidden);
  window.removeEventListener('pointerdown', composerPointerdown, true);
  window.removeEventListener('storage', syncPendingSend);
  window.visualViewport?.removeEventListener('resize', resyncViewport); window.visualViewport?.removeEventListener('scroll', updateViewport); window.removeEventListener('resize', resyncViewport); window.removeEventListener('keydown', closeOverlays);
  window.removeEventListener('scroll', updateViewport);
  window.removeEventListener('focus', resyncViewport); window.removeEventListener('orientationchange', resyncViewport); document.removeEventListener('focusin', resyncViewport); document.removeEventListener('focusout', resyncViewport);
}
onDeactivated(suspend);
onUnmounted(() => { disposed.value = true; suspend(); attachments.clear(); });
function canReloadHome() {
  return !selected.value && !busy.value && !modeChanging.value && !attachments.hasPending.value
    && !draft.value && ![...drafts.values()].some(Boolean) && !newText.value && !pendingCreate.value && !search.value
    && !recoveryOpen.value && !recoveryBusy.value && !projectModal.value && !modelModal.value && !subscriptionOpen.value && !notificationOpen.value && !terminalsModal.value && !permissionPicker.value && !fullAccessConfirm.value && !moreMenu.value;
}
defineExpose({ leaveState: () => ({ busy: busy.value, uploading: attachments.uploading.value }), canReloadHome, cancelUploads: attachments.cancelPending, suspend, clear: clearNavigation, realign: resyncViewport, openNotificationFromUrl });
</script>

<template>
  <div ref="shell" class="mobile-shell" @keydown.capture="modalKeydown" @focusin.capture="containModalFocus" :class="{ authenticated: session, 'in-conversation': selected, 'keyboard-open': keyboardOpen, 'viewport-offset': viewportTop !== '0px' }" :style="{ '--chat-viewport': viewportHeight, '--chat-top': viewportTop }">
      <div ref="viewportProbe" data-viewport-probe aria-hidden="true"></div>
      <TrialNotice :device-id="deviceId" :subscription="status.subscription" @open="subscriptionOpen = true"/>
      <header v-if="selected" class="chat-toolbar">
        <button class="icon-button" title="项目与会话" @click="openDrawer"><Menu :size="20"/></button>
        <div class="chat-heading"><h1 :title="snapshot?.title ?? selected.title">{{ snapshot?.title ?? selected.title }}</h1><button class="device-trigger" title="切换电脑" @click="emit('devices')"><Monitor :size="12"/><span>{{ deviceName }}</span><ChevronDown :size="12"/></button></div>
        <button v-if="snapshot?.busy && hasDraft && hasCapability('queued-send')" type="button" class="icon-button draft-stop" title="停止当前生成" :disabled="busy || !canStop" @click="stop"><CircleStop :size="20"/></button>
        <button v-if="hasCapability('model-settings')" class="model-trigger" :title="`模型与思考深度：${snapshot?.settings?.model ?? ''}`" :disabled="!canRead || !snapshot" @click="openModels()"><Brain :size="16"/><span>{{ snapshot?.settings?.model ?? '模型' }}</span></button>
        <button type="button" class="icon-button permission-status" :class="{ full: snapshot?.settings?.permission === 'full', approve: snapshot?.settings?.permission === 'approve' }" :aria-label="`任务权限：${permissionReason || permissionLabel}`" title="更改任务权限" aria-haspopup="dialog" :aria-expanded="permissionPicker" @click="openPermissionMenu"><ShieldAlert v-if="snapshot?.settings?.permission === 'full'" :size="18"/><ShieldCheck v-else-if="snapshot?.settings?.permission === 'approve'" :size="18"/><Shield v-else :size="18"/></button>
        <div class="chat-menu-anchor"><button class="icon-button" title="更多操作" :aria-expanded="moreMenu" @click="moreMenu = !moreMenu"><Ellipsis :size="21"/></button>
          <div v-if="moreMenu" class="chat-menu"><div class="menu-device"><span :title="status.client?.reason">{{ formattedId }}</span><span :class="canControl ? 'good' : 'warning'">{{ connectionLabel }}</span></div><div class="connection-versions"><span>助手 {{ status.helperVersion ? `v${status.helperVersion}` : '版本未知' }}</span><span>Codex {{ status.client?.version || '版本未知' }}</span></div><button type="button" class="notification-menu-item" @click="openNotifications"><Bell :size="17"/><span>任务提醒</span><span v-if="notificationUnread" class="notification-unread-dot" aria-label="有未读提醒"></span></button><button type="button" class="permission-menu-item" :class="{ full: snapshot?.settings?.permission === 'full' }" @click="openPermissionMenu"><ShieldAlert v-if="snapshot?.settings?.permission === 'full'" :size="17"/><ShieldCheck v-else-if="snapshot?.settings?.permission === 'approve'" :size="17"/><Shield v-else :size="17"/><span><strong>任务权限</strong><small>{{ permissionReason || permissionLabel }}</small></span><ChevronRight :size="16"/></button><button @click="openRecovery"><Monitor :size="17"/>客户端恢复</button><FeedbackButton mode="mobile" :device-id="deviceId" :status="status"/><button :disabled="!canRead" @click="moreMenu = false; retryRead()"><RefreshCw :size="16"/>刷新会话</button><button v-if="hasCapability('multi-terminal')" @click="openTerminals"><MonitorSmartphone :size="17"/>在线终端 {{ status.control?.terminals.length ?? 1 }}</button><button :disabled="!canCreate" @click="newConversation()"><Plus :size="17"/>新建任务</button><button @click="logout"><LogOut :size="16"/>退出登录</button></div>
        </div>
      </header>
      <TaskGoal v-if="selected && snapshot?.goal && snapshot.goal.status !== 'complete'" :key="selected.id" :goal="snapshot.goal" :synced="taskSynced && canRead" :turn-stopped="!snapshot.busy && snapshot.lastTurnStatus === 'interrupted'" :can-pause="canPauseGoal" @pause="pauseGoal"/>
      <button v-if="moreMenu" class="chat-menu-scrim" aria-label="关闭菜单" @click="moreMenu = false"></button>
      <div v-if="selected && !canReach" class="chat-status recovery-chat-status" role="status"><span>{{ recoveryActive ? status.client.recovery.reason : connectionLabel }}</span><button v-if="connected && status.online && status.enabled && !status.client?.available" class="text-button" @click="openRecovery">客户端恢复</button></div>
      <div v-else-if="selected && snapshot && canRead && readRecovering" class="chat-status" role="status">正在同步会话</div>
      <button v-if="session && !serviceActive" class="subscription-required" @click="subscriptionOpen = true"><Ticket :size="16"/>订阅未开通或已到期<ChevronRight :size="16"/></button>
      <div v-if="visibleError && !drawer" class="alert app-alert" role="alert"><span>{{ visibleError }}</span><button class="icon-button" title="关闭提示" @click="dismissError"><X :size="16"/></button></div>
      <div v-if="listVisible" :class="['navigation-surface', { 'navigation-overlay': selected }]">
        <button v-if="selected" class="navigation-scrim" aria-label="关闭项目列表" @click="drawer = false"></button>
        <section ref="navigation" class="navigation-panel" aria-label="项目与会话" :role="selected ? 'dialog' : 'region'" :aria-modal="selected ? true : undefined" tabindex="-1">
          <header class="navigation-header"><div class="navigation-heading"><h1>项目与会话</h1><button class="device-trigger" title="切换电脑" @click="emit('devices')"><Monitor :size="12"/><span>{{ deviceName }}</span><ChevronDown :size="12"/></button></div><div><button class="icon-button" title="新建任务" :disabled="!canCreate" @click="newConversation()"><Plus :size="21"/></button><div v-if="!selected" class="chat-menu-anchor"><button class="icon-button" title="更多操作" :aria-expanded="moreMenu" @click="moreMenu = !moreMenu"><Ellipsis :size="21"/></button><div v-if="moreMenu" class="chat-menu"><div class="menu-device"><span :title="status.client?.reason">{{ formattedId }}</span><span :class="canControl ? 'good' : 'warning'">{{ connectionLabel }}</span></div><button type="button" class="notification-menu-item" @click="openNotifications"><Bell :size="17"/><span>任务提醒</span><span v-if="notificationUnread" class="notification-unread-dot" aria-label="有未读提醒"></span></button><button @click="openRecovery"><Monitor :size="17"/>客户端恢复</button><FeedbackButton mode="mobile" :device-id="deviceId" :status="status"/><button @click="logout"><LogOut :size="16"/>退出登录</button></div></div><button v-if="selected" class="icon-button" title="关闭项目列表" @click="drawer = false"><X :size="19"/></button></div></header>
          <div v-if="visibleError && drawer" class="alert app-alert" role="alert"><span>{{ visibleError }}</span><button class="icon-button" title="关闭提示" @click="dismissError"><X :size="16"/></button></div>
          <div class="conversation-search"><Search :size="17"/><input v-model="search" aria-label="搜索会话" placeholder="搜索会话" maxlength="200" type="search"><button v-if="search" class="icon-button" title="清除搜索" @click="search = ''"><X :size="16"/></button></div>
          <div class="navigation-scroll">
            <template v-if="search.trim()"><div v-if="searchLoading && !searchRows.length" class="list-state" role="status">正在搜索</div><div v-else-if="!searchRows.length" class="list-state">没有匹配的会话</div><button v-for="c in searchRows" :key="c.id" class="nav-conversation search-result" @click="select(c)"><div class="search-task-title"><TaskStatus :running="taskState(c).running" :unread="taskState(c).unread"/><span>{{ c.title }}</span></div><small>{{ projectNames.get(c.projectId ?? '') ?? '最近' }}</small></button><button v-if="searchMore" class="text-button nav-load-more" :disabled="searchLoading" @click="runSearch(true)">加载更多</button></template>
            <template v-else>
              <p v-if="canControl && (!projectNavigation || !hasCapability('live-activity'))" class="compatibility-notice">电脑助手需要更新</p>
              <div v-if="navigationLoading && !projects.length && !groups.recent?.loaded" class="list-state">正在读取项目</div>
              <section v-for="p in projects" :key="p.id" class="project-group"><div class="project-row"><button class="project-toggle" :aria-expanded="expandedProjects.has(p.id)" @click="toggleProject(p.id)"><ChevronRight :size="14" :class="{ expanded: expandedProjects.has(p.id) }"/><Folder :size="17"/><span>{{ p.name }}</span><small>{{ p.count ?? '' }}</small></button><button class="icon-button project-new" :title="`在${p.name}新建任务`" :disabled="!canCreate" @click="newConversation(p.id)"><Plus :size="16"/></button></div><div v-if="expandedProjects.has(p.id)" class="project-conversations"><p v-if="group(p.id).loading && !group(p.id).loaded" class="list-state">正在读取</p><p v-else-if="!group(p.id).rows.length" class="list-state">暂无会话</p><button v-for="c in group(p.id).rows" :key="c.id" class="nav-conversation" :class="{ active: selected?.id === c.id }" @click="select(c)"><TaskStatus :running="taskState(c).running" :unread="taskState(c).unread"/><span>{{ c.title }}</span></button><button v-if="group(p.id).hasMore" class="text-button nav-load-more" :disabled="group(p.id).loading" @click="loadGroup(p.id, true)">加载更多</button></div></section>
              <section class="recent-group"><h2>{{ projectNavigation ? '最近' : '会话' }}</h2><p v-if="groups.recent?.loaded && !groups.recent.rows.length" class="list-state">暂无会话</p><button v-for="c in groups.recent?.rows ?? []" :key="c.id" class="nav-conversation" :class="{ active: selected?.id === c.id }" @click="select(c)"><TaskStatus :running="taskState(c).running" :unread="taskState(c).unread"/><span>{{ c.title }}</span></button><button v-if="groups.recent?.hasMore" class="text-button nav-load-more" :disabled="groups.recent.loading" @click="loadGroup(null, true)">加载更多</button></section>
            </template>
          </div>
          <div class="navigation-maintenance"><WebUpdateButton @refresh="refreshPage"/><span v-if="status.update?.phase === 'ready'" class="small muted">电脑助手更新已就绪</span></div>
          <footer class="navigation-footer"><span class="status" :class="canControl ? 'good' : 'warning'"><span class="status-dot"></span>{{ connectionLabel }}</span><button class="icon-button" title="订阅与权益" @click="subscriptionOpen = true"><Ticket :size="17"/></button><button v-if="hasCapability('multi-terminal')" class="icon-button" title="在线终端" @click="openTerminals"><MonitorSmartphone :size="17"/></button><span class="device-number">{{ formattedId }}</span><button class="icon-button" title="退出登录" @click="logout"><LogOut :size="17"/></button></footer>
        </section>
      </div>
      <template v-if="selected">
        <div class="transcript-area"><div ref="scroll" class="messages" @scroll.passive="chatScroll.onScroll"><div ref="content" class="messages-content">
          <button v-if="snapshot?.hasMore" class="text-button history-button" :disabled="historyLoading || !canRead" @click="loadHistory"><RefreshCw v-if="historyLoading" :size="14" class="spin"/>{{ historyLoading ? '正在读取历史消息' : '加载更早的消息' }}</button>
          <p v-if="historyError" class="alert" role="alert">{{ historyError }}</p>
          <div v-if="!snapshot && readError" class="empty-state" role="alert"><p>{{ readError }}</p><button class="text-button" @click="retryRead(true)">重新读取</button></div>
          <div v-else-if="!snapshot" class="empty-state" role="status"><RefreshCw :size="22" class="spin"/><p>{{ readRecovering ? '正在同步会话' : '正在读取原会话' }}</p></div>
          <section v-for="turn in turns" :key="`${selected.id}:${turn.id}`" class="conversation-turn">
            <MessageContent v-for="m in turn.users" :key="m.id" :message="m" :conversation-id="selected.id" :device-id="deviceId"/>
            <TurnProcess v-if="turn.process.length" :turn="turn" :conversation-id="selected.id" :device-id="deviceId" :waiting="turn.status === 'inProgress' && !!snapshot?.requests.length" @change="update => chatScroll.change(update, 'preserve')"/>
            <MessageContent v-for="m in turn.results" :key="m.id" :message="m" :conversation-id="selected.id" :device-id="deviceId"/>
            <p v-if="turn.status === 'failed' || turn.status === 'interrupted'" class="turn-outcome">{{ turn.status === 'failed' ? `任务未完成：${turn.reason || '暂未获取到具体原因，请在电脑端查看。'}` : '已停止' }}</p>
          </section>
          <div v-if="snapshot?.busy && !turns.some(t => t.status === 'inProgress')" class="working"><RefreshCw :size="14" class="spin"/>正在运行</div>
          <section v-for="r in snapshot?.requests ?? []" :key="r.id" class="approval" :data-scroll-key="`approval:${r.id}`">
            <h2>{{ r.title }}</h2><pre v-if="r.detail && r.kind !== 'plan'">{{ r.detail }}</pre>
            <PlanRequest v-if="r.kind === 'plan'" :key="`${selected.id}:${r.plan?.revision}`" :request="r" :conversation-id="selected.id" :device-id="deviceId" :supported="hasCapability('plan-implementation')" :disabled="busy || !modeReady || !canControl || !hasCapability('plan-implementation') || !!snapshot?.busy || !!queuedMessages.length || snapshot?.settings?.mode !== 'plan'" @submit="(action, feedback) => respondPlan(r, action, feedback)" @resized="queueResized"/>
            <div v-else-if="r.kind === 'input'" class="questions"><div v-for="q in r.questions" :key="q.id"><label :for="questionId(r, q)">{{ q.question }}</label><select v-if="q.options.length" :id="questionId(r, q)" :value="answerModes[answerKey(r, q)] ?? ''" @change="chooseAnswer(r, q, $event)"><option value="">请选择</option><option v-for="(o, index) in q.options" :key="o.label" :value="String(index)">{{ o.label }}</option><option :value="customAnswerMode">其他（手动输入）</option></select><input v-if="!q.options.length || answerModes[answerKey(r, q)] === customAnswerMode" :id="q.options.length ? `${questionId(r, q)}-custom` : questionId(r, q)" v-model="answers[answerKey(r, q)]" class="custom-answer" :aria-label="q.options.length ? `${q.question}：其他` : undefined" :placeholder="q.options.length ? '请输入其他回答' : '请输入回答'" maxlength="4000"></div><button class="button primary" :disabled="busy || !canApprove || !answersComplete(r)" @click="respond(r)">提交</button></div><div v-else-if="r.kind !== 'unsupported'" class="approval-actions"><button class="button" :disabled="busy || !canDecline" @click="respond(r, 'decline')"><X :size="16"/>拒绝</button><button class="button primary" :disabled="busy || !canApprove" @click="respond(r, 'accept')"><Check :size="16"/>允许本次</button></div>
          </section>
        </div></div><button v-if="chatScroll.awayFromBottom.value" class="jump-to-bottom" title="回到最新消息" @click="chatScroll.toBottom"><ArrowDown :size="19"/></button></div>
        <form class="composer compact-composer" @submit.prevent="sendFromButton()">
          <div v-if="pendingSend" class="send-confirmation" role="status"><span>{{ pendingSend.message }}</span><div><button type="button" class="text-button" :disabled="busy || checkingSend || !connected || !status.online || !hasCapability('command-status')" @click="reconcileSends"><RefreshCw :size="14"/>核对发送结果</button><button type="button" class="text-button" :disabled="busy" @click="keepUnconfirmedDraft">已核对，保留为草稿</button></div><small v-if="!hasCapability('command-status')">更新电脑助手后可自动核对。</small></div>
          <QueuedMessages :items="queuedMessages" :can-remove="canRemoveQueued" :can-resume="canControl && canUse('send-messages') && modeReady && !busy" @remove="queueAction($event, 'remove')" @resume="queueAction($event, 'resume')" @resized="queueResized"/>
          <p v-if="goalComposer && (goalReason || draft.trim().length > 4000)" class="composer-mode-reason" role="status">{{ goalReason || '目标最多 4000 个字符，原文已保留。' }}</p>
          <div v-if="attachments.current.value.length" class="attachment-strip"><div v-for="a in attachments.current.value" :key="a.key" class="pending-attachment"><img v-if="a.preview" :src="a.preview" :alt="a.file.name"><File v-else :size="20"/><div><strong :title="a.file.name">{{ a.file.name }}</strong><small :class="{ warning:a.error }">{{ a.error || (a.preparing ? '正在处理照片' : a.attachment?.ready ? '已上传' : `${a.progress}%`) }}</small></div><button v-if="a.error" type="button" class="icon-button" title="重试上传" :disabled="!!attachmentReason" @click="attachments.upload(a)"><RefreshCw :size="16"/></button><button type="button" class="icon-button" title="移除附件" :disabled="busy || !!pendingSend" @click="attachments.remove(a)"><X :size="16"/></button></div></div>
          <div class="composer-field"><input ref="fileInput" data-attachment-source="files" type="file" multiple hidden @change="chooseFiles($event)"><input ref="photoInput" data-attachment-source="photos" type="file" accept="image/*" multiple hidden @change="chooseFiles($event,true)"><input ref="cameraInput" data-attachment-source="camera" type="file" accept="image/*" capture="environment" hidden @change="chooseFiles($event,true)"><button type="button" class="icon-button attach-button" title="添加照片、文件或任务模式" aria-haspopup="dialog" :aria-expanded="attachmentPicker" @click="openAttachmentMenu"><Plus :size="21"/></button><div v-if="snapshot?.settings?.mode === 'plan'" class="plan-chip" :title="canToggleMode ? '当前为计划模式' : `计划模式：${modeReason}`"><Lightbulb :size="15"/><span>计划</span><button type="button" class="plan-chip-close" aria-label="关闭计划模式" title="关闭计划模式" :disabled="!canToggleMode" @click="setPlanMode('default')"><X :size="14"/></button></div><div v-if="goalComposer" class="plan-chip goal-chip" title="当前为目标模式"><Target :size="15"/><span>目标</span><button type="button" class="plan-chip-close" aria-label="取消目标模式" title="取消下一条消息的目标模式" :disabled="busy || !!pendingSend" @click="selected && goalDrafts.delete(selected.id)"><X :size="14"/></button></div><textarea ref="input" v-model="draft" aria-label="消息" :placeholder="canControl ? goalComposer ? '描述目标及完成标准' : '发送消息' : '等待连接就绪'" rows="1" maxlength="32000" :disabled="!canRead || busy" @input="fitInput" @keydown.ctrl.enter.prevent="send()"/><button v-if="snapshot?.busy && (!hasDraft || !hasCapability('queued-send'))" type="button" class="send-button stop" title="停止当前生成" :disabled="busy || !canStop || !snapshot.turnId" @click="stop"><CircleStop :size="23"/></button><button v-else class="send-button" :title="snapshot?.busy || queuedMessages.length ? '排队发送' : '发送消息'" :disabled="!canSend"><ArrowUp :size="22"/></button><div v-if="snapshot?.busy && hasDraft && hasCapability('queued-send')" class="send-options"><button type="button" class="icon-button" title="发送方式" :aria-expanded="sendMenu" :disabled="busy || !canControl" @click="sendMenu = !sendMenu"><ChevronDown :size="17"/></button><div v-if="sendMenu" class="send-mode-menu" role="menu"><button type="button" role="menuitem" :disabled="!canSend" @click="send()"><ListOrdered :size="17"/>排队发送</button><button type="button" role="menuitem" :disabled="!canSteer" :title="attachments.current.value.length ? '带附件的内容请排队发送' : '调整当前任务方向'" @click="send('steer')"><CornerUpRight :size="17"/>调整方向</button><button type="button" role="menuitem" :disabled="busy || !canStop" @click="sendMenu = false; stop()"><CircleStop :size="17"/>停止当前生成</button></div></div></div>
        </form>
      </template>
    <button v-if="sendMenu" type="button" class="send-mode-scrim" aria-label="关闭发送方式" @click="sendMenu = false"/>
    <div v-if="projectModal" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="new-title"><div class="modal-title"><h2 id="new-title">新建任务</h2><button class="icon-button" title="关闭" @click="projectModal = false"><X :size="20"/></button></div><form @submit.prevent="create"><label for="project">现有项目</label><select id="project" v-model="projectId" :disabled="busy || !!pendingCreate"><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name ?? p.path }}</option></select><p v-if="!projects.length" class="muted">暂无本机项目</p><button v-if="hasCapability('model-settings')" type="button" class="text-button" :disabled="busy || !!pendingCreate" @click="openModels('new')"><Brain :size="14"/>{{ newModel || '默认模型' }} {{ effortNames[newEffort] || '' }}</button><label v-if="hasCapability('goal-mode')" class="goal-new-choice"><input v-model="newGoal" type="checkbox" :disabled="busy || !!pendingCreate"><Target :size="16"/>目标模式</label><label for="new-text">{{ newGoal ? '目标' : '任务' }}</label><textarea id="new-text" v-model="newText" :placeholder="newGoal ? '描述目标及完成标准' : ''" :disabled="busy || !!pendingCreate" rows="5" maxlength="32000" required/><p v-if="pendingCreate && !busy" class="warning" role="status">创建结果待核对，原请求已保留，不会自动重复创建。</p><p v-if="newGoal && newText.trim().length > 4000" class="warning" role="status">目标最多 4000 个字符，原文已保留。</p><button class="button primary" :disabled="busy || !canCreate || !projectId || !newText.trim() || !pendingCreate && newGoal && (!hasCapability('goal-mode') || newText.trim().length > 4000)">{{ pendingCreate ? '核对创建结果' : '创建任务' }}<ArrowRight :size="16"/></button><button v-if="pendingCreate" type="button" class="text-button" :disabled="busy" @click="releasePendingCreate">已核对，恢复编辑</button></form></section></div>
    <SubscriptionPanel v-if="subscriptionOpen" mode="mobile" :device-id="deviceId" @close="subscriptionOpen = false" @changed="subscriptionChanged"/>
    <NotificationCenter v-if="notificationOpen" :device-id="deviceId" :task-labels="notificationTaskLabels" :resolve-tasks="resolveNotificationTasks" :open-task="openNotificationTask" @close="notificationOpen = false" @unread="notificationUnread = $event"/>
    <ClientRecoveryPanel v-if="recoveryOpen" :state="status.client?.recovery" :busy="recoveryBusy" :unavailable="recoveryReason" :error="recoveryError" @close="recoveryOpen = false" @action="recoverClient"/>
    <div v-if="modelModal" class="modal-backdrop settings-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="model-title"><div class="modal-title"><h2 id="model-title">模型与思考深度</h2><button class="icon-button" title="关闭模型设置" @click="modelModal=false"><X :size="20"/></button></div><form @submit.prevent="saveModel"><label for="model-choice">模型</label><select id="model-choice" v-model="chosenModel"><option v-for="m in models" :key="m.id" :value="m.id">{{ m.name }}</option></select><label for="effort-choice">思考深度</label><select id="effort-choice" v-model="chosenEffort"><option v-for="effort in availableEfforts" :key="effort" :value="effort">{{ effortNames[effort] ?? effort }}</option></select><button class="button primary" :disabled="busy || !canControl || !chosenModel || !chosenEffort"><Check :size="16"/>保存</button></form></section></div>
    <div v-if="terminalsModal" class="modal-backdrop settings-backdrop" @click.self="terminalsModal=false"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="terminal-title"><div class="modal-title"><h2 id="terminal-title">在线终端</h2><button class="icon-button" title="关闭终端列表" @click="terminalsModal=false"><X :size="20"/></button></div><div v-for="t in status.control?.terminals ?? []" :key="t.id" class="terminal-row"><MonitorSmartphone :size="20"/><span>{{ t.label }}{{ t.id === clientId ? '（本终端）' : '' }}</span><small>{{ t.controlling ? '可操作' : '需要升级助手' }}</small></div></section></div>
    <div v-if="permissionPicker" class="modal-backdrop permission-backdrop" @click.self="permissionPicker=false"><section class="modal permission-picker" role="dialog" aria-modal="true" aria-labelledby="permission-title"><div class="modal-title"><h2 id="permission-title">任务权限</h2><button class="icon-button" title="关闭任务权限" @click="permissionPicker=false"><X :size="20"/></button></div><div role="radiogroup" aria-label="选择任务权限"><button type="button" class="permission-option" role="radio" :aria-checked="snapshot?.settings?.permission === 'ask'" :disabled="!canChangePermission" @click="choosePermission('ask')"><Shield :size="22"/><span><strong>请求批准</strong><small>编辑工作区外文件和使用互联网时始终询问</small></span><Check v-if="snapshot?.settings?.permission === 'ask'" :size="18"/></button><button type="button" class="permission-option" role="radio" :aria-checked="snapshot?.settings?.permission === 'approve'" :disabled="!canChangePermission" @click="choosePermission('approve')"><ShieldCheck :size="22"/><span><strong>帮我批准</strong><small>仅对检测到的风险操作请求批准</small></span><Check v-if="snapshot?.settings?.permission === 'approve'" :size="18"/></button><button type="button" class="permission-option full" role="radio" :aria-checked="snapshot?.settings?.permission === 'full'" :disabled="!canChangePermission" @click="choosePermission('full')"><ShieldAlert :size="22"/><span><strong>完全访问权限</strong><small>可不受限制访问互联网和电脑文件</small></span><Check v-if="snapshot?.settings?.permission === 'full'" :size="18"/></button></div><p v-if="snapshot?.settings?.permission === 'custom' && !permissionReason" class="compatibility-notice">当前任务使用自定义权限配置，可切换为以上任一档。</p><p v-else-if="permissionReason" class="compatibility-notice">暂时无法更改：{{ permissionReason }}</p></section></div>
    <div v-if="fullAccessConfirm" class="modal-backdrop permission-confirm-backdrop" @click.self="fullAccessConfirm=false"><section class="modal permission-confirm" role="alertdialog" aria-modal="true" aria-labelledby="full-access-title"><div class="modal-title"><h2 id="full-access-title">启用完全访问权限？</h2><button class="icon-button" title="关闭确认" @click="fullAccessConfirm=false"><X :size="20"/></button></div><div class="permission-warning"><ShieldAlert :size="24"/><p>后续消息可不经批准访问互联网和电脑上的任意文件。仅在你信任当前任务时启用。</p></div><p v-if="permissionReason" class="compatibility-notice">暂时无法更改：{{ permissionReason }}</p><div class="permission-confirm-actions"><button type="button" class="button" @click="fullAccessConfirm=false">取消</button><button type="button" class="button confirm-full" :disabled="!canChangePermission" @click="setPermission('full')">确认启用</button></div></section></div>
    <div v-if="attachmentPicker" class="modal-backdrop attachment-backdrop" @click.self="attachmentPicker=false"><section class="modal attachment-picker" role="dialog" aria-modal="true" aria-labelledby="attachment-title"><div class="modal-title"><h2 id="attachment-title">添加内容</h2><button class="icon-button" title="关闭添加内容" @click="attachmentPicker=false"><X :size="20"/></button></div><button class="attachment-source" :disabled="!!attachmentReason" @click="chooseAttachmentSource('photos')"><Images :size="22"/><span>照片图库</span><ChevronRight :size="16"/></button><button class="attachment-source" :disabled="!!attachmentReason" @click="chooseAttachmentSource('camera')"><Camera :size="22"/><span>拍照</span><ChevronRight :size="16"/></button><button class="attachment-source" :disabled="!!attachmentReason" @click="chooseAttachmentSource('files')"><File :size="22"/><span>文件</span><ChevronRight :size="16"/></button><button type="button" class="attachment-source plan-source" :disabled="!canToggleMode" :aria-checked="snapshot?.settings?.mode === 'plan'" role="menuitemcheckbox" @click="setPlanMode('plan')"><Lightbulb :size="22"/><span><strong>计划模式</strong><small>{{ modeReason || (snapshot?.settings?.mode === 'plan' ? '已开启' : '') }}</small></span><Check v-if="snapshot?.settings?.mode === 'plan'" :size="18"/></button><button type="button" class="attachment-source plan-source goal-source" :disabled="!!goalReason" :aria-checked="goalComposer" role="menuitemcheckbox" @click="setGoalMode(!goalComposer)"><Target :size="22"/><span><strong>目标模式</strong><small>{{ goalReason || (goalComposer ? '下一条消息作为目标' : '') }}</small></span><Check v-if="goalComposer" :size="18"/></button><p v-if="attachmentReason" class="compatibility-notice">附件不可用：{{ attachmentReason }}</p></section></div>
  </div>
</template>

<style scoped>
.composer-mode-reason{margin:0 0 5px;padding:0 2px;overflow-wrap:anywhere;color:#926127;font-size:12px}.goal-new-choice{display:flex;align-items:center;gap:7px;font-size:13px}.goal-new-choice input{width:auto;margin:0}
.send-confirmation{padding:4px 0 8px;color:#835d27;font-size:12px;line-height:1.5;overflow-wrap:anywhere}.send-confirmation>div{display:flex;flex-wrap:wrap;gap:6px 14px}.send-confirmation .text-button{font-size:12px;padding:3px 0}
.notification-menu-item{display:flex;align-items:center;gap:10px;width:100%;padding:10px;color:#38545e;background:none;border:0;text-align:left;font-size:13px}.notification-menu-item:hover{background:#f1f5f7}.notification-menu-item svg{flex-shrink:0}.notification-unread-dot{width:7px;height:7px;margin-left:auto;border-radius:50%;background:#d65738;flex:0 0 auto}
.navigation-maintenance{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:8px 14px;border-top:1px solid #e1e7ea}.navigation-maintenance:empty{display:none}
.chat-heading,.navigation-heading{flex:1;min-width:0}.chat-heading h1{line-height:1.4}.device-trigger{display:flex;align-items:center;gap:4px;border:0;background:none;color:#60727c;font-size:11px;max-width:100%;height:22px;padding:0;text-align:left}.device-trigger span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.device-trigger svg{flex-shrink:0}.navigation-header .navigation-heading{display:block}.navigation-heading h1{font-size:16px}
.model-trigger{display:flex;align-items:center;gap:5px;max-width:110px;height:36px;border:0;background:none;color:#63767e;font-size:11px;flex-shrink:1;min-width:32px;padding:0 5px}.model-trigger svg{flex-shrink:0}.model-trigger span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.plan-chip{display:flex;align-items:center;gap:3px;flex:0 0 auto;height:32px;align-self:flex-end;margin-bottom:6px;padding:0 3px 0 6px;border-radius:6px;background:#edf3ee;color:#436b4a;font-size:12px;white-space:nowrap}.plan-chip-close{display:flex;align-items:center;justify-content:center;min-width:24px;height:30px;padding:0;border:0;background:none;color:inherit}.plan-chip-close:hover{background:#dde9df}.plan-chip svg{flex-shrink:0}.connection-versions{display:grid;gap:3px;padding:6px 10px 10px;font-size:11px;color:#63767e;overflow-wrap:anywhere}
.plan-source span{min-width:0}.plan-source strong{font-weight:400}.plan-source small{display:block;font-size:12px;color:#697a83;white-space:normal;overflow-wrap:anywhere}.attachment-picker .compatibility-notice{padding:7px 4px}
.questions .custom-answer{margin-top:8px}
.search-task-title{display:flex;gap:9px;align-items:center;min-width:0}.search-task-title>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.attachment-strip{display:flex;gap:8px;overflow:auto;padding:0 0 8px}.pending-attachment{display:flex;align-items:center;gap:8px;flex:0 0 250px;min-width:0;border:1px solid #dbe4e7;border-radius:6px;padding:7px;background:#fafcfc}.pending-attachment>img{width:34px;height:34px;object-fit:contain}.pending-attachment>div{flex:1;min-width:0}.pending-attachment strong{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pending-attachment small{display:block;font-size:10px;color:#688279;overflow-wrap:anywhere}.pending-attachment small.warning{color:#ae593f}.pending-attachment .icon-button{width:28px;height:30px;flex-basis:28px}
.composer-field .attach-button{align-self:end;height:44px;width:32px;flex-basis:32px}.terminal-row{display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid #e1e7ea}.terminal-row span{flex:1;font-size:13px;overflow-wrap:anywhere}.terminal-row small{font-size:11px;color:#6e827b}.settings-backdrop{z-index:40!important}
.attachment-backdrop{z-index:45!important;align-items:flex-end;padding:14px 14px max(14px,env(safe-area-inset-bottom))}.attachment-picker{padding:16px 18px 10px;max-width:440px}.attachment-picker .modal-title{margin-bottom:8px}.attachment-source{display:flex;align-items:center;gap:14px;width:100%;min-height:56px;padding:12px 4px;border:0;border-top:1px solid #e7ecee;background:white;color:#38545e;text-align:left}.attachment-source span{flex:1;color:#263d46;font-size:15px}.attachment-source svg{flex-shrink:0}.attachment-source:hover{background:#f3f7f7}
.permission-backdrop{z-index:46!important;align-items:flex-end;padding:14px 14px max(14px,env(safe-area-inset-bottom))}.permission-picker{padding:16px 18px 10px;max-width:440px}.permission-picker .modal-title{margin-bottom:8px}.permission-option{display:flex;align-items:center;gap:13px;width:100%;min-height:66px;padding:11px 4px;border:0;border-top:1px solid #e7ecee;background:#fff;color:#45616b;text-align:left}.permission-option:hover{background:#f3f7f7}.permission-option>span{flex:1;min-width:0}.permission-option strong,.permission-option small{display:block}.permission-option strong{font-size:14px;color:#253c45}.permission-option small{margin-top:2px;color:#718087;font-size:12px;line-height:1.45;white-space:normal}.permission-option.full>svg:first-child,.permission-option.full strong{color:#bd4b27}.permission-option>svg{flex-shrink:0}.permission-confirm-backdrop{z-index:50!important}.permission-warning{display:flex;align-items:flex-start;gap:12px;color:#71402f}.permission-warning svg{flex-shrink:0;color:#bd4b27}.permission-warning p{line-height:1.65}.permission-confirm-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}.permission-confirm-actions .confirm-full{background:#b94929;border-color:#b94929;color:#fff}.permission-confirm-actions .confirm-full:hover{background:#9e3d22}
.pricing-link{display:flex;align-items:center;justify-content:center;gap:7px;margin:14px auto 0}.subscription-required{display:flex;align-items:center;justify-content:center;gap:7px;flex-shrink:0;border:0;border-bottom:1px solid #eadfc9;background:#fffaf0;color:#946223;padding:9px;font-size:12px}.navigation-footer .status{min-width:0;white-space:normal}.navigation-footer{gap:7px}
.send-options{position:relative;align-self:flex-end}.send-options>.icon-button{width:28px;flex-basis:28px;height:44px}.send-mode-menu{position:absolute;right:0;bottom:50px;width:188px;padding:5px;background:#fff;border:1px solid #dbe3e7;border-radius:6px;box-shadow:0 6px 24px #1b344626;z-index:15}.send-mode-menu button{display:flex;align-items:center;gap:9px;width:100%;border:0;background:none;text-align:left;padding:12px 10px;color:#314b58;font-size:13px}.send-mode-menu button:hover{background:#f1f5f7}.draft-stop{color:#976326}
.send-mode-scrim{position:absolute;inset:0;border:0;border-radius:0;background:transparent;z-index:14}
.navigation-footer .device-number{margin-left:auto}
</style>
