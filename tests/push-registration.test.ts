import { afterEach, describe, expect, it, vi } from 'vitest';
import { pushRegistration } from '../web/push-registration.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('bounded push registration', () => {
  it('fails promptly when worker registration is rejected instead of waiting on ready', async () => {
    const register = vi.fn().mockRejectedValue(new Error('registration failed'));
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => undefined, register, ready: new Promise(() => {}) } });
    await expect(pushRegistration()).rejects.toThrow('registration failed');
    expect(register).toHaveBeenCalledTimes(1);
  });
  it('times out an unactivated worker and clears the timer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ active: {} }), ready: new Promise(() => {}) } });
    const result = pushRegistration().then(() => '', e => e.message);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toContain('站内提醒仍可查看'); expect(vi.getTimerCount()).toBe(0);
  });
  it('uses the active registration without requesting another one', async () => {
    const registration = { active: {} }, register = vi.fn();
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => registration, register, ready: Promise.resolve(registration) } });
    await expect(pushRegistration()).resolves.toBe(registration); expect(register).not.toHaveBeenCalled();
  });
});
