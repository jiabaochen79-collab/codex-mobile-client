<script setup lang="ts">
import { ref, watch } from 'vue';
import { FileText, Pencil, Play, Send, X } from 'lucide-vue-next';
import MessageContent from './MessageContent.vue';
import type { Interaction } from '../src/shared/protocol';
const props = defineProps<{ request: Interaction; conversationId: string; deviceId: string; disabled: boolean; supported: boolean }>();
const emit = defineEmits<{ submit: [action: 'implement' | 'revise', feedback?: string]; resized: [] }>();
const editing = ref(false); const feedback = ref('');
const draftKey = `plan-feedback:${props.deviceId}:${props.conversationId}:${props.request.id}`;
try { const saved = JSON.parse(sessionStorage.getItem(draftKey) ?? 'null'); if (saved?.detail === props.request.detail && typeof saved.feedback === 'string') { feedback.value = saved.feedback; editing.value = saved.editing === true; } } catch {}
watch([feedback, editing], () => { try { sessionStorage.setItem(draftKey, JSON.stringify({ detail: props.request.detail, feedback: feedback.value, editing: editing.value })); } catch {} }, { flush: 'sync' });
watch(editing, () => emit('resized'), { flush: 'post' });
</script>
<template>
  <div class="plan-request">
    <details @toggle="$emit('resized')"><summary><FileText :size="16"/>计划正文</summary><MessageContent :message="{ id: String(request.id), role: 'assistant', text: request.detail }" :conversation-id="conversationId" :device-id="deviceId"/></details>
    <p v-if="!supported" class="compatibility-notice">请更新电脑助手后处理计划。</p>
    <form v-else-if="editing" @submit.prevent="!disabled && feedback.trim() && emit('submit', 'revise', feedback.trim())">
      <label :for="`plan-feedback-${request.id}`">修改意见</label>
      <textarea :id="`plan-feedback-${request.id}`" v-model="feedback" rows="3" maxlength="4000" :disabled="disabled"/>
      <div class="plan-actions"><button type="button" class="icon-button" title="取消修改" :disabled="disabled" @click="editing = false"><X :size="18"/></button><button class="button primary" :disabled="disabled || !feedback.trim()"><Send :size="16"/>提交修改</button></div>
    </form>
    <div v-else class="plan-actions"><button class="button" :disabled="disabled" @click="editing = true"><Pencil :size="16"/>提出修改</button><button class="button primary" :disabled="disabled" @click="emit('submit', 'implement')"><Play :size="16"/>实施计划</button></div>
  </div>
</template>
<style scoped>
.plan-request{min-width:0}.plan-request summary{display:flex;align-items:center;gap:7px;cursor:pointer;padding:12px 0;color:#4d6470;font-size:13px}.plan-request details[open] summary{margin-bottom:8px}.plan-request .message{margin-bottom:10px}.plan-request label{display:block;margin:12px 0 7px;font-size:13px}.plan-request textarea{width:100%;min-height:90px;max-height:200px;resize:vertical;border:1px solid #cbd6da;border-radius:5px;padding:9px;font-size:16px}.plan-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:12px}.plan-actions .button{font-size:13px;padding:8px 10px}.plan-actions svg{flex-shrink:0}
</style>
