import { afterEach, expect, it, vi } from 'vitest';
const child = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: child.call }) };
});
import { desktopModels } from '../src/agent/models.js';
afterEach(() => { vi.useRealTimers(); child.call.mockReset(); });
const catalog = { stdout: JSON.stringify({ models: [{ slug: 'fixture', display_name: 'Fixture', default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'high' }] }] }) };
it('model discovery does not block timers and shares concurrent/cached reads', async () => {
  vi.useFakeTimers(); child.call.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(catalog), 250)));
  const one = desktopModels('C:\\async-fixture\\codex.exe'); const two = desktopModels('C:\\async-fixture\\codex.exe'); const timer = vi.fn(); setTimeout(timer, 10);
  await vi.advanceTimersByTimeAsync(10); expect(timer).toHaveBeenCalledOnce(); expect(child.call).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(240); expect(await one).toHaveLength(1); expect(await two).toHaveLength(1);
  await desktopModels('C:\\async-fixture\\codex.exe'); expect(child.call).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(5000); const next = desktopModels('C:\\async-fixture\\codex.exe'); await vi.advanceTimersByTimeAsync(250); await next; expect(child.call).toHaveBeenCalledTimes(2);
});
it('failed model discovery is not cached and validates the executable boundary', async () => {
  child.call.mockRejectedValueOnce(new Error('fixture failure')).mockResolvedValue(catalog);
  await expect(desktopModels('C:\\retry-fixture\\codex.exe')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  expect(await desktopModels('C:\\retry-fixture\\codex.exe')).toHaveLength(1); expect(child.call).toHaveBeenCalledTimes(2);
  await expect(desktopModels('C:\\retry-fixture\\other.exe')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
});
