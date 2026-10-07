import { nextTick, onUnmounted, ref, watch, type Ref } from 'vue';

export function useChatScroll(container: Ref<HTMLElement | undefined>, content: Ref<HTMLElement | undefined>) {
  const awayFromBottom = ref(false);
  let follow = true;
  let paused = false;
  let width = 0, height = 0;
  let observer: ResizeObserver | undefined;
  type Anchor = { key: string; offset: number; top: number };
  let anchor: Anchor | null = null;
  function capture(): Anchor | null {
    const box = container.value; if (!box) return null;
    const top = box.getBoundingClientRect().top;
    // Anchors are non-overlapping transcript rows in document order.
    const rows = box.querySelectorAll<HTMLElement>('[data-scroll-key]');
    let low = 0, high = rows.length;
    while (low < high) { const middle = (low + high) >>> 1; if (rows[middle].getBoundingClientRect().bottom <= top + 1) low = middle + 1; else high = middle; }
    const first = rows[low];
    return first ? { key: first.dataset.scrollKey!, offset: first.getBoundingClientRect().top - top, top: box.scrollTop } : { key: '', offset: 0, top: box.scrollTop };
  }
  function restore(saved: Anchor | null) {
    const box = container.value; if (!box || !saved) return;
    const item = box.querySelector<HTMLElement>(`[data-scroll-key="${CSS.escape(saved.key)}"]`);
    box.scrollTop = item ? box.scrollTop + item.getBoundingClientRect().top - box.getBoundingClientRect().top - saved.offset : saved.top;
  }
  function updateDistance() {
    const box = container.value;
    width = box?.clientWidth ?? 0; height = box?.clientHeight ?? 0;
    awayFromBottom.value = !!box && box.scrollHeight - box.clientHeight - box.scrollTop > 90;
  }
  function onScroll() {
    if (paused) return;
    const box = container.value;
    // A resized composer can emit a scroll event before ResizeObserver runs.
    if (box && (box.clientWidth !== width || box.clientHeight !== height)) { layoutChanged(); return; }
    updateDistance(); follow = !awayFromBottom.value; anchor = capture();
  }
  function toBottom() {
    follow = true;
    const box = container.value; if (box) box.scrollTop = box.scrollHeight;
    updateDistance(); anchor = capture();
  }
  function layoutChanged() { if (paused) return; if (follow) toBottom(); else { restore(anchor); updateDistance(); } }
  async function change(update: () => void, mode: 'auto' | 'bottom' | 'preserve' = 'auto') {
    const saved = capture(); const shouldFollow = mode === 'bottom' || mode === 'auto' && follow;
    update(); await nextTick();
    if (paused) return;
    if (shouldFollow) toBottom(); else { restore(saved); updateDistance(); anchor = capture(); }
  }
  watch([container, content], ([box, element]) => {
    observer?.disconnect();
    if (!box || !element) return;
    observer = new ResizeObserver(layoutChanged);
    if (!paused) { observer.observe(element); observer.observe(box); }
  }, { flush: 'post' });
  function reset() { follow = true; awayFromBottom.value = false; anchor = null; }
  function pause() { paused = true; observer?.disconnect(); }
  function resume() { paused = false; if (content.value) observer?.observe(content.value); if (container.value) observer?.observe(container.value); layoutChanged(); }
  onUnmounted(() => observer?.disconnect());
  return { awayFromBottom, onScroll, toBottom, change, reset, layoutChanged, pause, resume };
}
