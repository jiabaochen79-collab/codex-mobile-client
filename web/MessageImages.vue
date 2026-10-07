<script setup lang="ts">
import { nextTick, onDeactivated, onUnmounted, reactive, ref, watch } from 'vue';
import { ImageOff, RefreshCw, X } from 'lucide-vue-next';
import type { MessageImage } from '../src/shared/protocol';
const props = defineProps<{ conversationId: string; images: MessageImage[]; deviceId?: string }>();
const failed = reactive<Record<string, boolean>>({});
const attempts = reactive<Record<string, number>>({});
const selected = ref<MessageImage>(); const dialog = ref<HTMLDialogElement>();
const previewFailed = ref(false); const previewLoaded = ref(false); const previewAttempt = ref(0);
const url = (image: MessageImage, variant = 'thumbnail') => `/api/images/${encodeURIComponent(props.conversationId)}/${encodeURIComponent(image.id)}?${new URLSearchParams({ variant, ...(props.deviceId ? { remoteDevice: props.deviceId } : {}) })}`;
function retry(image: MessageImage) { failed[image.id] = false; attempts[image.id] = (attempts[image.id] ?? 0) + 1; }
async function preview(image: MessageImage) {
  selected.value = image; previewFailed.value = false; previewLoaded.value = false; previewAttempt.value = 0;
  await nextTick(); dialog.value?.showModal();
}
function retryPreview() { previewFailed.value = false; previewLoaded.value = false; previewAttempt.value++; }
function close() { dialog.value?.close(); selected.value = undefined; }
watch(() => props.images, images => {
  if (!selected.value || images.includes(selected.value)) return;
  const exact = images.find(image => image.id === selected.value!.id);
  const replacements = exact ? [exact] : images.filter(image => image.alt === selected.value!.alt);
  if (replacements.length !== 1) { close(); return; }
  const unchanged = exact?.id === selected.value.id;
  selected.value = replacements[0]; if (!unchanged) retryPreview();
});
onUnmounted(() => dialog.value?.close());
onDeactivated(close);
</script>
<template>
  <div class="message-images">
    <div v-for="photo in images" :key="photo.id" class="message-image">
      <div v-if="failed[photo.id]" class="image-failure" role="status"><ImageOff :size="24"/><span>图片无法加载</span><button class="text-button" @click="retry(photo)"><RefreshCw :size="15"/>重试</button></div>
      <button v-else class="image-thumbnail" :title="`查看大图：${photo.alt}`" @click="preview(photo)"><img :key="attempts[photo.id] ?? 0" :src="url(photo)" :alt="photo.alt" loading="lazy" decoding="async" @error="failed[photo.id] = true"></button>
    </div>
  </div>
  <dialog v-if="selected" ref="dialog" class="image-preview" aria-label="图片预览" @close="selected = undefined">
    <header><span>{{ selected.alt }}</span><button class="icon-button" title="关闭图片" autofocus @click="close"><X :size="24"/></button></header>
    <div class="image-preview-body">
      <div v-if="previewFailed" class="image-failure" role="status"><ImageOff :size="28"/><span>图片无法加载，请确认电脑在线</span><button class="text-button" @click="retryPreview"><RefreshCw :size="16"/>重试</button></div>
      <template v-else><RefreshCw v-if="!previewLoaded" class="spin image-loading" :size="24"/><img :key="previewAttempt" :src="url(selected, 'full')" :alt="selected.alt" @load="previewLoaded = true" @error="previewFailed = true"></template>
    </div>
  </dialog>
</template>
<style scoped>
.message-images{display:flex;flex-wrap:wrap;gap:8px;max-width:100%;margin:8px 0}
.message-image{width:300px;max-width:100%;aspect-ratio:4/3;border-radius:6px;overflow:hidden;background:#f2f4f5}
.image-thumbnail{display:block;width:100%;height:100%;padding:0;border:0;background:transparent}
.image-thumbnail img{display:block;width:100%;height:100%;object-fit:contain}
.image-failure{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;width:100%;height:100%;padding:16px;color:#78848b;font-size:13px;text-align:center;overflow-wrap:anywhere}
.image-failure button{display:inline-flex;align-items:center;gap:6px;min-height:40px}
.image-preview{position:fixed;inset:0;width:100%;max-width:100%;height:100dvh;max-height:100dvh;margin:0;padding:0;border:0;border-radius:0;background:#17191b;color:#fff;overflow:hidden}
.image-preview[open]{display:flex;flex-direction:column}
.image-preview::backdrop{background:#17191b}
.image-preview header{display:flex;align-items:center;gap:12px;padding:8px 12px;padding-top:max(8px,env(safe-area-inset-top));flex-shrink:0}
.image-preview header span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}
.image-preview .icon-button{color:#fff;width:44px;height:44px;flex-basis:44px}
.image-preview-body{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:auto;padding:8px 8px max(8px,env(safe-area-inset-bottom))}
.image-preview-body>img{display:block;max-width:100%;max-height:100%;object-fit:contain}
.image-preview .image-failure{color:#c1c8cd}
.image-preview .text-button{color:#a9cef8}
.image-loading{position:absolute;left:calc(50% - 12px);top:calc(50% - 12px)}
</style>
