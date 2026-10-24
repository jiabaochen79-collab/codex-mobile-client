<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue';
import { Check, ClipboardList, Eye, EyeOff, KeyRound, RefreshCw, ShoppingCart, X } from 'lucide-vue-next';
import { api as requestApi } from './api';
import { licenseCodeSchema, subscriptionLabel, type Catalog, type Subscription, type TrialEligibility } from '../src/shared/subscription';
import { money as price } from '../src/shared/commerce';
const props = defineProps<{ mode: 'desktop' | 'mobile' | 'guest'; deviceId?: string }>();
const api = (path: string, body?: unknown) => requestApi(path, body, props.mode === 'mobile' && props.deviceId ? { 'X-Remote-Device': props.deviceId } : undefined);
const OrdersPanel = defineAsyncComponent(() => import('./OrdersPanel.vue')); const ordersOpen = ref(false); const purchasePlan = ref<string>();
const emit = defineEmits<{ close: []; changed: [Subscription] }>();
const catalog = ref<Catalog>(); const subscription = ref<Subscription>();
watch(() => subscription.value?.disabled, disabled => { if (disabled) { ordersOpen.value = false; purchasePlan.value = undefined; } }, { flush: 'sync' });
const trial = ref<TrialEligibility>(); const trialRequest = crypto.randomUUID();
async function claimTrial() {
  if (busy.value || !accepted.value || !trial.value?.available || !catalog.value) return; loadRevision++; reading.value = false; busy.value = true; error.value = '';
  try { const result = await api(props.mode === 'desktop' ? '/local/trial' : '/api/subscription/trial', { requestId: trialRequest, termsVersion: catalog.value.termsVersion }); subscription.value = result.subscription; trial.value = result.trial; readError.value = ''; emit('changed', result.subscription); }
  catch (e: any) { error.value = e.message; } finally { busy.value = false; }
}
const code = ref(''); const accepted = ref(false); const showCode = ref(false); const busy = ref(false); const error = ref(''); const success = ref(false);
const readError = ref(''); const reading = ref(false);
watch(code, () => { error.value = ''; success.value = false; }, { flush: 'sync' });
let loadRevision = 0;
let polling: ReturnType<typeof setInterval> | undefined; let disposed = false;
const valid = computed(() => accepted.value && licenseCodeSchema.safeParse(code.value).success && !!catalog.value);
const expiry = computed(() => subscription.value?.expiresAt ? new Date(subscription.value.expiresAt).toLocaleString('zh-CN', { hour12: false }) : null);
async function load() {
  if (disposed || busy.value) return;
  const revision = ++loadRevision;
  reading.value = true; readError.value = '';
  try {
    if (props.mode === 'guest') { const result = await api('/api/plans'); if (revision === loadRevision) catalog.value = result; }
    else { const result = await api(props.mode === 'desktop' ? '/local/subscription' : '/api/subscription'); if (revision === loadRevision) { catalog.value = result.catalog; subscription.value = result.subscription; trial.value = result.trial; } }
  } catch (e: any) { if (revision === loadRevision) readError.value = e.message; } finally { if (revision === loadRevision) reading.value = false; }
}
async function activate() {
  if (!valid.value || busy.value) return; loadRevision++; reading.value = false; busy.value = true; error.value = ''; success.value = false;
  try {
    const submitted = code.value;
    const result = await api(props.mode === 'desktop' ? '/local/license' : '/api/subscription/redeem', { code: submitted.trim(), termsVersion: catalog.value!.termsVersion });
    catalog.value = result.catalog; subscription.value = result.subscription; trial.value = result.trial; readError.value = ''; if (code.value === submitted) code.value = ''; accepted.value = false; success.value = true; emit('changed', result.subscription);
  } catch (e: any) { error.value = e.message; } finally { busy.value = false; }
}
function refreshEligibility() { if (!disposed && !busy.value && !reading.value && !ordersOpen.value && document.visibilityState === 'visible') void load(); }
onMounted(() => { void load(); polling = setInterval(refreshEligibility, 15000); document.addEventListener('visibilitychange', refreshEligibility); window.addEventListener('online', refreshEligibility); });
onUnmounted(() => { disposed = true; loadRevision++; clearInterval(polling); document.removeEventListener('visibilitychange', refreshEligibility); window.removeEventListener('online', refreshEligibility); });
</script>
<template>
  <div v-show="!ordersOpen" class="modal-backdrop subscription-backdrop">
    <section class="modal subscription-modal" role="dialog" aria-modal="true" aria-labelledby="subscription-title">
      <div class="modal-title"><h2 id="subscription-title">订阅与权益</h2><button class="icon-button" title="关闭订阅" :disabled="busy" @click="emit('close')"><X :size="20"/></button></div>
      <div v-if="subscription" class="subscription-current"><strong :class="subscription.access ? 'good' : 'warning'">{{ subscriptionLabel(subscription) }}</strong><span v-if="expiry">有效至 {{ expiry }}</span></div>
      <div v-if="subscription?.disabled" class="subscription-disabled" role="alert"><strong>该设备已被管理员封禁</strong><p>远程功能、购买、试用、授权码、更新和问题反馈均已禁用，请联系运营方处理。</p><span v-if="catalog?.supportContact">联系方式：{{ catalog.supportContact }}</span></div>
      <div v-if="!subscription?.disabled && mode !== 'guest' && trial && !trial.used" class="trial-offer"><p v-if="trial.reason" class="small muted">{{ trial.reason }}</p><label v-if="trial.available" class="trial-accept"><input v-model="accepted" type="checkbox">我已阅读并同意服务与隐私说明</label><button class="button primary" :disabled="busy || !accepted || !trial.available" @click="claimTrial"><Check :size="17"/>免费试用七天</button></div>
      <div v-if="reading && !catalog" class="subscription-loading" role="status"><RefreshCw class="spin" :size="20"/>正在读取</div>
      <template v-if="catalog && !subscription?.disabled">
        <p v-if="!catalog.salesOpen" class="muted small sales-state">购买暂未开放</p>
        <form v-if="mode !== 'guest'" class="license-form" @submit.prevent="activate"><label for="license-code">授权码</label><div class="password-field"><input id="license-code" v-model="code" :type="showCode ? 'text' : 'password'" maxlength="64" autocomplete="off" autocapitalize="none" spellcheck="false" class="large-input license-input"><button type="button" class="icon-button" :title="showCode ? '隐藏授权码' : '显示授权码'" @click="showCode = !showCode"><EyeOff v-if="showCode" :size="18"/><Eye v-else :size="18"/></button></div><label class="terms-accept"><input v-model="accepted" type="checkbox">我已阅读并同意上述服务与隐私说明</label><button class="button primary" :disabled="busy || !valid"><RefreshCw v-if="busy" class="spin" :size="17"/><KeyRound v-else :size="17"/>激活授权</button></form>
        <table class="plan-table"><thead><tr><th>期限</th><th>价格</th><th>开放状态</th><th v-if="mode !== 'guest'"></th></tr></thead><tbody><tr v-for="plan in catalog.plans" :key="plan.id"><td>{{ plan.name }}<small>{{ plan.days }} 天</small></td><td class="plan-price">¥{{ price(plan.priceFen) }}</td><td>{{ plan.id === 'trial' ? trial?.enabled && (trial.used || trial.available) ? '自助领取' : trial?.reason || plan.reason || '暂未开放' : plan.available ? '已开放' : plan.reason }}</td><td v-if="mode !== 'guest'"><button v-if="plan.id !== 'trial'" class="icon-button" :title="'购买' + plan.name" :disabled="!plan.available" @click="purchasePlan = plan.id; ordersOpen = true"><ShoppingCart :size="17"/></button></td></tr></tbody></table>
        <button v-if="mode !== 'guest'" class="text-button" @click="purchasePlan = undefined; ordersOpen = true"><ClipboardList :size="16"/>查看订单与续费</button>
        <dl class="subscription-limits"><div><dt>累计流量 / 聊天次数</dt><dd>不限</dd></div><div><dt>绑定电脑 / 在线终端</dt><dd>1 台 / 3 个，均可操作</dd></div><div><dt>图片与文件传输</dt><dd>最高 3Mbps，共享、非保底</dd></div><div><dt>单次附件</dt><dd>最多 5 个，每个 25MB，合计 50MB</dd></div><div><dt>续费方式</dt><dd>手动预付，不自动扣款</dd></div></dl>
        <details class="subscription-terms" open><summary>服务与隐私说明</summary><ul><li>独立的非官方连接工具，仅提供原电脑任务的远程连接，不含模型额度、ChatGPT 会员或云电脑；电脑需在线，客户端版本需受支持。</li><li>服务器可接触转发内容，不属于端到端加密；不在云端持久化聊天正文或照片。保留设备、订单、授权与容量统计，模型密钥留在电脑。附件保存在电脑，受剩余磁盘空间限制；未发送附件暂存最多 2GB、每个授权会话最多 20 个，已发送历史不计入暂存额度。</li><li>首笔付费七天退款保障；兼容问题按未使用期限核算，资金退款由运营者核验办理。换机须核验，原设备的订阅同时失效。</li><li>不得用于通用代理、文件分发、转售共享授权或恶意刷请求；不会按累计 GB 收费或额外限速。</li></ul><small>条款版本 {{ catalog.termsVersion }}</small></details>
        <div v-if="catalog.operatorName || catalog.supportContact" class="subscription-operator"><span>运营者：{{ catalog.operatorName }}</span><span>售后与退款：{{ catalog.supportContact }}</span></div>
      </template>
      <p v-if="success" class="activation-success" role="status"><Check :size="17"/>授权已激活</p>
      <div v-if="error || readError" class="alert" role="alert">{{ error || readError }}<button v-if="readError && !error" class="text-button" :disabled="busy" @click="load">重试读取</button></div>
    </section>
  </div>
  <OrdersPanel v-if="ordersOpen && mode !== 'guest' && !subscription?.disabled" :mode="mode" :initial-plan="purchasePlan" :device-id="deviceId" @close="ordersOpen = false" @changed="load"/>
</template>
<style scoped>
.trial-offer{padding:12px 0;border-bottom:1px solid #e2e8eb}.trial-accept{display:flex;gap:8px;font-size:12px;line-height:1.6;margin:8px 0}.subscription-disabled{padding:14px;border:1px solid #ecd2d2;background:#fff7f7;color:#8f353b;border-radius:6px;font-size:13px;line-height:1.7}.subscription-disabled p{margin:6px 0}.subscription-disabled span{font-size:12px}
.subscription-backdrop{z-index:60!important}.subscription-modal{width:100%;min-width:0;max-width:100%;padding:22px;max-height:calc(100dvh - 24px);overflow-x:hidden;overflow-y:auto}.subscription-current{display:flex;flex-direction:column;gap:5px;margin-bottom:16px}.subscription-current strong{font-size:15px}.subscription-current span{font-size:12px;color:#74818b}.subscription-current .good{color:#23825d}.subscription-current .warning{color:#a36826}.subscription-loading{display:flex;align-items:center;gap:10px;padding:28px 0}.sales-state{margin-bottom:10px}.plan-table{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}.plan-table th{text-align:left;font-weight:500;color:#75818a}.plan-table th,.plan-table td{padding:10px 5px;border-bottom:1px solid #e2e8eb;overflow-wrap:anywhere}.plan-table td small{display:block;color:#7c8891;font-size:11px}.plan-table .plan-price{font-variant-numeric:tabular-nums;white-space:nowrap;font-size:15px}.plan-table th:nth-child(1){width:31%}.plan-table th:nth-child(2){width:21%}.subscription-limits{font-size:12px;margin:18px 0}.subscription-limits>div{display:flex;gap:12px;padding:6px 0}.subscription-limits dt{color:#71818a;flex:0 0 42%}.subscription-limits dd{margin:0;flex:1;min-width:0;overflow-wrap:anywhere}.subscription-terms{font-size:12px;line-height:1.7;color:#61727c;border-top:1px solid #e2e8eb;padding-top:13px}.subscription-terms summary{cursor:pointer;color:#344d5d}.subscription-terms ul{padding-left:18px}.subscription-operator{display:flex;flex-direction:column;gap:5px;font-size:12px;margin-top:14px;overflow-wrap:anywhere}.license-form{border-top:1px solid #e2e8eb;margin-top:17px}.license-input{font-family:Consolas,monospace;font-size:14px;height:46px}.license-form .terms-accept{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.6}.terms-accept input{margin:3px 0 0;flex-shrink:0}.activation-success{display:flex;align-items:center;gap:7px;font-size:13px;color:#23825d;margin-top:14px}@media(max-width:400px){.subscription-backdrop{padding:12px}.subscription-modal{padding:17px}.subscription-limits dt{flex-basis:40%}}
</style>
