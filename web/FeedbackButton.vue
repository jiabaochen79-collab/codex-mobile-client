<script setup lang="ts">
import { defineAsyncComponent, onMounted, onUnmounted, ref } from 'vue';
import { MessageSquare } from 'lucide-vue-next';
import { api } from './api';
const FeedbackPanel = defineAsyncComponent(() => import('./FeedbackPanel.vue'));
const props = defineProps<{ mode: 'desktop' | 'mobile'; deviceId: string; status?: any; initiallyOpen?: boolean }>();
const open = ref(!!props.initiallyOpen); const unread = ref(0); let timer: ReturnType<typeof setInterval>;
let revision = 0, disposed = false;
async function refresh() { if (disposed || document.visibilityState === 'hidden') return; const current = ++revision; try { const result = await api(props.mode === 'desktop' ? '/local/feedback/unread' : '/api/feedback/unread', undefined, props.mode === 'mobile' ? { 'X-Remote-Device': props.deviceId } : undefined); if (!disposed && current === revision) unread.value = result.count; } catch {} }
onMounted(() => { void refresh(); timer = setInterval(refresh, 30000); }); onUnmounted(() => { disposed = true; revision++; clearInterval(timer); });
</script>
<template><button type="button" class="text-button feedback-entry" title="问题反馈" @click="open = true"><MessageSquare :size="17"/>问题反馈<span v-if="unread" class="unread-feedback" aria-label="有新回复"/></button><FeedbackPanel v-if="open" :mode="mode" :device-id="deviceId" :status="status" @close="open = false; refresh()" @changed="refresh"/></template>
<style scoped>.feedback-entry{display:flex;align-items:center;gap:9px;width:100%;padding:11px 12px;border:0;border-top:1px solid #e7ecee;background:none;color:#38545e;text-align:left;white-space:nowrap}.feedback-entry:hover{background:#f3f7f7}.unread-feedback{display:inline-block;width:7px;height:7px;border-radius:50%;background:#2076ca}</style>
