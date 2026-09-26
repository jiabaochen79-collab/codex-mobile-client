<script setup lang="ts">
import { LoaderCircle } from 'lucide-vue-next';
defineProps<{ running?: boolean; unread?: boolean }>();
</script>
<template><span class="task-indicator" :title="running ? '正在执行' : unread ? '完成未读' : undefined"><LoaderCircle v-if="running" :size="14" class="spin" aria-label="正在执行"/><span v-else-if="unread" class="unread-dot" role="img" aria-label="完成未读"></span></span></template>
<style scoped>
.task-indicator{width:16px;height:18px;flex:0 0 16px;display:inline-flex;align-items:center;justify-content:center;color:#268169}
.unread-dot{width:7px;height:7px;display:block;background:#3279d5;border-radius:50%}
</style>
