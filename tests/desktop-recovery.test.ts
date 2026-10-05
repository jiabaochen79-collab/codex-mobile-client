import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { CodexDesktop } from '../src/agent/desktop.js';
import { NativeIpc } from '../src/agent/ipc.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('desktop task connection recovery', () => {
  it('requests a fresh snapshot after the cache expires even if the owner is unchanged', async () => {
    const desktop = new CodexDesktop('unused', resolve('fixture-codex-home'));
    vi.spyOn(desktop as any, 'known').mockReturnValue({});
    (desktop as any).followed.set('task', { id: 'task', owner: 'owner', state: { id: 'task', title: 'Old' }, revision: 1, ownerCheckedAt: 0 });
    vi.spyOn(NativeIpc.prototype, 'request').mockResolvedValue({ handledByClientId: 'owner' });
    const subscribe = vi.spyOn(desktop as any, 'requestSnapshot').mockImplementation(() => {
      (desktop as any).current.state = { id: 'task', title: 'Fresh after renewal' }; (desktop as any).wake.emit('task');
    });
    try {
      await (desktop as any).follow('task');
      expect(subscribe).toHaveBeenCalledTimes(1); expect((desktop as any).current.state.title).toBe('Fresh after renewal');
    } finally { desktop.close(); }
  });
  it('renews a lost follower subscription without navigation or another user action', async () => {
    vi.useFakeTimers();
    const desktop = new CodexDesktop('unused', resolve('fixture-codex-home'));
    vi.spyOn(desktop as any, 'known').mockReturnValue({});
    vi.spyOn(NativeIpc.prototype, 'request').mockResolvedValue({ handledByClientId: 'owner' });
    const navigate = vi.spyOn(desktop as any, 'appTool').mockResolvedValue({});
    const subscribe = vi.spyOn(desktop as any, 'requestSnapshot').mockImplementation(() => {
      if (subscribe.mock.calls.length === 2) {
        (desktop as any).current.state = { id: 'task', title: 'Recovered snapshot' };
        (desktop as any).wake.emit('task');
      }
    });
    try {
      const result = (desktop as any).follow('task', false);
      await vi.advanceTimersByTimeAsync(4000); await result;
      expect((desktop as any).current.state.title).toBe('Recovered snapshot');
      expect(navigate).not.toHaveBeenCalled(); expect(subscribe).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { desktop.close(); }
  });

  it('reactivates only an explicitly selected task after its follower timed out', async () => {
    const desktop = new CodexDesktop('unused', resolve('fixture-codex-home'));
    vi.spyOn(desktop as any, 'known').mockReturnValue({});
    (desktop as any).followed.set('task', { id: 'task', owner: 'owner', state: undefined, revision: 0, ownerCheckedAt: 0 });
    vi.spyOn(NativeIpc.prototype, 'request').mockResolvedValue({ handledByClientId: 'owner' });
    const navigate = vi.spyOn(desktop as any, 'appTool').mockResolvedValue({});
    vi.spyOn(desktop as any, 'requestSnapshot').mockImplementation(() => { (desktop as any).current.state = { id: 'task' }; (desktop as any).wake.emit('task'); });
    try {
      await (desktop as any).follow('task', true);
      expect(navigate).toHaveBeenCalledExactlyOnceWith('navigate_to_codex_page', { threadId: 'task' }, 'task');
    } finally { desktop.close(); }
  });
  it('rediscovers the task owner after an explicit recovery activation', async () => {
    const desktop = new CodexDesktop('unused', resolve('fixture-codex-home'));
    vi.spyOn(desktop as any, 'known').mockReturnValue({});
    (desktop as any).followed.set('task', { id: 'task', owner: 'old-owner', state: undefined, revision: 0, ownerCheckedAt: 0 });
    const discover = vi.spyOn(NativeIpc.prototype, 'request').mockResolvedValueOnce({ handledByClientId: 'old-owner' }).mockResolvedValue({ handledByClientId: 'new-owner' });
    const navigate = vi.spyOn(desktop as any, 'appTool').mockResolvedValue({});
    vi.spyOn(desktop as any, 'requestSnapshot').mockImplementation(() => { (desktop as any).current.state = { id: 'task' }; (desktop as any).wake.emit('task'); });
    try {
      await (desktop as any).follow('task', true);
      expect(navigate).toHaveBeenCalledTimes(1); expect(discover).toHaveBeenCalledTimes(2);
      expect((desktop as any).current.owner).toBe('new-owner');
    } finally { desktop.close(); }
  });

  it('cleans up a timed-out subscription and recovers a later passive read without navigation', async () => {
    vi.useFakeTimers();
    const desktop = new CodexDesktop('unused', resolve('fixture-codex-home'));
    vi.spyOn(desktop as any, 'known').mockReturnValue({});
    vi.spyOn(NativeIpc.prototype, 'request').mockResolvedValue({ handledByClientId: 'owner' });
    const navigate = vi.spyOn(desktop as any, 'appTool').mockResolvedValue({});
    const subscribe = vi.spyOn(desktop as any, 'requestSnapshot').mockImplementation(() => {});
    try {
      const waiting = (desktop as any).follow('task', false).catch((error: any) => error);
      await vi.advanceTimersByTimeAsync(12000);
      expect(await waiting).toMatchObject({ code: 'CLIENT_UNAVAILABLE' });
      expect((desktop as any).followed.get('task').ownerCheckedAt).toBe(0); expect(vi.getTimerCount()).toBe(0);
      const calls = subscribe.mock.calls.length;
      await vi.advanceTimersByTimeAsync(6000); expect(subscribe).toHaveBeenCalledTimes(calls);
      subscribe.mockImplementation(() => { (desktop as any).current.state = { id: 'task', title: 'Recovered' }; (desktop as any).wake.emit('task'); });
      await (desktop as any).follow('task', false);
      expect((desktop as any).current.state.title).toBe('Recovered'); expect(navigate).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { desktop.close(); }
  });
  it('revalidates a cached owner and obtains a new snapshot after ownership changes', async () => {
    const desktop = new CodexDesktop('unused', resolve('fixture-codex-home'));
    vi.spyOn(desktop as any, 'known').mockReturnValue({});
    (desktop as any).followed.set('task', { id: 'task', owner: 'old-owner', state: { id: 'task' }, revision: 1, ownerCheckedAt: 0 });
    vi.spyOn(NativeIpc.prototype, 'request').mockResolvedValue({ handledByClientId: 'new-owner' });
    vi.spyOn(desktop as any, 'requestSnapshot').mockImplementation(() => { (desktop as any).current.state = { id: 'task', title: 'Fresh' }; (desktop as any).wake.emit('task'); });
    const navigate = vi.spyOn(desktop as any, 'appTool').mockResolvedValue({});
    try { await (desktop as any).follow('task'); expect((desktop as any).current).toMatchObject({ owner: 'new-owner', state: { title: 'Fresh' } }); expect(navigate).not.toHaveBeenCalled(); }
    finally { desktop.close(); }
  });

  it('rejects a snapshot invalidated by a local IPC disconnect', async () => {
    const desktop = new CodexDesktop('unused', resolve('fixture-codex-home'));
    vi.spyOn(desktop as any, 'known').mockReturnValue({});
    vi.spyOn(NativeIpc.prototype, 'request').mockResolvedValue({ handledByClientId: 'owner' });
    vi.spyOn(desktop as any, 'requestSnapshot').mockImplementation(() => { (desktop as any).ipc.emit('disconnected'); (desktop as any).wake.emit('task'); });
    try { await expect((desktop as any).follow('task')).rejects.toMatchObject({ code: 'CLIENT_UNAVAILABLE' }); }
    finally { desktop.close(); }
  });

  it('waits for a delayed owner after one explicit activation', async () => {
    vi.useFakeTimers();
    const desktop = new CodexDesktop('unused', resolve('fixture-codex-home'));
    vi.spyOn(desktop as any, 'known').mockReturnValue({});
    const navigate = vi.spyOn(desktop as any, 'appTool').mockResolvedValue({});
    const started = Date.now();
    vi.spyOn(NativeIpc.prototype, 'request').mockImplementation(async () => Date.now() - started >= 2500 ? { handledByClientId: 'owner' } : {});
    vi.spyOn(desktop as any, 'requestSnapshot').mockImplementation(() => {
      const current = (desktop as any).current; current.state = { id: 'task' }; (desktop as any).wake.emit('task');
    });
    try {
      const result = (desktop as any).follow('task', true).then(() => null, (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(6500); expect(await result).toBeNull();
      expect(navigate).toHaveBeenCalledTimes(1);
      expect((desktop as any).current.owner).toBe('owner');
    } finally { desktop.close(); }
  });

  it('does not activate the desktop for a passive read', async () => {
    const desktop = new CodexDesktop('unused', resolve('fixture-codex-home'));
    vi.spyOn(desktop as any, 'known').mockReturnValue({});
    const navigate = vi.spyOn(desktop as any, 'appTool').mockResolvedValue({});
    vi.spyOn(NativeIpc.prototype, 'request').mockResolvedValue({});
    try {
      await expect((desktop as any).follow('task', false)).rejects.toMatchObject({ code: 'CLIENT_UNAVAILABLE' });
      expect(navigate).not.toHaveBeenCalled();
    } finally { desktop.close(); }
  });
});
