<script setup lang="ts">
import { computed } from 'vue';
import { Monitor, RefreshCw, X } from 'lucide-vue-next';
import type { RecoveryState } from '../src/shared/protocol';
const props = defineProps<{ state?: RecoveryState; busy: boolean; unavailable?: string; error?: string }>();
defineEmits<{ close: []; action: [action: 'launch' | 'pause' | 'enable'] }>();
const recovering = computed(() => ['backoff', 'launching', 'connecting'].includes(props.state?.phase ?? ''));
</script>
<template>
  <div class="modal-backdrop"><section class="modal recovery-modal" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
    <div class="modal-title"><h2 id="recovery-title">客户端恢复</h2><button class="icon-button" title="关闭客户端恢复" @click="$emit('close')"><X :size="20"/></button></div>
    <p class="recovery-status" role="status"><RefreshCw v-if="recovering" :size="18" class="spin"/><Monitor v-else :size="18"/><span>{{ state?.reason || '当前助手尚未提供恢复状态，请升级电脑助手。' }}</span></p>
    <label class="recovery-toggle"><input type="checkbox" :checked="state?.autoEnabled === true" :disabled="busy || !!unavailable || !state" @change="$emit('action', ($event.target as HTMLInputElement).checked ? 'enable' : 'pause')">异常退出后自动恢复</label>
    <p v-if="unavailable" class="compatibility-notice">{{ unavailable }}</p>
    <p v-if="error" class="alert" role="alert">{{ error }}</p>
    <button class="button primary" :disabled="busy || recovering || !!unavailable || !state" @click="$emit('action', 'launch')"><RefreshCw :size="17" :class="{ spin: busy }"/>{{ recovering ? '正在恢复客户端' : '恢复电脑客户端' }}</button>
    <p class="small muted">恢复后请核对原任务。中断任务和暂停队列不会自动继续。</p>
    <details v-if="state?.lastExit"><summary>最近退出记录</summary><dl><dt>时间</dt><dd>{{ new Date(state.lastExit.at).toLocaleString() }}</dd><dt>Codex 版本</dt><dd>{{ state.lastExit.version || '未知' }}</dd><dt>退出原因</dt><dd>{{ state.lastExit.cause === 'crash' ? '异常退出' : state.lastExit.cause === 'session-ending' ? 'Windows 会话结束' : '正常退出' }}</dd><dt>退出码</dt><dd>{{ state.lastExit.code }}</dd></dl></details>
  </section></div>
</template>
<style scoped>
.recovery-modal{max-width:440px;min-width:0}.recovery-status{display:flex;align-items:flex-start;gap:9px;line-height:1.6;overflow-wrap:anywhere}.recovery-status svg{flex:none;margin-top:3px}.recovery-toggle{display:flex;align-items:center;gap:9px;margin:20px 0}.recovery-modal>.button{margin:12px 0}.recovery-modal>.small{line-height:1.6}.recovery-modal details{margin-top:18px;font-size:12px}.recovery-modal summary{cursor:pointer;color:#637181}.recovery-modal dl{display:grid;grid-template-columns:90px minmax(0,1fr);gap:8px;margin:14px 0 0}.recovery-modal dd{margin:0;overflow-wrap:anywhere}
</style>
