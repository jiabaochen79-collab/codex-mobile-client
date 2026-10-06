import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as commerce from '../src/shared/commerce.js';
import * as subscription from '../src/shared/subscription.js';
import * as pairedDevices from '../src/shared/paired-devices.js';

const api = vi.fn(), ready = vi.fn(), dispose = vi.fn();
const instances: { page: any; mount: () => Promise<void>; unmount: () => void }[] = [];
const compiled = new Map(['OrdersPanel', 'DevicesPanel', 'UpdatePanel'].map(name => {
  const { descriptor } = parse(readFileSync(new URL(`../web/${name}.vue`, import.meta.url), 'utf8'));
  return [name, transformSync(compileScript(descriptor, { id: name }).content, { loader: 'ts', format: 'cjs', define: { 'import.meta.env.PROD': 'false' } }).code];
}));
function setup(name: string) {
  const mounted: (() => Promise<void>)[] = [], unmounted: (() => void)[] = [];
  const scope = vue.effectScope(), module = { exports: {} as any };
  // The component's setup and Vue reactivity are real; API and browser resources are isolated.
  new Function('require', 'module', 'exports', compiled.get(name)!)((id: string) => {
    if (id === 'vue') return { ...vue, onMounted: (fn: any) => mounted.push(fn), onUnmounted: (fn: any) => unmounted.push(fn) };
    if (id === './api') return { api };
    if (id === './resume-reload') return { installResumeReload: () => ({ ready, dispose }) };
    if (id === 'qrcode') return { toDataURL: async () => 'fixture-qr' };
    if (id.endsWith('/commerce')) return commerce;
    if (id.endsWith('/subscription')) return subscription;
    if (id.endsWith('/paired-devices')) return pairedDevices;
    if (id === 'lucide-vue-next' || id.endsWith('.vue')) return {};
    throw new Error('Unexpected setup import: ' + id);
  }, module, module.exports);
  const page = scope.run(() => module.exports.default.setup({ mode: 'mobile', deviceId: '123456789' }, { expose() {}, emit() {} }));
  let stopped = false;
  const instance = { page, mount: async () => { for (const fn of mounted) await fn(); }, unmount: () => { if (stopped) return; stopped = true; for (const fn of unmounted) fn(); scope.stop(); } };
  instances.push(instance); return instance;
}
function deferred() {
  let resolve!: (value: any) => void, reject!: (reason: any) => void;
  const promise = new Promise<any>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.useFakeTimers(); api.mockReset(); ready.mockReset(); dispose.mockReset();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', { visibilityState: 'visible', querySelector: () => undefined, addEventListener: vi.fn(), removeEventListener: vi.fn(), documentElement: { classList: { toggle: vi.fn(), remove: vi.fn() } } });
  vi.stubGlobal('navigator', { serviceWorker: { addEventListener: vi.fn(), removeEventListener: vi.fn() } });
  vi.stubGlobal('history', { scrollRestoration: 'auto' }); vi.stubGlobal('location', { href: 'http://localhost/' });
  vi.stubGlobal('localStorage', { getItem: () => null }); vi.stubGlobal('sessionStorage', { getItem: () => null, setItem() {}, removeItem() {} });
});
afterEach(() => { for (const instance of instances.splice(0)) instance.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('U01 polling lifecycle', () => {
  it('stops update polling during installation and ignores a delayed pre-install state', async () => {
    const wait = deferred(); let reads = 0;
    api.mockImplementation(async path => {
      if (path === '/local/update/state') return ++reads === 1 ? { phase: 'ready' } : wait.promise;
      return path === '/local/state' ? { authorizedCount: 0 } : { accepted: true };
    });
    const instance = setup('UpdatePanel'); await instance.mount();
    await vi.waitFor(() => expect(instance.page.state.value?.phase).toBe('ready'));
    await vi.advanceTimersByTimeAsync(2000); expect(reads).toBe(2);
    await instance.page.act('install'); expect(instance.page.state.value.phase).toBe('installing');
    wait.resolve({ phase: 'ready' }); await vi.advanceTimersByTimeAsync(12000);
    expect(instance.page.state.value.phase).toBe('installing'); expect(reads).toBe(2);
    expect(api.mock.calls.filter(([path]) => path === '/local/state')).toHaveLength(1);
    instance.unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not make a secondary update read after unmounting during the first request', async () => {
    const wait = deferred(); api.mockReturnValue(wait.promise);
    const instance = setup('UpdatePanel'); await instance.mount(); instance.unmount();
    wait.resolve({ phase: 'ready' }); await vi.advanceTimersByTimeAsync(12000);
    expect(api).toHaveBeenCalledTimes(1); expect(instance.page.state.value).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['OrdersPanel', 'DevicesPanel'])('does not start %s polling after a delayed initial load outlives unmount', async name => {
    const wait = deferred(); api.mockReturnValue(wait.promise);
    const instance = setup(name); const mounting = instance.mount(); instance.unmount();
    wait.resolve(name === 'OrdersPanel' ? { orders: [], readiness: { channels: [] } } : { devices: [] }); await mounting;
    expect(vi.getTimerCount()).toBe(0); expect(window.addEventListener).not.toHaveBeenCalled(); expect(document.addEventListener).not.toHaveBeenCalled(); expect(ready).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledTimes(1);
  });
  it.each(['OrdersPanel', 'DevicesPanel'])('does not retry or poll %s after a delayed failure outlives unmount', async name => {
    const wait = deferred(); api.mockReturnValue(wait.promise);
    const instance = setup(name); const mounting = instance.mount(); instance.unmount();
    wait.reject(Object.assign(new Error('offline fixture'), { code: 'NETWORK' })); await mounting;
    expect(vi.getTimerCount()).toBe(0); expect(window.addEventListener).not.toHaveBeenCalled(); expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000); expect(api).toHaveBeenCalledTimes(1);
  });
  it('does not start orders polling if unmounted during the subscription read', async () => {
    const wait = deferred(); api.mockImplementation(async path => path === '/api/subscription' ? wait.promise : { orders: [], readiness: { channels: [] } });
    const instance = setup('OrdersPanel'); const mounting = instance.mount();
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith('/api/subscription', undefined, { 'X-Remote-Device': '123456789' }));
    instance.unmount(); wait.resolve({ catalog: { plans: [] } }); await mounting;
    expect(vi.getTimerCount()).toBe(0); expect(instance.page.data.value).toBeUndefined();
  });
  it.each(['OrdersPanel', 'DevicesPanel'])('%s polls while visible and leaves no resources after repeated mounts', async name => {
    api.mockImplementation(async path => path.includes('paired-devices') ? { devices: [] } : path.includes('subscription') ? { catalog: { plans: [] } } : { orders: [], readiness: { channels: [] } });
    for (let i = 0; i < 3; i++) {
      const instance = setup(name); await instance.mount(); expect(vi.getTimerCount()).toBe(1);
      if (name === 'DevicesPanel') instance.page.directoryOpen.value = true;
      api.mockClear(); await vi.advanceTimersByTimeAsync(name === 'OrdersPanel' ? 5000 : 15000); expect(api).toHaveBeenCalled();
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); api.mockClear(); await vi.advanceTimersByTimeAsync(15000); expect(api).not.toHaveBeenCalled();
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); instance.unmount(); expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(30000); expect(api).not.toHaveBeenCalled();
    }
    if (name === 'DevicesPanel') { expect(dispose).toHaveBeenCalledTimes(3); expect(navigator.serviceWorker.removeEventListener).toHaveBeenCalledTimes(3); expect(history.scrollRestoration).toBe('auto'); }
  });
});
