<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { Download, Pause, RefreshCw, X } from 'lucide-vue-next';
import { api } from './api';
const emit = defineEmits<{ close: [] }>(); const state = ref<any>(); const actionError = ref(''); const readError = ref(''); const busy = ref(false); const authorized = ref(0); const confirm = ref(false); let timer: ReturnType<typeof setInterval>;
let revision = 0; let reading = false; let closed = false;
async function load() {
  if (reading || closed) return; reading = true; const rev = revision;
  try { const next = await api('/local/update/state'); const local = await api('/local/state'); if (rev !== revision || closed) return; state.value = next; authorized.value = local.authorizedCount; readError.value = ''; }
  catch (e: any) { if (rev === revision && !closed) readError.value = e.message; }
  finally { reading = false; }
}
async function act(action: string, body = {}) {
  if (busy.value || state.value?.phase === 'installing') return;
  busy.value = true; revision++; actionError.value = ''; readError.value = '';
  try { await api('/local/update/' + action, body); if (action === 'install') { state.value.phase = 'installing'; confirm.value = false; } }
  catch (e: any) { actionError.value = e.message; }
  finally { busy.value = false; if (state.value?.phase !== 'installing') void load(); }
}
onMounted(() => { void load(); timer = setInterval(() => { if (!busy.value) void load(); }, 2000); }); onUnmounted(() => { closed = true; revision++; clearInterval(timer); });
const names: Record<string,string> = { idle: '尚未检查更新', checking: '正在检查', available: '发现新版本', downloading: '正在下载', ready: '新版本已就绪', installing: '正在安装并重启助手', error: '更新未完成' };
</script>
<template><div class="modal-backdrop"><section class="modal update-panel" role="dialog" aria-modal="true" aria-label="助手更新"><div class="modal-title"><h2>助手更新</h2><button class="icon-button" title="关闭更新" @click="emit('close')"><X :size="20"/></button></div><template v-if="state"><strong>{{ state.phase === 'idle' && state.checkedAt ? '已是最新版本' : names[state.phase] }} {{ state.version ? 'v' + state.version : '' }}</strong><progress v-if="state.phase === 'downloading'" :value="state.progress" max="100"/><span v-if="state.phase === 'downloading'">{{ state.progress }}%</span><p v-if="state.message">{{ state.message }}</p><p class="notes">{{ state.notes }}</p><label><input type="checkbox" :checked="state.autoDownload" :disabled="busy || state.phase === 'installing'" @change="act('settings', { autoDownload: ($event.target as HTMLInputElement).checked })">自动下载更新</label><div class="update-actions"><button class="button" :disabled="busy || ['checking','downloading','installing'].includes(state.phase)" @click="act('check')"><RefreshCw :size="17"/>检查更新</button><button v-if="state.phase === 'downloading'" class="button" :disabled="busy" @click="act('cancel')"><Pause :size="17"/>暂停</button><button v-if="['available','error'].includes(state.phase) && state.version" class="button" :disabled="busy" @click="act('download')"><Download :size="17"/>下载</button><button v-if="state.phase === 'ready'" class="button primary" :disabled="busy" @click="confirm = true"><Download :size="17"/>安装更新</button></div><template v-if="confirm"><p>{{ authorized ? '当前有远程终端授权，更新将短暂中断连接。' : '安装完成后将重新启动助手。' }}</p><button class="button primary" :disabled="busy" @click="act('install')">安装并重启助手</button><button class="text-button" :disabled="busy" @click="confirm = false">稍后</button></template></template><div v-if="actionError || readError" class="alert" role="alert">{{ actionError || readError }}</div></section></div></template>
<style scoped>.update-panel{padding:22px;max-width:500px}.update-panel h2{font-size:18px}.update-panel label{display:flex;gap:8px;font-size:13px;margin:14px 0}.update-panel progress{display:block;width:100%;margin:14px 0}.update-panel p{font-size:13px;line-height:1.7}.notes{white-space:pre-wrap;overflow-wrap:anywhere}.update-actions{display:flex;gap:8px;flex-wrap:wrap;margin:15px 0}</style>
