<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ChevronDown, Pause, Play, Target, Trash2 } from 'lucide-vue-next';
import type { ThreadGoal } from '../src/shared/protocol';
import { goalStatusDescriptions, goalStatusNames } from './goal-mode';
const props = defineProps<{ goal: ThreadGoal; synced: boolean; canPause: boolean; turnStopped: boolean; actionReason: string; resumeReason: string }>();
const label = computed(() => !props.synced ? '目标状态待同步' : props.goal.status === 'active' && props.turnStopped ? '本轮已停止，目标仍开启' : goalStatusNames[props.goal.status]);
const resumable = computed(() => ['paused', 'blocked', 'usageLimited'].includes(props.goal.status));
const clearing = ref(false);
watch(() => props.goal.revision, () => { clearing.value = false; });
defineEmits<{ pause: []; resume: []; clear: [] }>();
</script>

<template>
  <details class="task-goal" :class="goal.status" :key="`${goal.threadId}:${goal.createdAt}`">
    <summary :aria-label="`${label}，查看目标详情`"><Target :size="16"/><span>{{ label }}</span><button v-if="resumable" type="button" class="goal-resume text-button" :disabled="!!resumeReason" :title="resumeReason || '按原目标继续执行'" @click.stop.prevent="$emit('resume')"><Play :size="14"/>继续目标</button><ChevronDown :size="15"/></summary>
    <div class="goal-detail">
      <div class="goal-overview"><p>{{ goal.objective }}</p><small>{{ new Date(goal.updatedAt * 1000).toLocaleString() }}</small><small v-if="goal.tokenBudget">Token {{ goal.tokensUsed.toLocaleString() }} / {{ goal.tokenBudget.toLocaleString() }}</small></div>
      <p class="goal-explanation">{{ goalStatusDescriptions[goal.status] }}</p>
      <p v-if="actionReason || resumable && resumeReason" class="goal-reason" role="status">{{ actionReason || resumeReason }}</p>
      <div v-if="!clearing" class="goal-actions"><button v-if="goal.status === 'active'" type="button" class="text-button" :disabled="!canPause" @click="$emit('pause')"><Pause :size="14"/>暂停目标</button><button type="button" class="text-button" :disabled="!!actionReason" @click="clearing = true"><Trash2 :size="14"/>删除目标</button></div>
      <div v-else class="goal-clear-confirm"><p>仅删除目标，会话和历史消息会保留，当前任务继续执行。</p><div class="goal-actions"><button type="button" class="text-button" @click="clearing = false">取消</button><button type="button" class="text-button" :disabled="!!actionReason" @click="$emit('clear')">确认删除目标</button></div></div>
    </div>
  </details>
</template>

<style scoped>
.task-goal{flex-shrink:0;border-bottom:1px solid #e1e7ea;color:#526771;background:#f7f9fa;min-width:0}.task-goal summary{display:flex;align-items:center;gap:8px;list-style:none;padding:8px 14px;font-size:12px;cursor:pointer}.task-goal summary::-webkit-details-marker{display:none}.task-goal summary>span{flex:1;min-width:0}.task-goal summary>svg{flex-shrink:0}.task-goal[open] summary>svg:last-child{transform:rotate(180deg)}.task-goal.active summary{color:#32695c}.task-goal.complete summary{color:#426d46}.task-goal.blocked summary,.task-goal.budgetLimited summary,.task-goal.usageLimited summary{color:#926127}.goal-detail{display:flex;flex-direction:column;max-height:min(48dvh,300px);overflow:visible;padding:0 14px 12px;overflow-wrap:anywhere}.goal-detail p{margin:0 0 8px;white-space:pre-wrap;font-size:13px;line-height:1.6}.goal-detail small{display:block;color:#718087;font-size:11px;line-height:1.6}
.goal-resume{flex-shrink:0;font-size:12px;min-height:32px;padding:4px 6px}.goal-actions{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-top:8px}.goal-detail .goal-explanation{margin-top:8px;font-size:12px;color:#526771}.goal-detail .goal-reason{font-size:12px;color:#926127}.goal-clear-confirm{margin-top:8px}.goal-clear-confirm p{font-size:12px}.task-goal button:disabled{opacity:.55;cursor:not-allowed}
.goal-overview{min-height:24px;overflow:auto;flex:1 1 auto}.goal-detail>.goal-explanation,.goal-detail>.goal-reason,.goal-actions,.goal-clear-confirm{flex-shrink:0}
</style>
