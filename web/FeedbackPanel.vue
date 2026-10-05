<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ArrowLeft, Check, ImagePlus, Plus, RefreshCw, Send, X } from 'lucide-vue-next';
import { api } from './api';
import { feedbackCategories, feedbackStates, type FeedbackCreate } from '../src/shared/feedback';
import { preparePhoto } from './prepare-photo';
import { feedbackDraft } from './feedback-drafts';
const props = defineProps<{ mode: 'desktop' | 'mobile'; deviceId: string; status?: any }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const base = props.mode === 'desktop' ? '/local/feedback' : '/api/feedback';
const headers = props.mode === 'mobile' ? { 'X-Remote-Device': props.deviceId } : undefined;
const request = (path = '', body?: unknown) => api(base + path, body, headers);
const rows = ref<any[]>([]); const detail = ref<any>(); const writing = ref(false); const busy = ref(false); const error = ref(''); const page = ref(1); const total = ref(0);
const localTime = () => { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const text = ref(''); const category = ref<FeedbackCreate['category']>('connection'); const contact = ref(''); const images = ref<{ data: string }[]>([]); const extra = ref(false); const requestId = ref(crypto.randomUUID()); const occurredAt = ref(localTime());
const input = ref<HTMLInputElement>(); const pending = ref<any>(); const loaded = ref(false);
const draftKey = computed(() => props.deviceId + ':' + (detail.value?.ticket.id ?? 'new'));
const imageUrl = (id: string) => base + '/images/' + id + (props.mode === 'mobile' ? '?remoteDevice=' + props.deviceId : '');
const date = (n: number) => new Date(n).toLocaleString('zh-CN', { hour12: false });
const diagnostics = computed(() => {
  const source = props.mode; const userAgent = navigator.userAgent; const state = props.status;
  const base: any = { source, system: props.mode === 'desktop' ? 'Windows' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Android/.test(userAgent) ? 'Android' : /Windows/.test(userAgent) ? 'Windows' : 'other', browser: /Edg/.test(userAgent) ? 'Edge' : /Chrome|CriOS/.test(userAgent) ? 'Chrome' : /Firefox/.test(userAgent) ? 'Firefox' : /Safari/.test(userAgent) ? 'Safari' : 'other', connection: props.mode === 'desktop' ? state?.connection ?? 'unknown' : state?.online ? 'online' : 'offline' };
  if (/^[\d.]{1,30}$/.test(state?.helperVersion ?? '')) base.helperVersion = state.helperVersion;
  if (extra.value) { base.viewport = { width: innerWidth, height: innerHeight, visualHeight: visualViewport?.height ?? innerHeight, offsetTop: visualViewport?.offsetTop ?? 0 }; base.online = navigator.onLine; }
  return [base];
});
async function list() { try { const result = await request('?page=' + page.value); rows.value = result.rows; total.value = result.total; } catch (e: any) { error.value = e.message; } }
async function restore() { loaded.value = false; try { const saved = await feedbackDraft(draftKey.value); text.value = saved?.text ?? ''; images.value = saved?.images ?? []; contact.value = saved?.contact ?? ''; category.value = saved?.category ?? 'connection'; extra.value = saved?.extra ?? false; occurredAt.value = saved?.occurredAt ?? localTime(); requestId.value = saved?.requestId ?? crypto.randomUUID(); pending.value = saved?.pending; } catch { error.value = '浏览器无法保存反馈草稿，请保持页面打开。'; } loaded.value = true; }
async function saveDraft() { if (!loaded.value) return true; try { await feedbackDraft(draftKey.value, { text: text.value, images: images.value.map(i => ({ data: i.data })), contact: contact.value, category: category.value, extra: extra.value, occurredAt: occurredAt.value, requestId: requestId.value, pending: pending.value ? JSON.parse(JSON.stringify(pending.value)) : null }); return true; } catch { error.value = '草稿保存失败，请检查浏览器存储空间。'; return false; } }
watch([text, images, contact, category, extra, occurredAt, pending], () => { void saveDraft(); }, { deep: true });
async function show(row: any) { if (busy.value) return; busy.value = true; error.value = ''; try { detail.value = await request('/' + row.id); writing.value = false; await restore(); const through = detail.value.messages.at(-1)?.seq ?? 0; await request('/' + row.id + '/read', { through }); emit('changed'); } catch (e: any) { error.value = e.message; } finally { busy.value = false; } }
async function create() { if (busy.value) return; busy.value = true; try { if (!await saveDraft()) return; detail.value = undefined; writing.value = true; error.value = ''; await restore(); } finally { busy.value = false; } }
async function back() { if (busy.value) return; busy.value = true; try { if (!await saveDraft()) return; detail.value = undefined; writing.value = false; loaded.value = false; await list(); } finally { busy.value = false; } }
async function close() { if (busy.value) return; busy.value = true; try { if (await saveDraft()) emit('close'); } finally { busy.value = false; } }
async function photos(event: Event) { const selected = (event.target as HTMLInputElement).files; const files = selected ? Array.from(selected) : []; (event.target as HTMLInputElement).value = ''; busy.value = true; error.value = ''; try { if (images.value.length + files.length > 3) throw new Error('每条消息最多三张图片。'); for (const original of files) { if (original.size > 5 * 1024 * 1024) throw new Error('每张图片不能超过 5MB。'); const file = await preparePhoto(original, true); if (file.size > 5 * 1024 * 1024) throw new Error('转换后的图片超过 5MB。'); const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); }); images.value.push({ data }); } } catch (e: any) { error.value = e.message; } finally { busy.value = false; } }
async function send() {
  busy.value = true; error.value = '';
  try { const id = detail.value?.ticket.id; pending.value ??= { requestId: requestId.value, text: text.value, images: images.value, diagnostics: diagnostics.value, ...(!id ? { category: category.value, occurredAt: new Date(occurredAt.value).getTime(), contact: contact.value } : {}) }; if (!await saveDraft()) { pending.value = undefined; return; }
    const result = await request(id ? '/' + id + '/messages' : '', pending.value); const oldKey = draftKey.value; loaded.value = false; text.value = ''; images.value = []; pending.value = undefined; await feedbackDraft(oldKey, null); detail.value = result; writing.value = false; await restore(); emit('changed');
  } catch (e: any) {
    if (['INVALID', 'CAPACITY'].includes(e.code)) { pending.value = undefined; requestId.value = crypto.randomUUID(); error.value = e.message + ' 请修改反馈内容后重新提交。'; await saveDraft(); }
    else error.value = e.message + ' 草稿已保留，可重试原提交。';
  } finally { busy.value = false; }
}
async function state(value: string) {
  const ticketId = detail.value.ticket.id; busy.value = true; error.value = '';
  try { detail.value = await request('/' + ticketId + '/state', { state: value }); emit('changed'); }
  catch (e: any) {
    try { const current = await request('/' + ticketId); if (current.ticket.state === value) { detail.value = current; emit('changed'); return; } } catch {}
    error.value = e.message;
  } finally { busy.value = false; }
}
onMounted(list);
</script>
<template>
  <div class="modal-backdrop feedback-backdrop"><section class="modal feedback-panel" role="dialog" aria-modal="true" aria-label="问题反馈">
    <header class="modal-title"><button v-if="detail || writing" class="icon-button" title="返回反馈列表" :disabled="busy" @click="back"><ArrowLeft :size="20"/></button><h2>{{ detail ? '反馈详情' : writing ? '问题反馈' : '我的反馈' }}</h2><button class="icon-button" title="关闭反馈" :disabled="busy" @click="close"><X :size="20"/></button></header>
    <p class="small muted">此电脑已授权终端共享反馈记录。</p>
    <div v-if="error" class="alert" role="alert">{{ error }}</div>
    <template v-if="!detail && !writing"><button class="button primary" :disabled="busy" @click="create"><Plus :size="17"/>提交问题</button><p v-if="busy" class="muted" role="status">正在读取反馈</p><ul class="feedback-list"><li v-for="row in rows" :key="row.id"><button :disabled="busy" @click="show(row)"><strong>{{ feedbackCategories[row.category as keyof typeof feedbackCategories] }}<span v-if="row.unread" class="feedback-dot"/></strong><span>{{ feedbackStates[row.state as keyof typeof feedbackStates] }} · {{ date(row.updated) }}</span><small>{{ row.id }}</small></button></li></ul><p v-if="!rows.length" class="muted">暂无反馈</p><footer><button class="button" :disabled="busy || page <= 1" @click="page--; list()">上一页</button><span>{{ page }}</span><button class="button" :disabled="busy || page * 30 >= total" @click="page++; list()">下一页</button></footer></template>
    <template v-else>
      <div v-if="detail" class="feedback-thread"><p class="small muted">{{ detail.ticket.id }} · {{ feedbackStates[detail.ticket.state as keyof typeof feedbackStates] }}</p><article v-for="m in detail.messages" :key="m.id"><header>{{ m.actor === 'admin' ? '客服回复' : '我的消息' }} <time>{{ date(m.created) }}</time></header><p>{{ m.text }}</p><div class="feedback-pictures"><a v-for="picture in m.images" :key="picture.id" :href="imageUrl(picture.id)" target="_blank" rel="noreferrer"><img :src="imageUrl(picture.id)" alt="反馈截图" loading="lazy"></a></div></article><div class="feedback-actions"><button v-if="!['resolved','closed'].includes(detail.ticket.state)" class="button" :disabled="busy" @click="state('resolved')"><Check :size="16"/>确认解决</button><button v-else class="button" :disabled="busy" @click="state('open')"><RefreshCw :size="16"/>重新打开</button><button v-if="detail.ticket.state !== 'closed'" class="button" :disabled="busy" @click="state('closed')">关闭工单</button></div></div>
      <form @submit.prevent="send"><fieldset :disabled="busy || !!pending"><template v-if="writing"><label>问题分类<select v-model="category"><option v-for="(label, key) in feedbackCategories" :key="key" :value="key">{{ label }}</option></select></label><label>发生时间<input v-model="occurredAt" type="datetime-local" required></label><label>联系方式（选填）<input v-model="contact" maxlength="200" autocomplete="off"></label></template><label>{{ writing ? '问题描述' : '补充信息' }}<textarea v-model="text" required maxlength="8000" rows="4" placeholder="描述遇到的问题和操作步骤"/></label><div class="feedback-pictures"><div v-for="(picture, index) in images" :key="index"><img :src="'data:image/jpeg;base64,' + picture.data" alt="待提交截图"><button type="button" class="icon-button" title="移除截图" @click="images.splice(index, 1)"><X :size="15"/></button></div></div><input ref="input" type="file" accept="image/*" multiple hidden @change="photos"><button type="button" class="button" :disabled="images.length >= 3" @click="input?.click()"><ImagePlus :size="17"/>添加截图</button><label class="feedback-check"><input v-model="extra" type="checkbox">附带详细诊断</label><details><summary>预览将提交的诊断信息</summary><pre>{{ JSON.stringify(diagnostics, null, 2) }}</pre></details></fieldset><button class="button primary" :disabled="busy || !text.trim()"><RefreshCw v-if="busy" :size="17" class="spin"/><Send v-else :size="17"/>{{ pending ? '重试提交' : '提交' }}</button></form>
      <p class="small muted">诊断保留 30 天；工单关闭后截图保留 90 天、文字保留 180 天。请检查截图中是否包含密码或私人信息。</p>
    </template>
  </section></div>
</template>
<style scoped>
.feedback-backdrop{z-index:90}.feedback-panel{width:min(100%,640px);max-height:90dvh;overflow:auto;padding:20px}.feedback-panel h2{font-size:18px;flex:1}.feedback-panel label{display:grid;gap:7px;margin:14px 0;font-size:13px}.feedback-panel input,.feedback-panel select,.feedback-panel textarea{width:100%;min-width:0;box-sizing:border-box;font:inherit;padding:9px;border:1px solid #d9e1e7;border-radius:4px}.feedback-panel fieldset{border:0;margin:0;padding:0;min-width:0}.feedback-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;background:#f5f7f8;padding:10px}.feedback-panel p{overflow-wrap:anywhere}.feedback-panel footer,.feedback-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:12px 0}.feedback-list{padding:0;list-style:none}.feedback-list li{border-bottom:1px solid #e2e8eb}.feedback-list button{display:grid;gap:6px;width:100%;text-align:left;padding:15px 0;background:none;border:0;color:inherit;cursor:pointer}.feedback-list span,.feedback-list small{font-size:12px;color:#637381;overflow-wrap:anywhere}.feedback-thread article{padding:14px 0;border-bottom:1px solid #e2e8eb}.feedback-thread article header{font-size:12px;color:#607580}.feedback-thread article p{white-space:pre-wrap;line-height:1.7;font-size:14px}.feedback-thread time{float:right}.feedback-pictures{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.feedback-pictures>div{position:relative}.feedback-pictures img{width:84px;height:84px;object-fit:contain;background:#f2f5f7}.feedback-pictures button{position:absolute;right:0;top:0;background:white}.feedback-panel .feedback-check{display:flex;align-items:center}.feedback-check input{width:auto}.feedback-dot{display:inline-block!important;width:7px;height:7px;background:#2076ca;border-radius:50%;margin-left:7px}.feedback-panel details{margin:12px 0;font-size:12px}.feedback-panel>p.small{line-height:1.6}@media(max-width:400px){.feedback-panel{padding:14px}.feedback-actions{flex-wrap:wrap}.feedback-thread time{float:none;display:block}}
</style>
