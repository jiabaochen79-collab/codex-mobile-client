<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Check, Copy, CreditCard, RefreshCw } from 'lucide-vue-next';
import { api } from './api';
import { money, paymentStatusNames, type PaymentOrder } from '../src/shared/commerce';
const order = ref<PaymentOrder>(); const ready = ref(false); const loading = ref(true); const operationError = ref(''); const readError = ref(''); const error = computed(() => operationError.value || readError.value); const externalLink = ref(''); const copied = ref(false); let timer: ReturnType<typeof setInterval> | undefined;
const intendedOrder = ref(new URL(location.href).searchParams.get('order') ?? '');
const fragment = new URLSearchParams(location.hash.slice(1));
const needsExchange = ref(fragment.has('ticket') || fragment.has('oauthCode'));
function rememberOrder(id: string) { intendedOrder.value = id; history.replaceState(null, '', location.pathname + '?order=' + encodeURIComponent(id)); }
let reading = false, closed = false;
async function load() { if (reading) return; if (!intendedOrder.value) { readError.value = '请从订阅页面打开对应订单。'; return; } reading = true; try { const result = await api('/api/payments/session?orderId=' + encodeURIComponent(intendedOrder.value)); order.value = result.order; if (['paid','refunded','closed'].includes(result.order.status)) { operationError.value = ''; externalLink.value = ''; } ready.value = result.readiness.ready; readError.value = !ready.value && ['pending','confirming'].includes(result.order.status) ? result.readiness.reason : ''; } catch (e: any) { readError.value = e.message; ready.value = false; } finally { reading = false; } }
async function pay() {
  loading.value = true; operationError.value = '';
  try {
    const result = await api('/api/payments/start', { orderId: intendedOrder.value });
    if (result.kind === 'redirect') { location.assign(result.url); return; }
    if (result.kind === 'external-browser') { externalLink.value = result.payUrl; return; }
    if (result.kind === 'jsapi') {
      const bridge = (window as any).WeixinJSBridge; if (!bridge?.invoke) throw new Error('微信支付尚未就绪，请在微信内重新打开。');
      await new Promise<void>(resolve => bridge.invoke('getBrandWCPayRequest', result.params, () => resolve()));
      await api('/api/payments/recheck', { orderId: intendedOrder.value }); await load();
    }
  } catch (e: any) { operationError.value = e.message; } finally { loading.value = false; }
}
async function recheck() { loading.value = true; operationError.value = ''; try { await api('/api/payments/recheck', { orderId: intendedOrder.value }); await load(); } catch (e: any) { operationError.value = e.message; } finally { loading.value = false; } }
async function copy() { try { await navigator.clipboard.writeText(externalLink.value); copied.value = true; } catch { operationError.value = '无法复制链接。'; } }
async function initialize() {
  loading.value = true; readError.value = '';
  try {
    if (fragment.has('ticket')) rememberOrder((await api('/api/payments/session', { ticket: fragment.get('ticket') })).orderId);
    else if (fragment.has('oauthCode')) rememberOrder((await api('/api/payments/wechat/oauth/complete', { code: fragment.get('oauthCode'), state: fragment.get('state') })).orderId);
    fragment.delete('ticket'); fragment.delete('oauthCode'); fragment.delete('state'); needsExchange.value = false;
    history.replaceState(null, '', location.pathname + location.search);
    await load();
  } catch (e: any) { readError.value = e.message; } finally { loading.value = false; }
}
onMounted(async () => {
  await initialize();
  if (closed) return;
  timer = setInterval(() => { if (!loading.value && !needsExchange.value && document.visibilityState === 'visible') void load(); }, 3000);
});
onUnmounted(() => { closed = true; clearInterval(timer); });
</script>
<template>
    <div class="payment-app"><header class="app-header"><div class="brand"><img src="/brand.png" width="28" height="28" alt=""><span>ChatGPT 远程助手</span></div></header><main class="payment-main"><h1>订阅付款</h1><template v-if="order"><p class="purchase-device">设备 {{ order.deviceId }}</p><h2>{{ order.planName }} · {{ order.days }} 天</h2><strong class="purchase-price">¥{{ money(order.priceFen) }}</strong><p class="purchase-state" :class="{ good: order.status === 'paid' }"><Check v-if="order.status === 'paid'" :size="20"/>{{ paymentStatusNames[order.status] }} · {{ order.serviceStatus }}</p><p v-if="order.lastError" class="alert">{{ order.lastError }}</p><button v-if="['pending','confirming'].includes(order.status) && !externalLink" class="button primary" :disabled="loading || !ready" @click="pay"><RefreshCw v-if="loading" class="spin" :size="18"/><CreditCard v-else :size="18"/>{{ order.channel === 'wechat' ? '微信支付' : '支付宝付款' }}</button><button class="text-button" :disabled="loading" @click="recheck"><RefreshCw :size="16"/>查询订单状态</button></template><div v-if="externalLink" class="payment-external"><p>支付宝付款需在系统浏览器打开</p><button class="button" @click="copy"><Check v-if="copied" :size="17"/><Copy v-else :size="17"/>{{ copied ? '链接已复制' : '复制付款链接' }}</button></div><div v-if="error" class="alert" role="alert">{{ error }}</div><button v-if="needsExchange && !loading" class="button" @click="initialize"><RefreshCw :size="16"/>重新读取订单</button><p v-if="loading && !order" class="muted">正在读取订单</p></main></div>
</template>
<style src="./purchase.css"/>
