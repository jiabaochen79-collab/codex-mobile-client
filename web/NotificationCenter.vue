<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Bell, Check, ExternalLink, RefreshCw, ShieldAlert, Smartphone, X } from 'lucide-vue-next';
import { api } from './api';
import { pushRegistration } from './push-registration';
import type { NotificationItem, NotificationSettings } from '../src/shared/notifications';

const props = defineProps<{ deviceId: string; taskLabels: Record<string, { title: string; project?: string }>; resolveTasks: (ids: string[]) => Promise<void>; openTask: (taskId: string) => Promise<boolean> }>();
const emit = defineEmits<{ close: []; unread: [count: number] }>();

const headers = () => ({ 'X-Remote-Device': props.deviceId });
const items = ref<NotificationItem[]>([]);
const unread = ref(0);
const nextCursor = ref<string | null>(null);
const loadingMore = ref(false);
const settings = ref<NotificationSettings>({ enabled: false, completed: true, failed: true });
const pushConfigured = ref(false);
const vapidPublicKey = ref<string | null>(null);
const systemPushState = ref<'unknown' | 'enabled' | 'needed'>('unknown');
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const info = ref('');
const standalone = ref(false);
let listRevision = 0;

const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
const isIos = /iPhone|iPad|iPod/i.test(userAgent) || typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
const pushAvailable = computed(() => {
  if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  return !isIos || standalone.value;
});
const canEnableReminders = computed(() => !isIos || standalone.value);
const browserMessage = computed(() => {
  if (isIos && !standalone.value) return 'iPhone/iPad 浏览器页面不能接收后台推送，请在当前浏览器使用“分享”->“更多”->“添加到主屏幕”，再从主屏幕打开并开启通知。';
  if (!pushConfigured.value) return '服务器尚未配置系统推送，站内通知仍可用。';
  if (!pushAvailable.value) return '当前浏览器不支持系统推送，站内通知仍可用。';
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') return '系统通知权限已拒绝，可在浏览器或系统设置中恢复。';
  return '';
});

function formatTime(value: number) { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function statusLabel(status: NotificationItem['status']) { return status === 'failed' ? '执行异常' : status === 'interrupted' ? '任务中断' : '任务完成'; }
function updateUnread(value: number) { unread.value = Math.max(0, value); emit('unread', unread.value); }
function saveLocalSubscription(id?: string) {
  try { if (id) localStorage.setItem(`notification-subscription:${props.deviceId}`, id); else localStorage.removeItem(`notification-subscription:${props.deviceId}`); } catch {}
}
function localSubscriptionId() {
  try { return localStorage.getItem(`notification-subscription:${props.deviceId}`) ?? ''; } catch { return ''; }
}
async function load() {
  loading.value = true; error.value = '';
  standalone.value = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true;
  try {
    const [settingResult, listResult] = await Promise.all([
      api('/api/notifications/settings', undefined, headers()),
      api('/api/notifications', undefined, headers())
    ]);
    settings.value = settingResult.settings;
    pushConfigured.value = settingResult.pushConfigured === true;
    vapidPublicKey.value = settingResult.vapidPublicKey ?? null;
    items.value = listResult.items ?? [];
    nextCursor.value = listResult.nextCursor ?? null;
    updateUnread(Number(listResult.unread) || 0);
    void props.resolveTasks(items.value.map(item => item.taskId));
    await refreshSystemPushState();
  } catch (e: any) { error.value = e.message; }
  finally { loading.value = false; }
}
async function refreshSystemPushState() {
  systemPushState.value = 'unknown';
  if (!settings.value.enabled || !pushConfigured.value || !pushAvailable.value) return;
  try {
    const registration = await pushRegistration();
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription || Notification.permission !== 'granted') { systemPushState.value = 'needed'; return; }
    const result = await api('/api/push/subscriptions/status', { endpoint: subscription.endpoint }, headers());
    systemPushState.value = result.active === true ? 'enabled' : 'needed';
    saveLocalSubscription(result.active === true ? result.id : undefined);
  } catch { systemPushState.value = 'needed'; }
}
async function save(next: NotificationSettings) {
  const result = await api('/api/notifications/settings', next, headers(), 'PUT');
  settings.value = result.settings;
  return result;
}
function decodeKey(value: string) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const bytes = atob(value.replace(/-/g, '+').replace(/_/g, '/') + padding);
  return Uint8Array.from(bytes, char => char.charCodeAt(0));
}
async function registerPush() {
  if (!pushConfigured.value || !vapidPublicKey.value) { systemPushState.value = 'unknown'; return '站内通知已开启；服务器暂未提供系统推送。'; }
  if (isIos && !standalone.value) { systemPushState.value = 'unknown'; return browserMessage.value; }
  if (!pushAvailable.value) { systemPushState.value = 'unknown'; return browserMessage.value; }
  systemPushState.value = 'needed';
  if (Notification.permission === 'denied') return browserMessage.value;
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') return '系统通知权限未开启，站内通知仍可用。';
  const registration = await pushRegistration();
  const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(vapidPublicKey.value) });
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('浏览器未返回有效的推送订阅。');
  const result = await api('/api/push/subscriptions', { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, browser: isIos ? 'ios-home-screen' : /Android/i.test(userAgent) ? 'android-chrome' : 'desktop' }, headers());
  saveLocalSubscription(result.id);
  systemPushState.value = 'enabled';
  return '系统推送已开启。';
}
async function enable() {
  if (busy.value) return;
  if (!canEnableReminders.value) { error.value = ''; info.value = browserMessage.value; return; }
  busy.value = true; error.value = ''; info.value = '';
  try { await save({ ...settings.value, enabled: true }); info.value = await registerPush(); }
  catch (e: any) { error.value = e.message; }
  finally { busy.value = false; }
}
async function enableBrowserPush() {
  if (busy.value) return; busy.value = true; error.value = ''; info.value = '';
  try { info.value = await registerPush(); }
  catch (e: any) { error.value = e.message; }
  finally { busy.value = false; }
}
async function disable() {
  if (busy.value) return; busy.value = true; error.value = ''; info.value = '';
  try {
   await save({ ...settings.value, enabled: false });
   const id = localSubscriptionId(); if (id) await api(`/api/push/subscriptions/${encodeURIComponent(id)}`, undefined, headers(), 'DELETE');
    saveLocalSubscription();
    systemPushState.value = 'needed';
  } catch (e: any) { error.value = e.message; }
  finally { busy.value = false; }
}
async function changeKind(kind: 'completed' | 'failed', value: boolean) {
  if (busy.value || !settings.value.enabled) return;
  busy.value = true; error.value = '';
  try { await save({ ...settings.value, [kind]: value }); }
  catch (e: any) { error.value = e.message; }
  finally { busy.value = false; }
}
async function readOne(item: NotificationItem) {
  if (busy.value) return; busy.value = true; error.value = '';
  listRevision++;
  try {
    if (!await props.openTask(item.taskId)) return;
    const result = await api(`/api/notifications/${encodeURIComponent(item.id)}/read`, undefined, headers(), 'POST');
    const wasUnread = item.readAt === null;
    item.readAt ??= Date.now(); updateUnread(typeof result.unread === 'number' ? result.unread : unread.value - Number(wasUnread)); emit('close');
  } catch (e: any) { error.value = e.message; }
  finally { busy.value = false; }
}
async function readAll() {
  if (busy.value || !unread.value) return; busy.value = true; error.value = '';
  listRevision++;
  try { await api('/api/notifications/read-all', {}, headers()); for (const item of items.value) item.readAt ??= Date.now(); updateUnread(0); }
  catch (e: any) { error.value = e.message; }
  finally { busy.value = false; }
}
function onIncoming(event: Event) {
  const item = (event as CustomEvent<NotificationItem>).detail;
  if (!item || item.deviceId !== props.deviceId) return;
  listRevision++;
  const index = items.value.findIndex(row => row.id === item.id);
  if (index >= 0) { if (items.value[index].readAt) item.readAt ??= items.value[index].readAt; items.value[index] = item; }
  else { items.value.unshift(item); if (!item.readAt) updateUnread(unread.value + 1); }
  void props.resolveTasks([item.taskId]);
}
async function loadMore() {
  if (loadingMore.value || busy.value || !nextCursor.value) return;
  loadingMore.value = true; error.value = '';
  const revision = listRevision;
  try {
    const result = await api(`/api/notifications?cursor=${encodeURIComponent(nextCursor.value)}`, undefined, headers());
    if (revision !== listRevision) return;
    const page = (result.items ?? []) as NotificationItem[];
    const ids = new Set(items.value.map(item => item.id));
    items.value.push(...page.filter(item => !ids.has(item.id)));
    nextCursor.value = result.nextCursor ?? null;
    updateUnread(Number(result.unread) || 0);
    void props.resolveTasks(page.map(item => item.taskId));
  } catch (e: any) { if (revision === listRevision) error.value = e.message; }
  finally { loadingMore.value = false; }
}
onMounted(() => { window.addEventListener('remote-notification', onIncoming); void load(); });
onUnmounted(() => window.removeEventListener('remote-notification', onIncoming));
</script>

<template>
  <div class="modal-backdrop notification-backdrop" @click.self="!busy && emit('close')">
    <section class="modal notification-modal" role="dialog" aria-modal="true" aria-labelledby="notification-title">
      <div class="modal-title"><h2 id="notification-title"><Bell :size="18"/>任务完成提醒</h2><button class="icon-button" title="关闭提醒设置" :disabled="busy" @click="emit('close')"><X :size="20"/></button></div>
      <div v-if="loading" class="notification-loading" role="status"><RefreshCw class="spin" :size="18"/>正在读取提醒设置</div>
      <template v-else>
        <div class="notification-toggle-row"><div><strong>{{ settings.enabled ? '提醒已开启' : '提醒未开启' }}</strong><small>每台电脑分别保存提醒设置</small></div><button v-if="!settings.enabled && canEnableReminders" class="button primary" :disabled="busy" @click="enable"><Bell :size="16"/>开启提醒</button><button v-else-if="!settings.enabled" class="button" disabled>请先添加到主屏幕</button><button v-else class="button" :disabled="busy" @click="disable">关闭提醒</button></div>
        <div class="notification-kinds"><label><input type="checkbox" :checked="settings.completed" :disabled="busy || !settings.enabled" @change="changeKind('completed', ($event.target as HTMLInputElement).checked)"><span>任务完成</span></label><label><input type="checkbox" :checked="settings.failed" :disabled="busy || !settings.enabled" @change="changeKind('failed', ($event.target as HTMLInputElement).checked)"><span>失败或异常中断</span></label></div>
        <button v-if="settings.enabled && pushConfigured && pushAvailable && systemPushState === 'needed'" class="button notification-browser-push" :disabled="busy" @click="enableBrowserPush"><Bell :size="16"/>开启系统通知</button>
        <p v-if="browserMessage" class="notification-info"><Smartphone v-if="isIos" :size="16"/><ShieldAlert v-else :size="16"/><span>{{ browserMessage }}</span></p>
        <p v-if="info || systemPushState === 'enabled'" class="notification-success" role="status"><Check :size="16"/>{{ info || '系统推送已开启。' }}</p>
        <div class="notification-list-heading"><strong>最近提醒</strong><button v-if="unread" class="text-button" :disabled="busy" @click="readAll">全部标为已读</button></div>
        <div v-if="!items.length" class="notification-empty">暂无任务完成提醒</div>
        <div v-else class="notification-list"><button v-for="item in items" :key="item.id" class="notification-item" :class="{ unread: !item.readAt }" :disabled="busy" @click="readOne(item)"><span class="notification-status" :class="item.status"><Check v-if="item.status === 'completed'" :size="15"/><ShieldAlert v-else :size="15"/></span><span class="notification-item-text"><strong :title="taskLabels[item.taskId]?.title || item.taskId">{{ taskLabels[item.taskId]?.title || `任务 ${item.taskId.slice(0, 8)}` }}</strong><small v-if="taskLabels[item.taskId]?.project" class="notification-project">{{ taskLabels[item.taskId].project }}</small><small>{{ statusLabel(item.status) }} · {{ formatTime(item.occurredAt) }}</small></span><ExternalLink :size="15"/></button></div>
        <button v-if="nextCursor" class="button" :disabled="busy || loadingMore" @click="loadMore"><RefreshCw v-if="loadingMore" class="spin" :size="16"/>{{ loadingMore ? '正在读取' : '加载更多提醒' }}</button>
      </template>
      <p v-if="error" class="alert" role="alert">{{ error }}</p>
      <p class="notification-footnote">系统通知只显示状态和时间；登录后的提醒列表显示任务及项目名称，无法读取名称时显示任务编号。站内记录保留 30 天。</p>
    </section>
  </div>
</template>

<style scoped>
.notification-backdrop{z-index:55!important}.notification-modal{width:min(100%,440px);max-height:calc(100dvh - 24px);padding:18px;overflow-y:auto}.notification-modal .modal-title h2{display:flex;align-items:center;gap:7px}.notification-loading{display:flex;align-items:center;gap:9px;padding:28px 0;color:#71818a}.notification-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:3px 0 14px;border-bottom:1px solid #e4eaec}.notification-toggle-row>div{min-width:0}.notification-toggle-row strong,.notification-toggle-row small{display:block}.notification-toggle-row strong{font-size:14px}.notification-toggle-row small{margin-top:4px;color:#78878d;font-size:11px}.notification-toggle-row .button{white-space:nowrap}.notification-kinds{display:flex;flex-wrap:wrap;gap:14px;padding:13px 0;font-size:12px;color:#4e626a}.notification-kinds label{display:flex;align-items:center;gap:7px}.notification-browser-push{margin-bottom:10px}.notification-info,.notification-success{display:flex;align-items:flex-start;gap:7px;padding:10px;background:#f5f8f9;color:#667981;font-size:12px;line-height:1.6}.notification-info svg,.notification-success svg{flex-shrink:0;margin-top:2px}.notification-list-heading{display:flex;align-items:center;justify-content:space-between;margin-top:20px;padding-bottom:7px;border-bottom:1px solid #e4eaec;font-size:13px}.notification-empty{padding:26px 0;text-align:center;color:#85949b;font-size:12px}.notification-list{display:grid}.notification-item{display:flex;align-items:center;gap:10px;width:100%;min-height:56px;padding:9px 2px;border:0;border-bottom:1px solid #edf0f1;background:transparent;text-align:left;color:#344c56}.notification-item:hover{background:#f6f9fa}.notification-item.unread{background:#f7fbfa}.notification-status{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:#e7f2ec;color:#27785b;flex-shrink:0}.notification-status.failed,.notification-status.interrupted{background:#fff0e9;color:#ad542e}.notification-item-text{display:flex;flex:1;min-width:0;flex-direction:column;gap:3px}.notification-item-text strong{font-size:13px;font-weight:550}.notification-item-text small{font-size:11px;color:#7a8990}.notification-footnote{margin-top:14px;color:#8a979c;font-size:11px;line-height:1.6}
@media(max-width:400px){.notification-backdrop{padding:12px}.notification-modal{padding:15px}.notification-toggle-row{align-items:flex-start;flex-direction:column}.notification-toggle-row .button{align-self:stretch}}
.notification-item-text strong,.notification-project{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.notification-item>svg{flex-shrink:0}
</style>
