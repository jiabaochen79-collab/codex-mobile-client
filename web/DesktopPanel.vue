<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { Ban, Copy, Eye, EyeOff, RefreshCw, ExternalLink, ShieldCheck, Monitor, Unplug, Check, Settings, X, Ticket } from 'lucide-vue-next';
import { api } from './api';
import SubscriptionPanel from './SubscriptionPanel.vue';
import FeedbackButton from './FeedbackButton.vue';
import UpdatePanel from './UpdatePanel.vue';
import { subscriptionLabel } from '../src/shared/subscription';
const subscriptionOpen = ref(false);
const updateOpen = ref(false); const feedbackInitiallyOpen = ref(false);
const state = ref<any>(null); const operationError = ref(''); const readError = ref(''); const error = computed(() => operationError.value || readError.value); const busy = ref(false); const visible = ref(false); const copied = ref('');
const editingPassword = ref(false); const passwordMode = ref('automatic'); const password = ref(''); const showPassword = ref(false);
const disconnect = ref<'refresh' | 'revoke' | null>(null); const cancelDisconnect = ref<HTMLButtonElement>();
const deviceId = computed(() => state.value?.deviceId?.replace(/(\d{3})(?=\d)/g, '$1 ') ?? '--- --- ---');
let timer: ReturnType<typeof setInterval> | undefined;
let revision = 0, reading = false, closed = false;
let uncertainAction: { path: string; body: any; code?: string; checkedAt?: number } | undefined;
function reconcile(next: any) {
  const pending = uncertainAction; if (!pending) return;
  const confirmed = pending.path === '/local/enabled' ? next.enabled === pending.body.enabled
    : pending.path === '/local/rotate' ? next.authorizedCount === 0 && (next.passwordMode === 'custom' || next.code !== pending.code)
    : pending.path === '/local/password' ? next.passwordMode === pending.body.mode && (pending.body.mode !== 'custom' || next.code === pending.body.password)
    : pending.path === '/local/update/check' ? next.update?.checkedAt > (pending.checkedAt ?? 0) && next.update?.phase !== 'checking' : false;
  if (confirmed) { uncertainAction = undefined; operationError.value = ''; if (pending.path === '/local/rotate') disconnect.value = null; if (pending.path === '/local/password') { editingPassword.value = false; password.value = ''; } }
}
async function refresh() { if (reading || busy.value || closed) return; reading = true; const rev = revision; try { const next = await api('/local/state'); if (rev !== revision || closed) return; state.value = next; reconcile(next); readError.value = ''; if (state.value?.subscription?.disabled) { subscriptionOpen.value = false; updateOpen.value = false; editingPassword.value = false; disconnect.value = null; } } catch (e: any) { if (rev === revision && !closed) readError.value = e.message; } finally { reading = false; } }
async function action(path: string, body = {}) { if (busy.value) return; busy.value = true; revision++; operationError.value = ''; uncertainAction = undefined; const pending = { path, body, code: state.value?.code, checkedAt: state.value?.update?.checkedAt }; try { state.value = await api(path, body); readError.value = ''; } catch (e: any) { operationError.value = e.message; if (!e.code || ['OUTCOME_UNKNOWN', 'INTERNAL'].includes(e.code)) uncertainAction = pending; } finally { busy.value = false; } }
async function changeEnabled(event: Event) {
  const input = event.target as HTMLInputElement;
  await action('/local/enabled', { enabled: input.checked });
  input.checked = state.value?.enabled === true;
}
async function copy(key: string, text: string) { try { await navigator.clipboard.writeText(text); copied.value = key; setTimeout(() => copied.value = '', 1800); } catch { operationError.value = '复制失败，请检查浏览器剪贴板权限。'; } }
function editPassword() { passwordMode.value = state.value.passwordMode ?? 'automatic'; password.value = passwordMode.value === 'custom' ? state.value.code : ''; showPassword.value = false; editingPassword.value = true; }
async function savePassword() { await action('/local/password', passwordMode.value === 'custom' ? { mode: 'custom', password: password.value } : { mode: 'automatic' }); if (!operationError.value) { editingPassword.value = false; password.value = ''; } }
async function confirmDisconnect() { await action('/local/rotate'); if (!operationError.value) disconnect.value = null; }
watch(disconnect, async value => { if (value) { await nextTick(); cancelDisconnect.value?.focus(); } });
onMounted(async () => {
  const showSubscription = new URLSearchParams(location.search).get('panel') === 'subscription';
  updateOpen.value = new URLSearchParams(location.search).get('panel') === 'update';
  feedbackInitiallyOpen.value = new URLSearchParams(location.search).get('panel') === 'feedback';
  const secret = new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(null, '', location.pathname);
  if (secret) { try { await api('/local/session', {}, { Authorization: `Bearer ${secret}` }); } catch (e: any) { operationError.value = e.message; } }
  await refresh(); if (closed) return; subscriptionOpen.value = showSubscription; timer = setInterval(refresh, 3000);
});
onUnmounted(() => { closed = true; revision++; clearInterval(timer); });
</script>
<template>
  <div class="desktop-shell desktop-console">
    <header class="desktop-header"><div class="desktop-identity"><img src="/brand.png" alt="" width="44" height="44"><div><h1>ChatGPT 远程助手</h1><span>助手 {{ state?.helperVersion ? `v${state.helperVersion}` : '版本未知' }}</span></div></div><span class="status" :class="state?.connection === 'online' ? 'good' : 'warning'"><span class="status-dot"></span>{{ state?.connection === 'online' ? '服务器已连接' : state?.connection === 'connecting' ? '正在连接服务器' : '服务器未连接' }}</span></header>
    <main class="desktop-main">
      <div v-if="state?.subscription?.disabled" class="desktop-disabled" role="alert"><Ban :size="24"/><div><h2>该设备已被管理员封禁</h2><p>全部远程功能已停用，所有手机授权已断开。如需恢复，请联系运营方。</p></div></div>
      <div v-if="!state?.subscription?.disabled" class="desktop-maintenance"><FeedbackButton v-if="state?.deviceId" mode="desktop" :device-id="state.deviceId" :status="state" :initially-open="feedbackInitiallyOpen"/><button class="text-button" title="助手更新" @click="updateOpen = true"><RefreshCw :size="17"/>{{ state?.update?.phase === 'ready' ? '新版本已就绪' : '检查更新' }}</button></div>
      <section v-if="!state?.subscription?.disabled" class="desktop-device" aria-label="本设备">
        <div class="desktop-section-heading"><h2>本设备</h2><label class="switch-label">允许远程连接<input class="switch" type="checkbox" :checked="state?.enabled" :disabled="busy || !state" @change="changeEnabled"></label></div>
        <div class="credential-grid">
          <div class="credential"><label>本设备 ID</label><div class="credential-value"><strong>{{ deviceId }}</strong><button class="icon-button" title="复制本设备 ID" :disabled="!state?.deviceId" @click="copy('id', state.deviceId)"><Check v-if="copied === 'id'" :size="18"/><Copy v-else :size="18"/></button></div></div>
          <div class="credential"><label>{{ state?.passwordMode === 'custom' ? '固定密码' : '验证码' }}</label><div class="credential-value"><strong class="code" :class="{ 'custom-code': visible && state?.passwordMode === 'custom' }">{{ visible ? state?.code ?? '--------' : '••••••••' }}</strong><button class="icon-button" :title="visible ? '隐藏密码' : '显示密码'" :disabled="!state" @click="visible = !visible"><EyeOff v-if="visible" :size="18"/><Eye v-else :size="18"/></button><button class="icon-button" title="复制连接密码" :disabled="!state" @click="copy('password', state.code)"><Check v-if="copied === 'password'" :size="18"/><Copy v-else :size="18"/></button></div><div class="password-policy"><span>{{ state?.passwordMode === 'custom' ? '自定义固定密码' : '每次成功连接后自动换码' }}</span><button v-if="state?.passwordMode !== 'custom'" class="icon-button" title="更换验证码并撤销现有手机授权" :disabled="busy || !state" @click="disconnect = 'refresh'"><RefreshCw :size="18"/></button><button class="icon-button" title="密码设置" :disabled="busy || !state" @click="editPassword"><Settings :size="18"/></button></div></div>
        </div>
      </section>
      <div v-if="error" class="alert" role="alert">{{ error }}</div>
      <div v-if="state?.connectionError" class="alert" role="alert">{{ state.connectionError.message }} [{{ state.connectionError.stage }}/{{ state.connectionError.code }}]</div>
      <div v-if="!state?.subscription?.disabled" class="desktop-subscription"><Ticket :size="20"/><div><h3>订阅</h3><span>{{ subscriptionLabel(state?.subscription) }}</span></div><button class="button" :disabled="!state" @click="subscriptionOpen = true"><Ticket :size="17"/>订阅与权益</button></div>
      <section v-if="!state?.subscription?.disabled" class="connection-details"><div><span class="detail-icon"><Monitor :size="21"/></span><div><h3>Codex 客户端</h3><p><span v-if="state?.client.version">Codex {{ state.client.version }} </span>{{ state?.client.reason ?? (state ? '' : '正在检查') }}</p></div><span class="status" :class="state?.client.available && !state?.client.reason ? 'good' : 'warning'">{{ state?.client.available ? state.client.reason ? '部分兼容' : '就绪' : '未就绪' }}</span></div><div><span class="detail-icon"><ShieldCheck :size="21"/></span><div><h3>手机授权</h3><p>{{ state?.authorizedCount ?? 0 }} 个有效授权</p></div><button class="button revoke-button" :disabled="busy || !state?.authorizedCount" @click="disconnect = 'revoke'"><Unplug :size="18"/>撤销全部授权</button></div></section>
      <footer v-if="!state?.subscription?.disabled" class="desktop-footer"><h3>手机连接</h3><div class="desktop-actions"><button class="button primary" :disabled="!state?.deviceId" @click="copy('share', `${state.url}\n设备 ID：${deviceId}\n连接密码：${state.code}`)"><Check v-if="copied === 'share'" :size="16"/><Copy v-else :size="16"/>{{ copied === 'share' ? '已复制' : '复制连接信息' }}</button><a v-if="state?.url" class="button" :href="state.url" target="_blank" rel="noreferrer"><ExternalLink :size="16"/>打开手机网页</a></div><span class="server-address">{{ state?.url }}</span></footer>
    </main>
    <SubscriptionPanel v-if="subscriptionOpen" mode="desktop" @close="subscriptionOpen = false" @changed="refresh"/>
    <UpdatePanel v-if="updateOpen" @close="updateOpen = false"/>
    <div v-if="editingPassword" class="modal-backdrop" ><section class="modal password-modal" role="dialog" aria-modal="true" aria-labelledby="password-title"><div class="modal-title"><h2 id="password-title">密码设置</h2><button class="icon-button" title="关闭" @click="editingPassword = false; password = ''"><X :size="20"/></button></div><form @submit.prevent="savePassword"><label class="password-option"><input v-model="passwordMode" type="radio" value="automatic">每次成功连接后自动换码（默认）</label><label class="password-option"><input v-model="passwordMode" type="radio" value="custom">自定义固定密码</label><template v-if="passwordMode === 'custom'"><label for="custom-password">密码（8 至 64 位）</label><div class="password-field"><input id="custom-password" v-model="password" :type="showPassword ? 'text' : 'password'" class="large-input" minlength="8" maxlength="64" autocomplete="new-password" autocapitalize="none" spellcheck="false" required><button type="button" class="icon-button" :title="showPassword ? '隐藏密码' : '显示密码'" @click="showPassword = !showPassword"><EyeOff v-if="showPassword" :size="18"/><Eye v-else :size="18"/></button></div></template><div v-if="error" class="alert" role="alert">{{ error }}</div><button class="button primary" :disabled="busy || (passwordMode === 'custom' && (password.length < 8 || !password.trim()))"><Check :size="17"/>保存</button></form></section></div>
    <div v-if="disconnect" class="modal-backdrop" @click.self="!busy && (disconnect = null)" @keydown.esc="!busy && (disconnect = null)"><section class="modal disconnect-modal" role="dialog" aria-modal="true" aria-labelledby="disconnect-title"><div class="modal-title"><h2 id="disconnect-title">{{ disconnect === 'refresh' ? '更换验证码？' : '撤销全部授权？' }}</h2></div><p>所有已授权的手机和浏览器都需要重新连接。</p><p>{{ state?.passwordMode === 'custom' ? '自定义固定密码保持不变。' : '当前验证码将同时更换。' }}</p><div class="disconnect-actions"><button ref="cancelDisconnect" class="button" :disabled="busy" @click="disconnect = null">取消</button><button class="button revoke-button" :disabled="busy" @click="confirmDisconnect"><RefreshCw v-if="disconnect === 'refresh'" :size="17"/><Unplug v-else :size="17"/>{{ disconnect === 'refresh' ? '确认更换' : '确认撤销' }}</button></div></section></div>
  </div>
</template>

<style scoped>
.desktop-maintenance{display:flex;justify-content:flex-end;gap:16px;margin-bottom:12px}
.desktop-maintenance :deep(.feedback-entry){width:auto;border:0;padding:8px}.desktop-maintenance>.text-button{display:inline-flex;align-items:center;gap:6px;flex-shrink:0;white-space:nowrap}
.desktop-disabled{display:flex;align-items:flex-start;gap:14px;padding:18px;border:1px solid #ecd2d2;background:#fff7f7;color:#8f353b;border-radius:6px}.desktop-disabled svg{flex:none;margin-top:1px}.desktop-disabled h2{font-size:16px}.desktop-disabled p{font-size:13px;line-height:1.7;margin:7px 0 0}
.desktop-console{background:#fff;max-width:920px;color:#212830}
.desktop-header{display:flex;align-items:center;justify-content:space-between;gap:20px;min-height:100px;padding:22px 32px;border-bottom:1px solid #e5e9ed}
.desktop-identity{display:flex;align-items:center;gap:15px;min-width:0}.desktop-identity img{border-radius:6px;flex-shrink:0}.desktop-identity h1{font-size:22px;line-height:1.5}.desktop-identity span{display:block;font-size:12px;color:#747e89;margin-top:2px}
.desktop-console .desktop-main{padding:24px 32px 28px}.desktop-section-heading{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:22px}.desktop-section-heading h2{font-size:16px}
.credential-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr);padding:0;gap:24px}.credential{min-width:0}.credential>label{font-size:12px;color:#747e89}.credential-value{min-height:64px;margin-top:9px;background:#f4f6f8;border-radius:4px;padding:8px 8px 8px 14px;gap:2px}.credential-value strong{min-width:0;flex:1;font-family:'Segoe UI',sans-serif;font-size:28px;font-weight:500}.credential-value .code{min-width:0;font-size:24px}.credential-value .custom-code{overflow:hidden;white-space:pre;text-overflow:ellipsis;font-size:15px}.credential-value .icon-button{flex-basis:32px;width:32px}
.password-policy{display:flex;align-items:center;gap:4px;min-height:44px;color:#747e89;font-size:12px}.password-policy span{flex:1;min-width:0}.password-policy .icon-button{flex-shrink:0}
.desktop-console .connection-details{margin-top:0}.desktop-console .connection-details>div{min-height:70px;padding:12px 0}.desktop-console .detail-icon{background:none;padding:0 5px 0 0}.desktop-console .connection-details h3{font-size:13px;font-weight:500}
.revoke-button{color:#a93d41;background:white;border-color:#ead4d6}.revoke-button:hover{background:#fef1f1}.desktop-footer{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;margin:24px -32px -28px;padding:20px 32px;background:#f7f9fa;border-top:1px solid #e5e9ed}.desktop-footer h3{font-size:14px}.desktop-actions{display:flex;gap:10px}.desktop-actions .button{min-width:156px;white-space:nowrap}.server-address{grid-column:1/-1;font-size:12px;color:#747e89;overflow-wrap:anywhere}
.password-modal .password-option{display:flex;align-items:center;gap:8px}
.desktop-subscription{display:flex;align-items:center;gap:13px;min-height:70px;margin-top:18px;padding:12px 0;border-bottom:1px solid #e2e8eb}.desktop-subscription>svg{color:#71818b}.desktop-subscription>div{flex:1;min-width:0}.desktop-subscription h3{font-size:13px;font-weight:500}.desktop-subscription span{display:block;font-size:12px;color:#74818b;margin-top:3px}.desktop-subscription .button{font-size:12px}
.disconnect-modal p{font-size:13px;line-height:1.8;color:#637181}.disconnect-actions{display:flex;gap:12px;justify-content:flex-end;margin-top:24px}
@media(max-width:620px){.desktop-header{padding:18px 20px;flex-wrap:wrap;gap:14px}.desktop-identity h1{font-size:20px}.desktop-console .desktop-main{padding:22px 20px}.credential-grid{grid-template-columns:minmax(0,1fr);gap:18px}.desktop-footer{grid-template-columns:minmax(0,1fr);margin:24px -20px -22px;padding:20px}.desktop-actions{display:grid;grid-template-columns:minmax(0,1fr)}.desktop-actions .button{width:100%;min-width:0;font-size:13px;padding:10px}.desktop-console .switch-label{font-size:12px}.desktop-console .revoke-button{font-size:12px;padding:8px}.server-address{font-size:11px}}
</style>
