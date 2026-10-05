<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ArrowDown, ArrowRight, ArrowUp, Check, Ellipsis, Eye, EyeOff, LogOut, Monitor, Pencil, Plus, RefreshCw, ShieldCheck, Smartphone, Ticket, Trash2, X } from 'lucide-vue-next';
import { api } from './api';
import MobilePanel from './MobilePanel.vue';
import { installResumeReload } from './resume-reload';
import SubscriptionPanel from './SubscriptionPanel.vue';
import { MAX_PAIRED_DEVICES, type PairedDevice } from '../src/shared/paired-devices';

const devices = ref<PairedDevice[]>([]); const activeId = ref(''); const directoryOpen = ref(false); const adding = ref(false); const restoring = ref(true);
const deviceId = ref(''); const code = ref(''); const remember = ref(true); const rememberedDeviceId = ref(''); const showCode = ref(false); const connecting = ref(false);
const error = ref(''); const working = ref(false); const loading = ref(false); const subscriptionOpen = ref(false);
const managedId = ref(''); const editingId = ref(''); const name = ref(''); const removeTarget = ref<PairedDevice>(); const confirmLogout = ref(false);
const pendingSwitch = ref<PairedDevice>();
const generation = ref(0); const revisions = ref<Record<string, number>>({});
const panel = ref<InstanceType<typeof MobilePanel>>(); const panels = new Map<string, InstanceType<typeof MobilePanel>>();
const current = computed(() => devices.value.find(d => d.deviceId === activeId.value));
const resumeReload = installResumeReload(() => !!current.value?.authorized && !!panel.value && !restoring.value
  && !working.value && !connecting.value && !adding.value && !directoryOpen.value && !subscriptionOpen.value
  && !editingId.value && !pendingSwitch.value && !removeTarget.value && !confirmLogout.value
  && [...panels.values()].every(p => p.canReloadHome()));
// Browser history must not restore a document offset over the internal chat/list scrollers.
const previousScrollRestoration = history.scrollRestoration;
history.scrollRestoration = 'manual';
watch(() => !!activeId.value && !!current.value?.authorized, locked => {
  document.documentElement.classList.toggle('mobile-viewport-locked', locked);
}, { immediate: true, flush: 'sync' });
onUnmounted(() => { document.documentElement.classList.remove('mobile-viewport-locked'); history.scrollRestoration = previousScrollRestoration; });
const directoryVisible = computed(() => directoryOpen.value || !activeId.value && !adding.value && devices.value.length > 0);
const loginVisible = computed(() => !restoring.value && (adding.value || !activeId.value && !devices.value.length));
const label = (device: PairedDevice) => device.name || device.deviceId.replace(/(\d{3})(?=\d)/g, '$1 ');
const deviceIdDigits = computed(() => deviceId.value.replace(/\D/g, ''));
const deviceIdHint = computed(() => deviceId.value && deviceIdDigits.value.length !== 9 ? `设备 ID 需要 9 位数字，当前 ${deviceIdDigits.value.length} 位` : '');
function normalizeDeviceId() { deviceId.value = deviceIdDigits.value.slice(0, 9); }
const deviceState = (device: PairedDevice) => device.disabled ? '已被管理员封禁' : !device.authorized ? '需要重新验证' : !device.online ? '电脑离线' : !device.enabled ? '远控已关闭' : '在线';
let directoryRevision = 0; let polling: ReturnType<typeof setInterval> | undefined; let disposed = false;
let restorePending = false, restoreInFlight = false, restoreAttempts = 0, restoreError = '';
let restoreRetry: ReturnType<typeof setTimeout> | undefined;
const webUpdateAvailable = ref(false); let latestWebEntry = ''; let checkingWebVersion = false;
const pageEntry = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
let openingNotificationDevice = false;
try {
  const saved = JSON.parse(localStorage.getItem('remote-login') ?? '{}'); remember.value = saved?.remember !== false;
  if (remember.value && typeof saved?.deviceId === 'string' && /^[1-9][0-9]{8}$/.test(saved.deviceId)) deviceId.value = rememberedDeviceId.value = saved.deviceId;
} catch {}
function savePreference() { if (!remember.value) rememberedDeviceId.value = ''; try { localStorage.setItem('remote-login', JSON.stringify({ remember: remember.value, deviceId: rememberedDeviceId.value })); } catch {} }
function recordPanel(value: any) { panel.value = value; if (value && activeId.value) panels.set(activeId.value, value); }
function clearPanel(id: string, preserveDrafts = false) { panels.get(id)?.clear(preserveDrafts); if (preserveDrafts) return; panels.delete(id); revisions.value[id] = (revisions.value[id] ?? 0) + 1; }
function rememberSelection(id: string) { try { if (id) sessionStorage.setItem('remote-active-device', id); else sessionStorage.removeItem('remote-active-device'); } catch {} }
function expired(id: string, message: string) {
  clearPanel(id, true); const device = devices.value.find(d => d.deviceId === id); if (device) device.authorized = false;
  if (activeId.value === id) { panel.value?.suspend(); activeId.value = ''; rememberSelection(''); deviceId.value = id; code.value = ''; adding.value = true; directoryOpen.value = false; error.value = message; }
}
function applyDirectory(result: { devices: PairedDevice[] }) {
  for (const id of panels.keys()) if (id !== activeId.value && !result.devices.some(d => d.deviceId === id && d.authorized)) clearPanel(id, result.devices.some(d => d.deviceId === id));
  devices.value = result.devices;
  if (!devices.value.length) directoryOpen.value = false;
  if (activeId.value && !current.value?.authorized) expired(activeId.value, current.value?.disabled ? '该设备已被管理员封禁，请联系运营方。' : '授权已失效，请使用当前连接密码重新连接。');
}
async function refreshDirectory(restore = false) {
  const revision = ++directoryRevision; loading.value = true;
  try { const result = await api(restore ? '/api/paired-devices/restore' : '/api/paired-devices', restore ? {} : undefined); if (!disposed && revision === directoryRevision) applyDirectory(result); }
  finally { if (revision === directoryRevision) loading.value = false; }
}
async function openDirectory() { directoryOpen.value = true; managedId.value = ''; error.value = ''; try { await refreshDirectory(); } catch (e: any) { error.value = e.message; } }
async function switchTo(device: PairedDevice, cancelUploads = false) {
  if (working.value || connecting.value) return;
  if (device.disabled) { error.value = '该设备已被管理员封禁，请联系运营方。'; return; }
  if (activeId.value === device.deviceId && device.authorized) { directoryOpen.value = false; return; }
  const state = panel.value?.leaveState();
  if (state?.busy) { error.value = '操作正在确认，请稍后切换电脑。'; return; }
  if (state?.uploading && !cancelUploads) { pendingSwitch.value = device; return; }
  if (cancelUploads) panel.value?.cancelUploads(); pendingSwitch.value = undefined;
  if (!device.authorized) { deviceId.value = device.deviceId; code.value = ''; adding.value = true; directoryOpen.value = false; return; }
  working.value = true; error.value = '';
  try {
    const result = await api(`/api/paired-devices/${device.deviceId}/select`, {}); directoryRevision++; applyDirectory(result);
    panel.value?.suspend(); activeId.value = device.deviceId; rememberSelection(device.deviceId); directoryOpen.value = false; adding.value = false;
  } catch (e: any) { error.value = e.message; if (e.code === 'AUTH') { device.authorized = false; deviceId.value = device.deviceId; code.value = ''; adding.value = true; directoryOpen.value = false; } }
  finally { working.value = false; }
}
function addComputer() { if (devices.value.length >= MAX_PAIRED_DEVICES) return; deviceId.value = ''; code.value = ''; showCode.value = false; error.value = ''; adding.value = true; directoryOpen.value = false; }
function closePairing() { if (connecting.value) return; adding.value = false; code.value = ''; error.value = ''; if (!activeId.value && devices.value.length) directoryOpen.value = true; }
async function connect() {
  if (connecting.value || working.value) return;
  if (panel.value?.leaveState().busy) { error.value = '操作正在确认，请稍后添加电脑。'; return; }
  if (panel.value?.leaveState().uploading) { error.value = '文件正在上传，请等待完成后再连接另一台电脑。'; return; }
  connecting.value = true; error.value = '';
  const id = deviceId.value.replace(/\s/g, ''); const password = code.value; const remembered = remember.value;
  try {
    await refreshDirectory(true);
    const result = await api('/api/connect', { deviceId: id, code: password, remember: remembered, multiple: true });
    code.value = ''; rememberedDeviceId.value = remembered ? id : ''; savePreference();
    directoryRevision++; applyDirectory(result); clearPanel(id, true); panel.value?.suspend(); activeId.value = id; rememberSelection(id); adding.value = false; directoryOpen.value = false;
  } catch (e: any) { error.value = e.message; } finally { connecting.value = false; }
}
async function change(path: string, body: unknown) {
  if (working.value) return false; working.value = true; error.value = '';
  try { const result = await api(path, body); directoryRevision++; applyDirectory(result); return true; }
  catch (e: any) { error.value = e.message; return false; } finally { working.value = false; }
}
async function rename() { if (await change(`/api/paired-devices/${editingId.value}`, { name: name.value.trim() })) editingId.value = ''; }
async function move(id: string, offset: number) { const ids = devices.value.map(d => d.deviceId); const index = ids.indexOf(id); if (index + offset < 0 || index + offset >= ids.length) return; [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]]; await change('/api/paired-devices/order', { deviceIds: ids }); }
async function remove() {
  const id = removeTarget.value?.deviceId; if (!id || working.value) return;
  if (activeId.value === id && panel.value?.leaveState().busy) { error.value = '操作正在确认，请稍后移除电脑。'; return; }
  working.value = true; error.value = '';
  try { const result = await api(`/api/paired-devices/${id}/remove`, {}); if (activeId.value === id) { panel.value?.suspend(); activeId.value = ''; rememberSelection(''); } clearPanel(id); directoryRevision++; applyDirectory(result); removeTarget.value = undefined; adding.value = false; }
  catch (e: any) { error.value = e.message; } finally { working.value = false; }
}
async function logoutAll() {
  if (panel.value?.leaveState().busy) { error.value = '操作正在确认，请稍后退出。'; return; }
  if (working.value) return; working.value = true;
  try { await api('/api/paired-devices/logout', {}); panel.value?.suspend(); for (const cached of panels.values()) cached.clear(); activeId.value = ''; rememberSelection(''); devices.value = []; panels.clear(); generation.value++; directoryRevision++; confirmLogout.value = false; directoryOpen.value = false; adding.value = false; code.value = ''; error.value = ''; }
  catch (e: any) { error.value = e.message; } finally { working.value = false; }
}
async function loggedOut(id: string) { clearPanel(id); if (activeId.value === id) { activeId.value = ''; rememberSelection(''); adding.value = false; directoryOpen.value = false; code.value = ''; deviceId.value = rememberedDeviceId.value; } try { await refreshDirectory(); } catch (e: any) { error.value = e.message; } }
async function checkWebVersion() {
  if (!import.meta.env.PROD || activeId.value || connecting.value || disposed || document.visibilityState !== 'visible' || checkingWebVersion) return;
  checkingWebVersion = true;
  try { const result = await api('/api/web-version'); if (activeId.value || connecting.value || disposed || !pageEntry || typeof result.entry !== 'string' || result.entry === new URL(pageEntry).pathname) return; latestWebEntry = result.entry; webUpdateAvailable.value = true; }
  catch {} finally { checkingWebVersion = false; }
}
function refreshWeb() { const url = new URL(location.href); url.searchParams.set('v', latestWebEntry); location.replace(url.href); }
async function restoreConnection() {
  if (disposed || restoreInFlight || connecting.value || working.value) return;
  restoreInFlight = true; clearTimeout(restoreRetry);
  try {
    await refreshDirectory(true); if (disposed) return; restorePending = false; restoreAttempts = 0;
    if (error.value === restoreError) error.value = ''; restoreError = '';
    if (!activeId.value && (code.value || deviceId.value !== rememberedDeviceId.value)) adding.value = true;
    if (!activeId.value && !adding.value && !code.value && deviceId.value === rememberedDeviceId.value) {
      let last = ''; try { last = sessionStorage.getItem('remote-active-device') ?? ''; } catch {}
      const notificationDevice = new URL(location.href).searchParams.get('notificationDevice');
      const linkedDevice = notificationDevice && /^[1-9][0-9]{8}$/.test(notificationDevice) ? notificationDevice : '';
      const target = linkedDevice ? devices.value.find(d => d.deviceId === linkedDevice) : devices.value.find(d => d.deviceId === last) ?? [...devices.value].sort((a, b) => b.lastUsed - a.lastUsed)[0];
      if (target?.authorized) { activeId.value = target.deviceId; rememberSelection(target.deviceId); }
      else if (target || linkedDevice) { deviceId.value = target?.deviceId ?? linkedDevice; adding.value = true; }
    }
  } catch (e: any) {
    restorePending = ['NETWORK', 'OUTCOME_UNKNOWN'].includes(e.code) || [502, 503, 504].includes(e.status);
    if (!error.value || error.value === restoreError) error.value = restoreError = e.message;
    if (restorePending && restoreAttempts < 3) restoreRetry = setTimeout(() => { if (document.visibilityState === 'visible') void restoreConnection(); }, [1000, 3000, 10000][restoreAttempts++]);
  } finally { restoreInFlight = false; restoring.value = false; }
  if (new URL(location.href).searchParams.has('notification')) void openNotificationDevice();
}
function online() { if (restorePending) { restoreAttempts = 0; void restoreConnection(); } }
function foreground() { if (document.visibilityState !== 'visible') return; if (restorePending) online(); else void refreshDirectory().catch(() => {}); void checkWebVersion(); }
async function openNotificationDevice() {
  const url = new URL(location.href);
  const id = url.searchParams.get('notification'); const targetId = url.searchParams.get('notificationDevice');
  if (restoring.value || disposed || openingNotificationDevice || working.value || connecting.value || panel.value?.leaveState().busy || !id || !targetId || !/^[0-9a-f-]{36}$/i.test(id) || !/^[1-9][0-9]{8}$/.test(targetId)) return;
  const device = devices.value.find(row => row.deviceId === targetId);
  if (!device?.authorized) {
    error.value = '请先验证通知所属电脑，再查看任务。';
    deviceId.value = targetId; code.value = ''; adding.value = true; directoryOpen.value = false;
    return;
  }
  openingNotificationDevice = true;
  try {
    await switchTo(device);
    await nextTick();
    if (activeId.value === targetId) await panel.value?.openNotificationFromUrl();
  } finally {
    openingNotificationDevice = false;
    const current = new URL(location.href);
    if (current.searchParams.get('notification') !== id || current.searchParams.get('notificationDevice') !== targetId) void openNotificationDevice();
  }
}
function notificationMessage(event: MessageEvent) {
  if (event.data?.type !== 'notification.open' || typeof event.data.url !== 'string') return;
  let url: URL;
  try { url = new URL(event.data.url); } catch { return; }
  if (url.origin !== location.origin || url.pathname !== '/' || !/^[0-9a-f-]{36}$/i.test(url.searchParams.get('notification') ?? '') || !/^[1-9][0-9]{8}$/.test(url.searchParams.get('notificationDevice') ?? '')) return;
  history.replaceState(null, '', url.pathname + url.search + url.hash);
  event.ports[0]?.postMessage('notification.received');
  void openNotificationDevice();
}
watch([working, connecting, () => panel.value?.leaveState().busy], () => { void openNotificationDevice(); });
function closeOverlay(event: KeyboardEvent) { if (event.key !== 'Escape' || working.value || connecting.value) return; if (pendingSwitch.value) pendingSwitch.value = undefined; else if (removeTarget.value) removeTarget.value = undefined; else if (confirmLogout.value) confirmLogout.value = false; else if (editingId.value) editingId.value = ''; else if (adding.value && devices.value.length) closePairing(); else directoryOpen.value = false; }
onMounted(async () => {
  navigator.serviceWorker?.addEventListener('message', notificationMessage);
  await restoreConnection();
  if (new URL(location.href).searchParams.has('notification')) void openNotificationDevice();
  resumeReload.ready();
  document.addEventListener('visibilitychange', foreground); window.addEventListener('pageshow', foreground); window.addEventListener('online', online); window.addEventListener('keydown', closeOverlay);
  polling = setInterval(() => { if (document.visibilityState === 'visible') { if (directoryVisible.value || activeId.value) void refreshDirectory().catch(() => {}); else void checkWebVersion(); } }, 15000);
  void checkWebVersion();
});
onUnmounted(() => { disposed = true; clearTimeout(restoreRetry); navigator.serviceWorker?.removeEventListener('message', notificationMessage); resumeReload.dispose(); clearInterval(polling); document.removeEventListener('visibilitychange', foreground); window.removeEventListener('pageshow', foreground); window.removeEventListener('online', online); window.removeEventListener('keydown', closeOverlay); });
</script>

<template>
  <div v-if="restoring" class="startup" role="status"><RefreshCw class="spin" :size="20"/>正在恢复连接</div>
  <KeepAlive :key="generation" :max="MAX_PAIRED_DEVICES">
    <MobilePanel v-if="activeId && current?.authorized" :key="activeId + ':' + (revisions[activeId] ?? 0)" :ref="recordPanel" :device-id="activeId" :device-name="label(current)" @devices="openDirectory" @expired="expired" @logout="loggedOut"/>
  </KeepAlive>
  <div v-if="loginVisible" :class="activeId ? 'modal-backdrop pairing-backdrop' : 'mobile-shell'" @click.self="activeId && closePairing()">
    <header v-if="!activeId" class="app-header"><div class="brand"><img src="/brand.png" alt="" width="28" height="28"><span>ChatGPT 远程助手</span></div><button v-if="devices.length" class="icon-button" title="我的电脑" @click="adding = false; directoryOpen = true"><Monitor :size="20"/></button></header>
    <main class="connect-page" :class="{ modal: activeId }" :role="activeId ? 'dialog' : undefined" :aria-modal="activeId ? true : undefined" aria-labelledby="connect-title">
      <div class="connect-title"><div v-if="!activeId" class="connect-symbol"><Smartphone :size="30"/></div><div class="pairing-title"><h1 id="connect-title">{{ activeId ? '添加电脑' : '连接电脑' }}</h1><button v-if="activeId" class="icon-button" title="关闭添加电脑" :disabled="connecting" @click="closePairing"><X :size="20"/></button></div></div>
      <form class="connect-form" @submit.prevent="connect">
        <label for="device-id">设备 ID</label><input id="device-id" v-model="deviceId" name="username" class="large-input id-input" inputmode="numeric" autocomplete="username" placeholder="000 000 000" maxlength="11" required @input="normalizeDeviceId"><small v-if="deviceIdHint" class="field-error" role="status">{{ deviceIdHint }}</small>
        <label for="verification">验证码或自定义密码</label><div class="password-field"><input id="verification" v-model="code" name="password" :type="showCode ? 'text' : 'password'" class="large-input code-input" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="验证码或自定义密码" aria-describedby="password-rules" maxlength="64" minlength="8" required><button type="button" class="icon-button" :title="showCode ? '隐藏密码' : '显示密码'" @click="showCode = !showCode"><EyeOff v-if="showCode" :size="19"/><Eye v-else :size="19"/></button></div>
        <div class="password-rules"><small id="password-rules">验证码 8 位；自定义密码 8 至 64 位</small><small>{{ code.length }} / 64</small></div>
        <label class="remember-login"><input v-model="remember" type="checkbox" @change="savePreference"><span>记住此设备（30 天免登录）</span></label>
        <div v-if="webUpdateAvailable" class="alert web-update" role="status"><span>网页已有新版本</span><button type="button" class="icon-button" title="刷新网页" @click="refreshWeb"><RefreshCw :size="18"/></button></div>
        <div v-if="error" class="alert" role="alert">{{ error }}</div>
        <button class="button primary connect-submit" :disabled="connecting || webUpdateAvailable || deviceIdDigits.length !== 9 || code.length < 8 || code.length > 64 || !code.trim()"><RefreshCw v-if="connecting" class="spin" :size="18"/><span>{{ connecting ? '正在连接' : '连接' }}</span><ArrowRight v-if="!connecting" :size="18"/></button>
      </form>
      <div v-if="!activeId" class="connection-footer"><ShieldCheck :size="16"/><span>设备 ID + 连接密码</span></div><button v-if="!activeId" class="text-button pricing-link" @click="subscriptionOpen = true"><Ticket :size="16"/>订阅与权益</button>
    </main>
  </div>
  <div v-if="directoryVisible && !restoring" :class="activeId ? 'modal-backdrop devices-backdrop' : 'devices-page mobile-shell'" @click.self="activeId && (directoryOpen = false)">
    <section class="device-directory" :class="{ modal: activeId }" :role="activeId ? 'dialog' : 'region'" :aria-modal="activeId ? true : undefined" aria-label="我的电脑">
      <header class="modal-title"><h2>我的电脑</h2><div><button class="icon-button" title="刷新电脑列表" :disabled="loading" @click="openDirectory"><RefreshCw :size="18" :class="{ spin: loading }"/></button><button class="icon-button" title="添加电脑" :disabled="working || devices.length >= MAX_PAIRED_DEVICES" @click="addComputer"><Plus :size="21"/></button><button v-if="activeId" class="icon-button" title="关闭电脑列表" @click="directoryOpen = false"><X :size="20"/></button></div></header>
      <div v-if="error" class="alert" role="alert">{{ error }}</div>
      <div class="device-list">
        <div v-for="(device, index) in devices" :key="device.deviceId" class="saved-device" :data-device-id="device.deviceId">
          <div class="saved-device-row"><button class="select-device" :aria-label="'连接 ' + label(device)" :aria-current="device.deviceId === activeId ? 'true' : undefined" :disabled="working" @click="switchTo(device)"><Monitor :size="21"/><span><strong>{{ label(device) }}</strong><small><span class="status-dot" :class="{ online: device.authorized && device.online }"/>{{ deviceState(device) }}<span v-if="!device.remembered"> · 本次连接</span></small></span><Check v-if="device.deviceId === activeId" :size="18" class="current-device"/></button><button class="icon-button" :title="'管理 ' + label(device)" :aria-expanded="managedId === device.deviceId" @click="managedId = managedId === device.deviceId ? '' : device.deviceId"><Ellipsis :size="20"/></button></div>
          <div v-if="managedId === device.deviceId" class="device-actions"><span>{{ device.deviceId.replace(/(\d{3})(?=\d)/g, '$1 ') }}</span><button class="icon-button" title="重命名电脑" :disabled="working" @click="editingId = device.deviceId; name = device.name"><Pencil :size="17"/></button><button class="icon-button" title="上移电脑" :disabled="working || index === 0" @click="move(device.deviceId, -1)"><ArrowUp :size="17"/></button><button class="icon-button" title="下移电脑" :disabled="working || index === devices.length - 1" @click="move(device.deviceId, 1)"><ArrowDown :size="17"/></button><button class="icon-button danger" title="移除此电脑" :disabled="working" @click="removeTarget = device"><Trash2 :size="17"/></button></div>
        </div>
      </div>
      <footer class="device-directory-footer"><span>{{ devices.length }} / {{ MAX_PAIRED_DEVICES }}</span><button class="text-button danger" :disabled="working" @click="confirmLogout = true"><LogOut :size="16"/>退出全部电脑</button></footer>
    </section>
  </div>
  <div v-if="editingId || removeTarget || confirmLogout || pendingSwitch" class="modal-backdrop device-confirm-backdrop">
    <section class="modal" role="dialog" aria-modal="true" :aria-label="editingId ? '重命名电脑' : pendingSwitch ? '文件正在上传' : removeTarget ? '移除电脑' : '退出全部电脑'">
      <form v-if="editingId" @submit.prevent="rename"><div class="modal-title"><h2>重命名电脑</h2><button type="button" class="icon-button" title="取消重命名" @click="editingId = ''"><X :size="20"/></button></div><label for="computer-name">电脑名称</label><input id="computer-name" v-model="name" class="large-input" maxlength="40" required autofocus><button class="button primary" :disabled="working || !name.trim()"><Check :size="17"/>保存</button></form>
      <template v-else-if="pendingSwitch"><h2>文件正在上传</h2><p>切换到 {{ label(pendingSwitch) }} 前，需要完成或取消当前上传。</p><div class="confirm-actions"><button class="button" @click="pendingSwitch = undefined">继续等待</button><button class="button" @click="switchTo(pendingSwitch!, true)"><X :size="16"/>取消上传并切换</button></div></template>
      <template v-else><h2>{{ removeTarget ? '移除电脑' : '退出全部电脑' }}</h2><p>{{ removeTarget ? `移除 ${label(removeTarget)} 的浏览器授权？再次连接需要验证密码。` : '撤销此浏览器保存的全部电脑授权？电脑上的任务不会停止。' }}</p><div class="confirm-actions"><button class="button" :disabled="working" @click="removeTarget = undefined; confirmLogout = false">取消</button><button class="button danger" :disabled="working" @click="removeTarget ? remove() : logoutAll()"><LogOut :size="16"/>{{ removeTarget ? '确认移除' : '确认退出' }}</button></div></template>
      <div v-if="error" class="alert" role="alert">{{ error }}</div>
    </section>
  </div>
  <SubscriptionPanel v-if="subscriptionOpen" mode="guest" @close="subscriptionOpen = false"/>
</template>

<style scoped>
.password-rules{display:flex;justify-content:space-between;gap:10px;margin-top:7px;color:#75858c}.password-rules small{font-size:11px}.password-rules small:last-child{white-space:nowrap;font-variant-numeric:tabular-nums}.field-error{display:block;margin-top:7px;color:#a44d35;font-size:12px}.web-update{display:flex;align-items:center;justify-content:space-between;gap:12px}.pricing-link{display:flex;align-items:center;justify-content:center;gap:7px;margin:14px auto 0}
.pairing-backdrop,.devices-backdrop{z-index:70}.pairing-backdrop .connect-page{padding:22px;max-height:calc(100dvh - 28px);margin:0;overflow:auto}.pairing-backdrop .connect-title{margin-bottom:22px}.pairing-title{display:flex;align-items:center;justify-content:space-between;gap:12px}.pairing-title h1{font-size:24px}.pairing-backdrop .connect-form label{display:block;margin-top:0}.pairing-backdrop .connect-form label:not(:first-child){margin-top:20px}
.device-directory{width:100%;max-width:480px;padding:20px;margin:auto;background:#fff}.devices-page{padding:24px 0}.device-directory.modal{padding:18px;max-height:calc(100dvh - 36px);display:flex;flex-direction:column}.device-directory .modal-title{margin-bottom:8px;flex-shrink:0;gap:8px}.device-directory .modal-title>div{display:flex}.device-directory h2{font-size:18px}.device-list{overflow:auto;min-height:0}.saved-device{border-bottom:1px solid #e6ebee}.saved-device-row{display:flex;align-items:center;gap:4px;min-height:76px}.select-device{display:flex;align-items:center;gap:12px;min-width:0;flex:1;padding:14px 4px;border:0;background:transparent;text-align:left;color:#566c7a}.select-device>span{flex:1;min-width:0}.select-device strong{display:block;font-size:14px;font-weight:550;color:#263640;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.select-device small{display:flex;align-items:center;gap:6px;font-size:11px;margin-top:5px;color:#73828c;flex-wrap:wrap}.select-device>svg{flex-shrink:0}.select-device[aria-current=true]{color:#286aca}.select-device .current-device{color:#258563}.status-dot{color:#a1aab0}.status-dot.online{color:#23825d}.device-actions{display:flex;gap:3px;align-items:center;padding:0 2px 8px 37px}.device-actions>span{flex:1;font-size:11px;min-width:0;overflow-wrap:anywhere;color:#71808a;font-variant-numeric:tabular-nums}.device-actions .icon-button{width:32px;flex-basis:32px}.device-directory-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:12px;flex-shrink:0;font-size:11px;color:#77838c}.device-directory-footer button{display:flex;align-items:center;gap:6px}.danger{color:#aa4049}.device-confirm-backdrop{z-index:80}.device-confirm-backdrop p{font-size:14px;line-height:1.7;margin:16px 0;overflow-wrap:anywhere}.confirm-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}.confirm-actions button{font-size:13px}.device-confirm-backdrop h2{font-size:17px}
@media(max-width:400px){.devices-backdrop,.pairing-backdrop,.device-confirm-backdrop{padding:12px}.device-directory.modal{padding:14px}.device-directory h2{font-size:17px}.device-actions{padding-left:4px}.pairing-backdrop .connect-page{padding:18px}.brand{font-size:16px}}
</style>
