import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installResumeReload } from '../web/resume-reload';

let storage: Map<string, string>; let document: EventTarget & { visibilityState: string; activeElement: null };
let window: EventTarget; let reload: ReturnType<typeof vi.fn>; let dispose: () => void;
const hiddenKey = 'remote-viewport-hidden-at'; const attemptKey = 'remote-viewport-reload-at';
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
  storage = new Map(); window = new EventTarget(); document = Object.assign(new EventTarget(), { visibilityState: 'visible', activeElement: null }); reload = vi.fn();
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('location', { reload });
  vi.stubGlobal('navigator', { userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 5, onLine: true });
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
});
afterEach(() => { dispose?.(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function start(allowed = () => true) { const recovery = installResumeReload(allowed); dispose = recovery.dispose; return recovery; }
function visible(value: boolean) { document.visibilityState = value ? 'visible' : 'hidden'; document.dispatchEvent(new Event('visibilitychange')); }
function returnAfter(ms: number) { visible(false); vi.advanceTimersByTime(ms); visible(true); }

it.each(['visible-first', 'pageshow-first'])('preserves close/reopen recovery across both lifecycle events: %s', order => {
  start().ready(); visible(false); window.dispatchEvent(new Event('pagehide')); vi.advanceTimersByTime(1000);
  if (order === 'pageshow-first') window.dispatchEvent(new Event('pageshow'));
  visible(true); window.dispatchEvent(new Event('pageshow')); vi.advanceTimersByTime(500);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(storage.has(hiddenKey)).toBe(false);
  expect(storage.has('remote-viewport-pagehide-at')).toBe(false);
});

it('does not cancel cold-restored close recovery when initial pageshow arrives', () => {
  storage.set(hiddenKey, String(Date.now() - 1000)); storage.set('remote-viewport-pagehide-at', String(Date.now() - 1000));
  start().ready(); window.dispatchEvent(new Event('pageshow')); vi.advanceTimersByTime(500);
  expect(reload).toHaveBeenCalledTimes(1);
});

it('reloads promptly when a closed page is restored, including a cold document', () => {
  start().ready(); window.dispatchEvent(new Event('pagehide')); window.dispatchEvent(new Event('pageshow')); vi.advanceTimersByTime(500);
  expect(reload).toHaveBeenCalledTimes(1); expect(storage.has('remote-viewport-pagehide-at')).toBe(false);
  dispose(); reload.mockClear(); storage.delete(attemptKey); storage.set('remote-viewport-pagehide-at', String(Date.now() - 1000)); start().ready(); vi.advanceTimersByTime(500);
  expect(reload).toHaveBeenCalledTimes(1);
});

it('reloads once after a long suspension, not on initial entry or short switches', () => {
  start().ready(); vi.advanceTimersByTime(1000); expect(reload).not.toHaveBeenCalled();
  returnAfter(59_999); vi.advanceTimersByTime(1000); expect(reload).not.toHaveBeenCalled();
  returnAfter(60_001); window.dispatchEvent(new Event('pageshow')); vi.advanceTimersByTime(500); expect(reload).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new Event('pagehide')); expect(storage.has(hiddenKey)).toBe(false);
  window.dispatchEvent(new Event('pageshow')); vi.advanceTimersByTime(1000); expect(reload).toHaveBeenCalledTimes(1);
});
it('waits for cold-restored authentication and consumes the marker before reloading', () => {
  storage.set(hiddenKey, String(Date.now() - 120_000)); const recovery = start();
  vi.advanceTimersByTime(2000); expect(reload).not.toHaveBeenCalled(); recovery.ready(); vi.advanceTimersByTime(500);
  expect(reload).toHaveBeenCalledTimes(1); expect(storage.has(hiddenKey)).toBe(false); expect(storage.has(attemptKey)).toBe(true);
  dispose(); start().ready(); vi.advanceTimersByTime(1000); expect(reload).toHaveBeenCalledTimes(1);
});
it('enforces cooldown across document reloads and ignores stale markers', () => {
  storage.set(hiddenKey, String(Date.now() - 120_000)); storage.set(attemptKey, String(Date.now() - 30_000));
  start().ready(); vi.advanceTimersByTime(500); expect(reload).not.toHaveBeenCalled(); dispose();
  storage.set(hiddenKey, String(Date.now() - 8 * 86_400_000)); start().ready(); vi.advanceTimersByTime(500); expect(reload).not.toHaveBeenCalled();
});
it('checks safety at execution and never schedules a surprise retry after a draft clears', () => {
  let safe = true; start(() => safe).ready(); returnAfter(120_000); safe = false; vi.advanceTimersByTime(500);
  safe = true; window.dispatchEvent(new Event('pageshow')); vi.advanceTimersByTime(1000); expect(reload).not.toHaveBeenCalled();
});
it.each(['pointerdown', 'keydown'])('cancels recovery when the user interacts: %s', event => {
  start().ready(); returnAfter(120_000); window.dispatchEvent(new Event(event)); vi.advanceTimersByTime(1000); expect(reload).not.toHaveBeenCalled();
});
it('does not reload while hidden or offline', () => {
  start().ready(); returnAfter(120_000); visible(false); vi.advanceTimersByTime(1000); expect(reload).not.toHaveBeenCalled();
  vi.stubGlobal('navigator', { userAgent: 'iPhone', onLine: false }); vi.advanceTimersByTime(120_000); visible(true); vi.advanceTimersByTime(500); expect(reload).not.toHaveBeenCalled();
});
it('fails closed when session storage cannot persist the loop guard', () => {
  start().ready(); returnAfter(120_000); vi.stubGlobal('sessionStorage', { getItem: () => null, removeItem() {}, setItem() { throw new Error('blocked'); } });
  vi.advanceTimersByTime(500); expect(reload).not.toHaveBeenCalled();
});
it('leaves desktop browsers unchanged', () => {
  vi.stubGlobal('navigator', { userAgent: 'Windows', platform: 'Win32', maxTouchPoints: 0, onLine: true });
  start().ready(); returnAfter(120_000); vi.advanceTimersByTime(500); expect(reload).not.toHaveBeenCalled(); expect(storage.size).toBe(0);
});
it('recovers Android browser close/reopen with the same draft and cooldown safeguards', () => {
  vi.stubGlobal('navigator', { userAgent: 'Android', platform: 'Linux', maxTouchPoints: 5, onLine: true });
  start().ready(); visible(false); window.dispatchEvent(new Event('pagehide')); vi.advanceTimersByTime(1000);
  visible(true); window.dispatchEvent(new Event('pageshow')); vi.advanceTimersByTime(500);
  expect(reload).toHaveBeenCalledTimes(1);
});
it('handles iPad desktop user agents and unregisters on disposal', () => {
  vi.stubGlobal('navigator', { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5, onLine: true });
  start().ready(); returnAfter(120_000); dispose(); vi.advanceTimersByTime(500); expect(reload).not.toHaveBeenCalled();
});
