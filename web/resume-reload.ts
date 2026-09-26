// Mobile browsers can restore a stale native viewport even when DOM geometry looks correct.
export function installResumeReload(canReload: () => boolean) {
  if (!/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return { ready() {}, dispose() {} };
  const hiddenKey = 'remote-viewport-hidden-at'; const pagehideKey = 'remote-viewport-pagehide-at'; const attemptKey = 'remote-viewport-reload-at';
  const readTime = (key: string) => { try { return Number(sessionStorage.getItem(key)) || 0; } catch { return 0; } };
  let hiddenAt = readTime(hiddenKey); let pagehideAt = readTime(pagehideKey); let pending = false; let ready = false; let reloading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function cancel() { clearTimeout(timer); pending = false; }
  function schedule() {
    clearTimeout(timer);
    if (!pending || !ready || document.visibilityState !== 'visible') return;
    timer = setTimeout(() => {
      pending = false;
      const focus = document.activeElement;
      if (reloading || document.visibilityState !== 'visible' || !navigator.onLine || !canReload()
        || focus?.matches('input, textarea, select, [contenteditable="true"]')) return;
      const now = Date.now(); const previous = readTime(attemptKey);
      if (previous && now - previous < 300_000) return;
      try {
        sessionStorage.removeItem(hiddenKey);
        sessionStorage.setItem(attemptKey, String(now));
        if (readTime(attemptKey) !== now) return;
      } catch { return; }
      reloading = true; location.reload();
    }, 500);
  }
  function hide() {
    cancel(); if (reloading) return;
    hiddenAt ||= Date.now();
    try { sessionStorage.setItem(hiddenKey, String(hiddenAt)); } catch {}
  }
  function pagehide() {
    hide(); if (reloading) return;
    pagehideAt = Date.now();
    try { sessionStorage.setItem(pagehideKey, String(pagehideAt)); } catch {}
  }
  function resume() {
    if (document.visibilityState !== 'visible') return;
    if (pagehideAt || hiddenAt) {
      const elapsed = Date.now() - (pagehideAt || hiddenAt);
      pending ||= elapsed >= (pagehideAt ? 0 : 60_000) && elapsed <= 7 * 86_400_000;
      // pageshow and visibilitychange describe the same resume; consume both markers together.
      pagehideAt = 0; hiddenAt = 0;
      try { sessionStorage.removeItem(pagehideKey); sessionStorage.removeItem(hiddenKey); } catch {}
    }
    schedule();
  }
  function visibility() { if (document.visibilityState === 'hidden') hide(); else resume(); }
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', pagehide); window.addEventListener('pageshow', resume);
  window.addEventListener('pointerdown', cancel, true); window.addEventListener('keydown', cancel, true);
  resume();
  return {
    ready() { ready = true; schedule(); },
    dispose() {
      cancel(); document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pagehide); window.removeEventListener('pageshow', resume);
      window.removeEventListener('pointerdown', cancel, true); window.removeEventListener('keydown', cancel, true);
    }
  };
}
