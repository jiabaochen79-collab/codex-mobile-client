import { nextTick, onUnmounted, ref, watch, type Ref } from 'vue';

export function useChatScroll(container: Ref<HTMLElement | undefined>, content: Ref<HTMLElement | undefined>) {
  const awayFromBottom = ref(false);
  let follow = true;
  let paused = false;
  let observer: ResizeObserver | undefined;
  type Anchor = { key: string; offset: number; top: number };
  let anchor: Anchor | null = null;
  function capture(): Anchor | null {
    const box = container.value; if (!box) return null;
    const top = box.getBoundingClientRect().top;
    const first = Array.from(box.querySelectorAll<HTMLElement>('[data-scroll-key]')).find(e => e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().bottom > top + 1);
    return first ? { key: first.dataset.scrollKey!, offset: first.getBoundingClientRect().top - top, top: box.scrollTop } : { key: '', offset: 0, top: box.scrollTop };
  }
  function restore(saved: Anchor | null) {
    const box = container.value; if (!box || !saved) return;
    const item = Array.from(box.querySelectorAll<HTMLElement>('[data-scroll-key]')).find(e => e.dataset.scrollKey === saved.key && e.getBoundingClientRect().height > 0);
    box.scrollTop = item ? box.scrollTop + item.getBoundingClientRect().top - box.getBoundingClientRect().top - saved.offset : saved.top;
  }
  function updateDistance() {
    const box = container.value;
    awayFromBottom.value = !!box && box.scrollHeight - box.clientHeight - box.scrollTop > 90;
  }
  function onScroll() { if (paused) return; updateDistance(); follow = !awayFromBottom.value; anchor = capture(); }
  function toBottom() {
    follow = true;
    const box = container.value; if (box) box.scrollTop = box.scrollHeight;
    updateDistance(); anchor = capture();
  }
  function layoutChanged() { if (paused) return; if (follow) toBottom(); else { restore(anchor); updateDistance(); } }
  async function change(update: () => void, mode: 'auto' | 'bottom' | 'preserve' = 'auto') {
    const saved = capture(); const shouldFollow = mode === 'bottom' || mode === 'auto' && follow;
    if (mode === 'preserve') follow = false;
    update(); await nextTick();
    if (paused) return;
    if (shouldFollow) toBottom(); else { restore(saved); updateDistance(); anchor = capture(); }
  }
  watch(content, element => {
    observer?.disconnect();
    if (!element) return;
    observer = new ResizeObserver(layoutChanged);
    if (!paused) observer.observe(element);
  }, { flush: 'post' });
  function reset() { follow = true; awayFromBottom.value = false; anchor = null; }
  function pause() { paused = true; observer?.disconnect(); }
  function resume() { paused = false; if (content.value) observer?.observe(content.value); layoutChanged(); }
  onUnmounted(() => observer?.disconnect());
  return { awayFromBottom, onScroll, toBottom, change, reset, layoutChanged, pause, resume };
}
