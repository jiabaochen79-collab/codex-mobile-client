<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { Brain, Check, ChevronRight, Images, RefreshCw, Terminal, TriangleAlert } from 'lucide-vue-next';
import MessageContent from './MessageContent.vue';
import { processEntries, type DisplayTurn } from './conversation-model';

const props = defineProps<{ turn: DisplayTurn; conversationId: string; deviceId?: string; waiting: boolean }>();
const emit = defineEmits<{ change: [update: () => void] }>();
const running = computed(() => props.turn.status === 'inProgress');
const hasResult = computed(() => props.turn.results.length > 0);
const expanded = ref(running.value && !hasResult.value);
const expandedBatches = reactive(new Set<string>());
watch([running, hasResult], () => { expanded.value = running.value && !hasResult.value; expandedBatches.clear(); });
const current = computed(() => {
  if (!running.value || props.waiting || hasResult.value) return undefined;
  const active = props.turn.process.findLast(message => message.role === 'tool' && message.status === 'inProgress');
  const last = props.turn.process.at(-1);
  return active ?? (last?.role === 'tool' && !last.images?.length && !last.status ? last : undefined);
});
const thinking = computed(() => {
  const last = props.turn.process.at(-1);
  return running.value && !props.waiting && !hasResult.value && !current.value && last?.phase === 'reasoning' ? last.text.replace(/\s+/g, ' ').trim() : '';
});
const entries = computed(() => processEntries(props.turn.process).map(entry => ({
  ...entry,
  current: entry.messages.find(message => message.id === current.value?.id),
  messages: entry.messages.filter(message => message.id !== current.value?.id)
})));
const operationCount = computed(() => props.turn.process.filter(message => message.role === 'tool').length);
const failures = computed(() => props.turn.process.filter(message => ['failed', 'declined'].includes(message.status ?? '')).length);
const heading = computed(() => running.value ? props.waiting ? '等待确认' : hasResult.value ? '正在整理答复' : '正在处理' : props.turn.status === 'failed' ? '任务未完成' : props.turn.status === 'interrupted' ? '已停止' : '已处理');
function toggleBatch(id: string) { emit('change', () => { if (expandedBatches.has(id)) expandedBatches.delete(id); else expandedBatches.add(id); }); }
</script>
<template>
  <details class="turn-process" :open="expanded">
    <summary class="process-heading" :data-scroll-key="`process:${turn.id}`" @click.prevent="emit('change', () => expanded = !expanded)">
      <ChevronRight :size="14" class="process-chevron"/>
      <RefreshCw v-if="running && !waiting" :size="14" class="spin"/><TriangleAlert v-else-if="turn.status === 'failed'" :size="14"/><Check v-else-if="!running" :size="14"/>
      <span>{{ heading }}</span><small v-if="operationCount">{{ operationCount }} 项操作</small><small v-if="failures" class="process-warning">{{ failures }} 项失败</small>
    </summary>
    <div v-if="expanded" class="process-content">
      <template v-for="entry in entries" :key="entry.id">
        <MessageContent v-if="entry.kind === 'message'" :message="entry.messages[0]!" :conversation-id="conversationId" :device-id="deviceId"/>
        <template v-else>
          <details v-if="entry.messages.length" class="tool-batch" :open="expandedBatches.has(entry.id)">
            <summary :data-scroll-key="`batch:${turn.id}:${entry.id}`" @click.prevent="toggleBatch(entry.id)">
              <ChevronRight :size="13" class="batch-chevron"/><Images v-if="entry.kind === 'images'" :size="14"/><Terminal v-else :size="14"/>
              <span>{{ entry.kind === 'images' ? `已查看 ${entry.messages.reduce((count, message) => count + (message.images?.length ?? 0), 0)} 张图像` : entry.messages.some(message => message.status === 'inProgress') ? '运行命令' : '运行了命令' }}</span>
              <small v-if="entry.kind === 'commands'">{{ entry.messages.length }} 项</small><small v-if="entry.messages.some(message => ['failed', 'declined'].includes(message.status ?? ''))" class="process-warning">含失败操作</small>
            </summary>
            <div v-if="expandedBatches.has(entry.id)" class="batch-content"><MessageContent v-for="message in entry.messages" :key="message.id" :message="message" :conversation-id="conversationId" :device-id="deviceId"/></div>
          </details>
          <MessageContent v-if="entry.current" class="current-command" :message="entry.current" :conversation-id="conversationId" :device-id="deviceId" live/>
        </template>
      </template>
      <div v-if="thinking" class="thinking-row" :data-scroll-key="`thinking:${turn.id}`" role="status"><Brain :size="14"/><span>正在思考：{{ thinking }}</span></div>
    </div>
  </details>
</template>
<style scoped>
.turn-process>summary,.tool-batch>summary{cursor:pointer;list-style:none}.turn-process>summary::-webkit-details-marker,.tool-batch>summary::-webkit-details-marker{display:none}
.process-content{border:0;margin:0;padding:4px 0 0}
.process-chevron,.batch-chevron{transition:transform .15s}.turn-process[open]>.process-heading>.process-chevron,.tool-batch[open]>summary>.batch-chevron{transform:rotate(90deg)}
.tool-batch{margin:4px 0 10px}.tool-batch>summary{display:flex;align-items:center;gap:7px;min-height:32px;min-width:0;font-size:12px}.tool-batch>summary svg,.thinking-row svg{flex-shrink:0}.tool-batch>summary small{font-size:11px;color:#819098}.batch-content{padding:4px 0 2px 20px}
.process-heading .process-warning,.tool-batch>summary .process-warning{color:#a35b2b}.thinking-row{display:flex;align-items:center;gap:8px;min-width:0;min-height:32px;font-size:12px;color:#78858c}.thinking-row span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style>
