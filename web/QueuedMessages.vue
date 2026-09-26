<script setup lang="ts">
import { ref } from 'vue';
import { ChevronDown, ChevronRight, ListOrdered, Play, RefreshCw, X } from 'lucide-vue-next';
import type { QueuedMessage } from '../src/shared/protocol';
defineProps<{ items: QueuedMessage[]; canRemove: boolean; canResume: boolean }>();
const emit = defineEmits<{ remove: [string]; resume: [string]; resized: [] }>();
const expanded = ref(true);
const status: Record<QueuedMessage['state'], string> = { pending: '电脑已保存，排队中', sending: '电脑正在发送', paused: '已暂停', uncertain: '结果待核对' };
</script>
<template>
  <section v-if="items.length" class="queued-messages" aria-label="待发送消息">
    <button type="button" class="queue-heading" :aria-expanded="expanded" @click="expanded = !expanded; emit('resized')"><ListOrdered :size="16"/><span>待发送 {{ items.length }}</span><ChevronDown v-if="expanded" :size="15"/><ChevronRight v-else :size="15"/></button>
    <div v-if="expanded" class="queue-items"><div v-for="item in items" :key="item.id" class="queue-item" :data-queue-id="item.id"><div class="queue-copy"><p :title="item.text">{{ item.text || (item.attachments.length ? '附件消息' : '内容不可读取') }}</p><small :class="{ warning: item.state === 'paused' || item.state === 'uncertain' }"><RefreshCw v-if="item.state === 'sending'" :size="12" class="spin"/>{{ item.reason || status[item.state] }}</small><small v-if="item.attachments.length" :title="item.attachments.map(a => a.name).join('、')">{{ item.attachments.map(a => a.name).join('、') }}</small></div><button v-if="item.state === 'paused'" type="button" class="icon-button" title="继续发送此消息" :disabled="!canResume" @click="emit('resume', item.id)"><Play :size="16"/></button><button type="button" class="icon-button" :title="item.state === 'uncertain' ? '移除待核对记录' : '取消排队消息'" :disabled="!canRemove || item.state === 'sending'" @click="emit('remove', item.id)"><X :size="17"/></button></div></div>
  </section>
</template>
<style scoped>
.queued-messages{border-top:1px solid #e3e8eb;margin-bottom:5px}.queue-heading{display:flex;align-items:center;gap:7px;width:100%;border:0;background:none;padding:8px 4px;color:#627983;font-size:12px}.queue-heading span{flex:1;text-align:left}.queue-items{max-height:152px;overflow:auto;overscroll-behavior:contain}.queue-item{display:flex;align-items:center;gap:4px;padding:6px 4px;border-top:1px solid #edf0f2;min-height:48px}.queue-copy{flex:1;min-width:0}.queue-copy p{font-size:12px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.queue-copy small{display:flex;align-items:center;gap:5px;font-size:10px;color:#7d8e96;margin-top:2px;overflow-wrap:anywhere}.queue-copy small.warning{color:#a26e27}.queue-item .icon-button{width:32px;height:36px;flex:0 0 32px}@media(max-width:620px){.queue-item .icon-button{height:44px;width:36px;flex-basis:36px}}
</style>
