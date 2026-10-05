<script setup lang="ts">
import { computed } from 'vue';
import { Brain, ChevronRight, Terminal } from 'lucide-vue-next';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import MessageImages from './MessageImages.vue';
import type { Message } from '../src/shared/protocol';
import { presentUserMessage } from '../src/shared/user-message';
const props = defineProps<{ message: Message; conversationId: string; deviceId?: string; live?: boolean }>();
const html = computed(() => DOMPurify.sanitize(marked.parse(props.message.text, { async: false, breaks: true }) as string, { FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'style', 'form', 'input'], FORBID_ATTR: ['style'], ALLOW_DATA_ATTR: false }));
const userText = computed(() => presentUserMessage(props.message.text, props.message.images?.map(image => image.alt)));
const toolSummary = computed(() => props.message.text.replace(/\s+/g, ' ').trim() || '执行操作');
const expandableTool = computed(() => props.message.role === 'tool' && !props.message.images?.length);
const statusNames: Record<string, string> = { completed: '完成', inProgress: '执行中', failed: '失败', declined: '已拒绝', interrupted: '已停止' };
const statusText = computed(() => statusNames[props.message.status ?? ''] ?? props.message.status);
</script>
<template>
  <article :class="['message', message.role, { reasoning: message.phase === 'reasoning' }]" :data-scroll-key="`message:${message.id}`">
    <template v-if="message.role === 'user'"><MessageImages v-if="message.images?.length" :conversation-id="conversationId" :images="message.images" :device-id="deviceId"/><div v-if="userText" class="user-text">{{ userText }}</div></template>
    <details v-else-if="expandableTool" class="tool-message tool-step"><summary><ChevronRight :size="13" class="tool-chevron"/><Terminal :size="14"/><span class="tool-summary" :title="toolSummary">{{ live ? '正在运行：' : '' }}{{ toolSummary }}</span><span v-if="statusText && !live" class="muted small tool-status">{{ statusText }}</span></summary><pre>{{ message.text }}</pre></details>
    <div v-else-if="message.role === 'tool'" class="tool-message"><Terminal :size="14"/><span class="tool-summary">{{ toolSummary }}</span><span v-if="statusText" class="muted small tool-status">{{ statusText }}</span></div>
    <template v-else><div v-if="message.phase === 'reasoning'" class="reasoning-label"><Brain :size="14"/>思考摘要</div><div class="prose" v-html="html"></div></template>
    <MessageImages v-if="message.role !== 'user' && message.images?.length" :conversation-id="conversationId" :images="message.images" :device-id="deviceId"/>
  </article>
</template>
<style scoped>
.message.user{flex-direction:column;align-items:flex-end}
.tool-step{display:block}.tool-step>summary{display:flex;align-items:center;gap:8px;min-width:0;cursor:pointer;list-style:none}.tool-step>summary::-webkit-details-marker{display:none}.tool-step>summary svg{flex-shrink:0}.tool-step .tool-chevron{transition:transform .15s}.tool-step[open] .tool-chevron{transform:rotate(90deg)}
.tool-summary{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tool-status{flex-shrink:0}.tool-step>pre{margin:8px 0 2px 21px;padding:10px 12px;max-height:280px;overflow:auto;border:1px solid #e1e7e9;border-radius:5px;background:#f5f7f8;color:#334b55;font:11px/1.55 Consolas,"SFMono-Regular",monospace;white-space:pre-wrap;overflow-wrap:anywhere}
</style>
