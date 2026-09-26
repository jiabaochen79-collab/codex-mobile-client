<script setup lang="ts">
import { ref, watch } from 'vue';
import { Ticket, X } from 'lucide-vue-next';
const props = defineProps<{ deviceId: string; subscription?: any }>(); const emit = defineEmits<{ open: [] }>(); const message = ref('');
watch(() => props.subscription, value => {
  if (!value?.expiresAt || !['trial', 'expired'].includes(value.status)) { message.value = ''; return; }
  const remaining = value.expiresAt - value.serverTime; if (remaining > 48 * 3600000) { message.value = ''; return; }
  const phase = remaining > 0 ? 'soon' : 'expired';
  const key = `trial-notice:${props.deviceId}:${value.expiresAt}:${phase}`;
  try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch {}
  message.value = phase === 'soon' ? '试用将在 48 小时内到期' : '服务期限已结束，电脑任务不会停止';
}, { immediate: true });
</script>
<template><div v-if="message" class="trial-notice" role="status"><Ticket :size="15"/><button @click="emit('open')">{{ message }}</button><button title="关闭提醒" @click="message = ''"><X :size="15"/></button></div></template>
<style scoped>.trial-notice{display:flex;align-items:center;gap:6px;background:#f4f8f4;color:#3b674c;padding:7px 10px;flex-shrink:0;font-size:12px}.trial-notice button{border:0;background:none;color:inherit;font:inherit}.trial-notice button:first-of-type{flex:1;text-align:left}</style>
