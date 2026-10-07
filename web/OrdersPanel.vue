<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ArrowLeft, ArrowUpRight, Check, ClipboardList, Copy, CreditCard, QrCode, RefreshCw, Wallet, X } from 'lucide-vue-next';
import QRCode from 'qrcode';
import { api as requestApi } from './api';
import { money, paymentStatusNames, refundStatusNames, type PaymentOrder } from '../src/shared/commerce';
import { PAYMENT_TERMS_VERSION, type Catalog } from '../src/shared/subscription';
const props = defineProps<{ mode: 'desktop' | 'mobile'; initialPlan?: string; deviceId?: string }>();
const api = (path: string, body?: unknown) => requestApi(path, body, props.mode === 'mobile' && props.deviceId ? { 'X-Remote-Device': props.deviceId } : undefined);
const emit = defineEmits<{ close: []; changed: [] }>();
const base = props.mode === 'desktop' ? '/local/orders' : '/api/orders';
const view = ref(props.initialPlan ? 'buy' : 'orders'); const data = ref<any>(); const catalog = ref<Catalog>(); const selected = ref(props.initialPlan ?? 'month'); const channel = ref('wechat'); const accepted = ref(false);
const channels = computed(() => data.value?.readiness?.channels ?? []);
const loading = ref(false); const error = ref(''); const readError = ref(''); const active = ref<PaymentOrder>(); const payUrl = ref(''); const qr = ref(''); const copied = ref(false); const key = ref(crypto.randomUUID());
const refundTarget = ref<any>(); const refundReason = ref('first_purchase'); const explanation = ref('');
const historyPage = ref(1); const hasMore = ref(false); const loadingMore = ref(false);
function mergeRecords(previous: any[], incoming: any[]) { const ids = new Set(incoming.map(row => row.id)); return [...incoming, ...previous.filter(row => !ids.has(row.id))]; }
async function loadMore() {
  if (loadingMore.value || !hasMore.value || disposed) return;
  const target = historyPage.value + 1, owner = data.value?.ownerRevision, history = data.value?.historyRevision; loadingMore.value = true; error.value = '';
  try { const page = await api(`${base}?page=${target}`); if (disposed || !data.value || owner !== data.value.ownerRevision || history !== data.value.historyRevision || page.ownerRevision !== owner || page.historyRevision !== history) return; for (const key of ['orders', 'licenses', 'refunds']) { const ids = new Set(data.value[key].map((row: any) => row.id)); data.value[key].push(...page[key].filter((row: any) => !ids.has(row.id))); } historyPage.value = target; hasMore.value = page.hasMore === true; }
  catch (e: any) { if (!disposed) error.value = e.message; }
  finally { loadingMore.value = false; }
}
const plan = computed(() => catalog.value?.plans.find(p => p.id === selected.value));
const plans = computed(() => catalog.value?.plans.filter(p => p.id !== 'trial') ?? []);
const canBuy = computed(() => data.value?.readiness.ready && plan.value?.available && accepted.value && !loading.value && !data.value?.orders.some((o: PaymentOrder) => !['paid','closed','refunded'].includes(o.status)));
function changedChoice() { accepted.value = false; key.value = crypto.randomUUID(); }
const date = (value: number | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
let polling: ReturnType<typeof setInterval> | undefined;
let readRevision = 0, reading = false, disposed = false;
let paymentRevision = 0;
function returnToOrders() { paymentRevision++; active.value = undefined; payUrl.value = ''; qr.value = ''; view.value = 'orders'; }
async function load(force = false) {
  if (disposed || reading && !force) return;
  const revision = ++readRevision; reading = true;
  try { const orders = await api(base); if (disposed || revision !== readRevision) return;
    const ownerChanged = data.value?.ownerRevision !== undefined && orders.ownerRevision !== data.value.ownerRevision;
    if (ownerChanged) { historyPage.value = 1; returnToOrders(); refundTarget.value = undefined; }
    const refreshHistory = force || data.value?.historyRevision !== undefined && data.value.historyRevision !== orders.historyRevision;
    if (refreshHistory) for (let page = 2; page <= historyPage.value; page++) { const next = await api(`${base}?page=${page}`); if (disposed || revision !== readRevision) return; for (const key of ['orders', 'licenses', 'refunds']) orders[key].push(...next[key]); orders.hasMore = next.hasMore; }
    const info = await api(props.mode === 'desktop' ? '/local/subscription' : '/api/subscription');
    if (revision !== readRevision) return;
    const previous = new Map<string, string>((data.value?.orders ?? (active.value ? [active.value] : [])).map((order: PaymentOrder) => [order.id, order.status]));
    const entitlementChanged = orders.orders.some((order: PaymentOrder) => ['paid','refunded'].includes(order.status) && previous.get(order.id) !== order.status);
    if (data.value && historyPage.value > 1 && !refreshHistory) {
      const newHead = ['orders', 'licenses', 'refunds'].some(key => orders[key].some((row: any) => !data.value[key].some((old: any) => old.id === row.id)));
      for (const key of ['orders', 'licenses', 'refunds']) orders[key] = mergeRecords(data.value[key] ?? [], orders[key] ?? []);
      if (newHead) historyPage.value = 1;
    }
    if (refreshHistory || historyPage.value === 1) hasMore.value = orders.hasMore === true;
    data.value = orders; catalog.value = info.catalog;
    if (!channels.value.includes(channel.value)) channel.value = channels.value[0] ?? '';
    if (active.value) { const next = data.value.orders.find((o: PaymentOrder) => o.id === active.value!.id); if (next) active.value = next; }
    if (entitlementChanged) emit('changed');
    readError.value = '';
  } catch (e: any) { if (revision === readRevision) readError.value = e.message; }
  finally { if (revision === readRevision) reading = false; }
}
async function showPayment(result: any, revision: number) { const image = await QRCode.toDataURL(result.payUrl, { width: 260, margin: 2, errorCorrectionLevel: 'M' }); if (revision !== paymentRevision) return false; active.value = result.order; payUrl.value = result.payUrl; qr.value = image; copied.value = false; return true; }
async function openPayment(event: MouseEvent) {
  if (loading.value || !active.value) { event.preventDefault(); return; }
  event.preventDefault();
  const popup = window.open('about:blank', '_blank'); if (popup) popup.opener = null;
  loading.value = true; error.value = '';
  const revision = ++paymentRevision;
  try { if (!await showPayment(await api(`${base}/${active.value.id}/open`, {}), revision)) { popup?.close(); return; } if (popup) popup.location.replace(payUrl.value); else location.assign(payUrl.value); }
  catch (e: any) { popup?.close(); error.value = e.message; }
  finally { loading.value = false; }
}
async function create() {
  if (!canBuy.value) return; loading.value = true; error.value = ''; readRevision++; reading = false;
  const revision = ++paymentRevision;
  try { await showPayment(await api(base, { planId: selected.value, planRevision: plan.value!.revision, channel: channel.value, termsVersion: PAYMENT_TERMS_VERSION, idempotencyKey: key.value }), revision); key.value = crypto.randomUUID(); accepted.value = false; await load(true); }
  catch (e: any) { error.value = e.message; if (e.code === 'STALE') { accepted.value = false; key.value = crypto.randomUUID(); await load(true); } }
  finally { loading.value = false; }
}
async function open(order: PaymentOrder) { loading.value = true; error.value = ''; readRevision++; reading = false; const revision = ++paymentRevision; try { await showPayment(await api(`${base}/${order.id}/open`, {}), revision); } catch (e: any) { error.value = e.message; } finally { loading.value = false; } }
async function closeOrder(order: PaymentOrder) { loading.value = true; error.value = ''; readRevision++; reading = false; try { await api(`${base}/${order.id}/close`, {}); await load(true); } catch (e: any) { error.value = e.message; } finally { loading.value = false; } }
async function copyLink() {
  if (loading.value || !active.value) return; loading.value = true; error.value = ''; copied.value = false;
  const revision = ++paymentRevision;
  const link = api(`${base}/${active.value.id}/open`, {}).then(async result => { if (!await showPayment(result, revision)) throw new Error('已返回订单，付款链接操作已取消。'); return result.payUrl as string; });
  try {
    // Start the clipboard operation in the click gesture; Safari can resolve its data later.
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) await navigator.clipboard.write([new ClipboardItem({ 'text/plain': link.then(value => new Blob([value], { type: 'text/plain' })) })]);
    else await navigator.clipboard.writeText(await link);
    copied.value = true;
  } catch { error.value = '无法复制付款链接，请重试或返回订单重新打开。'; }
  finally { await link.catch(() => {}); loading.value = false; }
}
async function refund() { if (loading.value || !refundTarget.value) return; const target = refundTarget.value; loading.value = true; error.value = ''; readRevision++; reading = false; try { await api(`${base}/${target.id}/refund`, { reason: refundReason.value, explanation: explanation.value }); if (refundTarget.value === target) { refundTarget.value = undefined; explanation.value = ''; } await load(true); } catch (e: any) { if (refundTarget.value === target) error.value = e.message; } finally { loading.value = false; } }
onMounted(async () => { loading.value = true; await load(); if (disposed) return; loading.value = false; polling = setInterval(() => { if (!loading.value && document.visibilityState === 'visible') void load(); }, 5000); });
onUnmounted(() => { disposed = true; readRevision++; paymentRevision++; clearInterval(polling); });
</script>
<template>
  <div class="modal-backdrop purchase-backdrop">
    <section class="modal purchase-panel" role="dialog" aria-modal="true" aria-label="订单与续费">
      <div class="modal-title"><h2>订单与续费</h2><button class="icon-button" title="关闭订单" :disabled="loading" @click="emit('close')"><X :size="20"/></button></div>
      <div v-if="active" class="purchase-payment">
        <button class="text-button" @click="returnToOrders"><ArrowLeft :size="16"/>返回订单</button>
        <p class="purchase-device">设备 {{ active.deviceId }}</p><h3>{{ active.planName }} · {{ active.days }} 天</h3><strong class="purchase-price">¥{{ money(active.priceFen) }}</strong>
        <p class="purchase-state" :class="{ good: active.status === 'paid' }"><Check v-if="active.status === 'paid'" :size="18"/>{{ paymentStatusNames[active.status] }} · {{ active.serviceStatus }}</p>
        <template v-if="['pending','confirming'].includes(active.status)"><div class="purchase-payment-actions"><a class="button primary" :href="payUrl" target="_blank" rel="noopener noreferrer" @click="openPayment"><ArrowUpRight :size="17"/>{{ active.channel === 'alipay' ? '去支付宝支付' : '打开付款页面' }}</a><button class="text-button" :disabled="loading" @click="copyLink"><Check v-if="copied" :size="16"/><Copy v-else :size="16"/>{{ copied ? '已复制' : '复制付款链接' }}</button></div><p class="muted small">有效至 {{ date(active.expires) }}</p><img v-if="qr" :src="qr" class="purchase-qr" alt="本订单付款二维码" width="260" height="260"></template>
        <div v-if="active.lastError" class="alert">{{ active.lastError }}</div>
      </div>
      <template v-else-if="refundTarget">
        <h3>申请退款 · ¥{{ money(refundTarget.price_fen) }}</h3>
        <form @submit.prevent="refund"><label for="refund-reason">原因</label><select id="refund-reason" v-model="refundReason"><option value="first_purchase">首购七天保障</option><option value="unused">尚未开始使用</option><option value="incompatibility">客户端兼容问题</option></select><label for="refund-explanation">申请说明</label><textarea id="refund-explanation" v-model="explanation" minlength="5" maxlength="1000" required rows="3"/><button class="button primary" :disabled="loading || explanation.trim().length < 5"><Wallet :size="17"/>提交申请</button><button type="button" class="text-button" @click="refundTarget = undefined">取消</button></form>
      </template>
      <template v-else>
        <div class="purchase-tabs" role="tablist"><button role="tab" :aria-selected="view === 'buy'" @click="view = 'buy'"><CreditCard :size="17"/>购买 / 续费</button><button role="tab" :aria-selected="view === 'orders'" @click="view = 'orders'"><ClipboardList :size="17"/>我的订单</button></div>
        <p v-if="data" class="purchase-device">设备 {{ data.deviceId }}</p>
        <form v-if="view === 'buy'" @submit.prevent="create">
          <div v-if="data && !data.readiness.ready" class="alert" role="status">{{ data.readiness.reason }}</div>
          <label for="purchase-plan">套餐</label><select id="purchase-plan" v-model="selected" @change="changedChoice"><option v-for="p in plans" :key="p.id" :value="p.id" :disabled="!p.available">{{ p.name }} · {{ p.days }} 天 · ¥{{ money(p.priceFen) }}{{ p.available ? '' : '（未开放）' }}</option></select>
          <div v-if="channels.length" class="purchase-channels" role="radiogroup" aria-label="支付渠道"><label v-if="channels.includes('wechat')"><input v-model="channel" type="radio" value="wechat" @change="changedChoice">微信支付</label><label v-if="channels.includes('alipay')"><input v-model="channel" type="radio" value="alipay" @change="changedChoice">支付宝</label></div>
          <details class="purchase-terms"><summary>订阅服务及支付隐私条款</summary><p>预付 {{ plan?.days ?? 30 }} 天，绑定当前一台电脑，最多三个在线终端、一个控制端。不限累计流量，图片和文件最高 3Mbps 共享带宽，不自动扣款，不含模型额度或云电脑。</p><p>支付成功并经服务器核验后自动开通，续费接在剩余期限之后。微信和支付宝处理必要的订单、金额及支付身份信息；微信内付款需要取得 OpenID。中继可接触远控内容，不属于端到端加密，不持久化聊天正文或照片。</p><p>首笔付费七天内可申请退款；兼容问题按未使用期限核算。退款须审核并由渠道确认成功，处理中不提前撤销有效服务。换机需核验设备归属。</p><small>{{ PAYMENT_TERMS_VERSION }}</small></details>
          <label class="purchase-consent"><input v-model="accepted" type="checkbox">我已确认设备、金额并同意上述条款</label>
          <button class="button primary" :disabled="!canBuy"><RefreshCw v-if="loading" :size="17" class="spin"/><CreditCard v-else :size="17"/>创建订单 · ¥{{ money(plan?.priceFen ?? 0) }}</button>
          <p v-if="data?.orders.some((o:PaymentOrder) => !['paid','closed','refunded'].includes(o.status))" class="alert">有未结清订单</p>
        </form>
        <div v-else class="purchase-order-list">
          <div v-for="order in data?.orders ?? []" :key="order.id" class="purchase-order"><div><strong>{{ order.planName }} · ¥{{ money(order.priceFen) }}</strong><span>{{ date(order.created) }}</span><span>{{ paymentStatusNames[order.status] }} · {{ order.serviceStatus }}</span></div><div class="purchase-order-actions"><button v-if="['pending','confirming'].includes(order.status)" class="icon-button" title="打开付款" :disabled="loading" @click="open(order)"><QrCode :size="20"/></button><button v-if="['pending','confirming'].includes(order.status)" class="icon-button" title="关闭待支付订单" :disabled="loading" @click="closeOrder(order)"><X :size="19"/></button></div></div>
          <h3 v-if="data?.licenses.length">服务记录</h3><div v-for="item in data?.licenses ?? []" :key="item.id" class="purchase-order"><div><strong>¥{{ money(item.price_fen) }} · {{ item.source === 'online' ? '在线购买' : '人工授权' }}</strong><span>{{ item.refunded ? '已退款' : '有效至 ' + date(item.ends) }}</span></div><button v-if="item.price_fen && !item.refunded && !item.refund_pending && !data.refunds.some((r:any) => r.billing_order_id === item.id && r.state !== 'rejected')" class="icon-button" title="申请退款" @click="refundTarget = item"><Wallet :size="18"/></button></div>
          <div v-for="item in data?.refunds ?? []" :key="item.id" class="purchase-order"><span>退款 · {{ refundStatusNames[item.state] }}</span><span>{{ item.amount_fen == null ? '待审核' : '¥' + money(item.amount_fen) }}</span></div>
          <p v-if="data && !data.orders.length && !data.licenses.length" class="empty-state">暂无订单</p>
          <button v-if="hasMore" class="button" :disabled="loadingMore || loading" @click="loadMore"><RefreshCw v-if="loadingMore" :size="16" class="spin"/>{{ loadingMore ? '正在读取' : '加载更早的记录' }}</button>
        </div>
      </template>
      <div v-if="error || readError" class="alert" role="alert">{{ error || readError }}</div>
    </section>
  </div>
</template>
<style src="./purchase.css"/>
<style scoped>.purchase-payment-actions{display:flex;flex-direction:column;align-items:stretch;gap:7px;margin:18px 0 4px}.purchase-payment-actions .primary{width:100%;min-height:44px}</style>
