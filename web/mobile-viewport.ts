export type ViewportMetrics = {
  innerWidth: number; innerHeight: number; clientWidth: number; clientHeight: number;
  scrollX: number; scrollY: number; cssHeight: number; probeTop: number;
  visual: { width: number; height: number; offsetTop: number; offsetLeft: number; scale: number } | null;
  editing: boolean; focusTag: string; visible: boolean;
};
export type ViewportSize = { height: number; top: number; keyboard: boolean; source: 'visual' | 'window' | 'css' };

export function viewportSize(metrics: ViewportMetrics): ViewportSize {
  const { visual, innerHeight, cssHeight, editing } = metrics;
  const positive = (value: number) => Number.isFinite(value) && value > 0;
  const unzoomed = !!visual && Math.abs(visual.scale - 1) < 0.02;
  const keyboard = !!visual && unzoomed && positive(visual.height) && editing && innerHeight - visual.height > 150;
  // A lone stale visualViewport value must not recreate a dismissed keyboard gap.
  const agreedVisual = !!visual && (Math.abs(innerHeight - visual.height) < 2 || positive(cssHeight) && Math.abs(cssHeight - visual.height) < 2);
  if (visual && unzoomed && positive(visual.height) && (keyboard || agreedVisual || visual.height > innerHeight)) {
    return { height: visual.height, top: Number.isFinite(visual.offsetTop) ? Math.max(0, visual.offsetTop) : 0, keyboard, source: 'visual' };
  }
  return { height: positive(innerHeight) ? innerHeight : positive(cssHeight) ? cssHeight : metrics.clientHeight, top: 0, keyboard: false, source: positive(innerHeight) ? 'window' : 'css' };
}

export function viewportOriginCorrection(metrics: ViewportMetrics, target: ViewportSize, actualTop: number, applied: number): number {
  if (target.keyboard || metrics.visual && Math.abs(metrics.visual.scale - 1) >= 0.02) return 0;
  const delta = target.top - actualTop;
  if (Math.abs(delta) < 0.5) return applied;
  const correction = applied + delta;
  return Number.isFinite(correction) && Math.abs(correction) <= target.height ? correction : 0;
}

export function viewportOriginHorizontalCorrection(metrics: ViewportMetrics, actualLeft: number, applied: number): number {
  // Desktop layouts intentionally center the fixed shell. Horizontal recovery is only for a phone-sized visual viewport.
  if (!metrics.visual || metrics.innerWidth > 900 || Math.abs(metrics.visual.scale - 1) >= 0.02) return 0;
  const correction = applied - actualLeft;
  return Number.isFinite(correction) && Math.abs(correction) <= Math.max(metrics.innerWidth, 1) ? correction : 0;
}

export function measureViewport(probe?: HTMLElement): ViewportMetrics {
  const focused = document.activeElement; const viewport = window.visualViewport;
  const editing = focused instanceof HTMLTextAreaElement && !focused.readOnly
    || focused instanceof HTMLInputElement && !focused.readOnly && !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'hidden'].includes(focused.type)
    || focused instanceof HTMLSelectElement || focused instanceof HTMLElement && focused.isContentEditable;
  const css = probe?.getBoundingClientRect();
  return {
    innerWidth, innerHeight, clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight,
    scrollX, scrollY, cssHeight: css?.height ?? 0, probeTop: css?.top ?? 0,
    visual: viewport ? { width: viewport.width, height: viewport.height, offsetTop: viewport.offsetTop, offsetLeft: viewport.offsetLeft, scale: viewport.scale } : null,
    editing: !!editing, focusTag: focused?.tagName ?? '', visible: document.visibilityState === 'visible'
  };
}
