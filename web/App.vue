<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef, type Component } from 'vue';
import { RefreshCw } from 'lucide-vue-next';
import { api } from './api';
const panel = shallowRef<Component>(); const error = ref('');
const loading = ref(false); let disposed = false; let retries = 0; let retry: ReturnType<typeof setTimeout> | undefined;
async function load() {
  if (disposed || panel.value || loading.value) return;
  clearTimeout(retry); loading.value = true; error.value = '';
  try {
    const mode = (await api('/api/bootstrap')).mode;
    const next = mode === 'desktop' ? (await import('./DesktopPanel.vue')).default : mode === 'mobile' ? (await import('./DevicesPanel.vue')).default : undefined;
    if (!next) throw new Error('服务器状态异常，请稍后重试。');
    if (!disposed) panel.value = next;
  } catch (e: any) {
    if (!disposed) { error.value = e.message; if (retries < 3) retry = setTimeout(() => { void load(); }, [1000, 3000, 10000][retries++]); }
  } finally { loading.value = false; }
}
function recover() { if (document.visibilityState === 'visible') { retries = 0; void load(); } }
function pageRestored(event: PageTransitionEvent) { if (event.persisted) recover(); }
onMounted(() => { window.addEventListener('online', recover); window.addEventListener('pageshow', pageRestored); document.addEventListener('visibilitychange', recover); void load(); });
onUnmounted(() => { disposed = true; clearTimeout(retry); window.removeEventListener('online', recover); window.removeEventListener('pageshow', pageRestored); document.removeEventListener('visibilitychange', recover); });
</script>
<template>
  <component :is="panel" v-if="panel" />
  <main v-else class="startup"><img src="/brand.png" alt="" width="40" height="40"><p role="status">{{ error || '正在连接' }}</p><button v-if="error" class="button" :disabled="loading" @click="retries = 0; load()"><RefreshCw :size="16"/>重试</button></main>
</template>
