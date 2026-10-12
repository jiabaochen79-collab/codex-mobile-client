<script setup lang="ts">
import { computed } from 'vue';
import { ChevronDown, Pause, Target } from 'lucide-vue-next';
import type { ThreadGoal } from '../src/shared/protocol';
import { goalStatusNames } from './goal-mode';
const props = defineProps<{ goal: ThreadGoal; synced: boolean; canPause: boolean; turnStopped: boolean }>();
const label = computed(() => !props.synced ? '目标状态待同步' : props.goal.status === 'active' && props.turnStopped ? '本轮已停止，目标仍开启' : goalStatusNames[props.goal.status]);
defineEmits<{ pause: [] }>();
</script>

<template>
  <details class="task-goal" :class="goal.status" :key="`${goal.threadId}:${goal.createdAt}`">
    <summary :aria-label="`${label}，查看目标详情`"><Target :size="16"/><span>{{ label }}</span><ChevronDown :size="15"/></summary>
    <div class="goal-detail"><p>{{ goal.objective }}</p><small>{{ new Date(goal.updatedAt * 1000).toLocaleString() }}</small><small v-if="goal.tokenBudget">Token {{ goal.tokensUsed.toLocaleString() }} / {{ goal.tokenBudget.toLocaleString() }}</small><button v-if="goal.status === 'active'" type="button" class="text-button" :disabled="!canPause" @click="$emit('pause')"><Pause :size="14"/>暂停目标</button></div>
  </details>
</template>

<style scoped>
.task-goal{flex-shrink:0;border-bottom:1px solid #e1e7ea;color:#526771;background:#f7f9fa;min-width:0}.task-goal summary{display:flex;align-items:center;gap:8px;list-style:none;padding:8px 14px;font-size:12px;cursor:pointer}.task-goal summary::-webkit-details-marker{display:none}.task-goal summary>span{flex:1;min-width:0}.task-goal summary>svg{flex-shrink:0}.task-goal[open] summary>svg:last-child{transform:rotate(180deg)}.task-goal.active summary{color:#32695c}.task-goal.complete summary{color:#426d46}.task-goal.blocked summary,.task-goal.budgetLimited summary,.task-goal.usageLimited summary{color:#926127}.goal-detail{max-height:160px;overflow:auto;padding:0 14px 12px;overflow-wrap:anywhere}.goal-detail p{margin:0 0 8px;white-space:pre-wrap;font-size:13px;line-height:1.6}.goal-detail small{display:block;color:#718087;font-size:11px;line-height:1.6}
</style>
