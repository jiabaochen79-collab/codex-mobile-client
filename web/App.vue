<script setup lang="ts">
import { onMounted, ref, shallowRef, type Component } from 'vue';
import { api } from './api';
const panel = shallowRef<Component>(); const error = ref('');
onMounted(async () => { try { const mode = (await api('/api/bootstrap')).mode; if (mode === 'desktop') panel.value = (await import('./DesktopPanel.vue')).default; else if (mode === 'mobile') panel.value = (await import('./DevicesPanel.vue')).default; } catch (e: any) { error.value = e.message; } });
</script>
<template>
  <component :is="panel" v-if="panel" />
  <main v-else class="startup"><img src="/brand.png" alt="" width="40" height="40"><p role="status">{{ error || '正在连接' }}</p></main>
</template>
