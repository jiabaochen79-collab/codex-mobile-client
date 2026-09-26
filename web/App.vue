<script setup lang="ts">
import { onMounted, ref } from 'vue';
import DesktopPanel from './DesktopPanel.vue';
import MobilePanel from './DevicesPanel.vue';
import { api } from './api';
const mode = ref(''); const error = ref('');
onMounted(async () => { try { mode.value = (await api('/api/bootstrap')).mode; } catch (e: any) { error.value = e.message; } });
</script>
<template>
  <DesktopPanel v-if="mode === 'desktop'" />
  <MobilePanel v-else-if="mode === 'mobile'" />
  <main v-else class="startup"><img src="/brand.png" alt="" width="40" height="40"><p role="status">{{ error || '正在连接' }}</p></main>
</template>
