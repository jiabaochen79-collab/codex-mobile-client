import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { CodexDesktop } from '../src/agent/desktop.js';
import { NativeIpc } from '../src/agent/ipc.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('desktop task connection recovery', () => {
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
