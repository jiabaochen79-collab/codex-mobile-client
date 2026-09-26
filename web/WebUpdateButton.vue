<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { RefreshCw } from 'lucide-vue-next';
import { api } from './api';
const emit = defineEmits<{ refresh: [] }>(); const available = ref(false); let timer: ReturnType<typeof setInterval>;
async function check() { if (!import.meta.env.PROD || document.visibilityState !== 'visible') return; try { const result = await api('/api/web-version'); const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src; available.value = !!entry && !!result.entry && new URL(entry).pathname !== result.entry; } catch {} }
onMounted(() => { void check(); timer = setInterval(check, 60000); }); onUnmounted(() => clearInterval(timer));
</script>
<template><button v-if="available" class="text-button" title="网页已有新版本，保存草稿并刷新" @click="emit('refresh')"><RefreshCw :size="17"/>刷新更新</button></template>
