import { afterEach, expect, it, vi } from 'vitest';
import { CodexDesktop } from '../src/agent/desktop.js';
import { NativeIpc } from '../src/agent/ipc.js';
import { RemoteError } from '../src/shared/protocol.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture() {
  const adapter = new CodexDesktop('unused');
  vi.spyOn(adapter as any, 'known').mockImplementation(() => {});
  const navigate = vi.spyOn(adapter as any, 'appTool').mockResolvedValue({ navigated: true });
  vi.spyOn(adapter as any, 'requestSnapshot').mockImplementation(() => {
    const current = Reflect.get(adapter, 'current');
    current.state = { id: current.id };
    Reflect.get(adapter, 'wake').emit(current.id);
  });
  const request = vi.spyOn(NativeIpc.prototype, 'request');
  return { adapter, navigate, request, follow: () => (adapter as any).follow('task', true) };
}

it('waits for the owner to appear after navigation instead of failing on transient discovery errors', async () => {
  vi.useFakeTimers();
  const { adapter, navigate, request, follow } = fixture();
  request.mockRejectedValueOnce(new RemoteError('CLIENT_REJECTED', '电脑客户端拒绝操作：no-client-found'))
    .mockRejectedValueOnce(new RemoteError('CLIENT_REJECTED', '电脑客户端拒绝操作：no-client-found'))
    .mockRejectedValueOnce(new RemoteError('CLIENT_REJECTED', '电脑客户端拒绝操作：no-client-found'))
    .mockResolvedValue({ handledByClientId: 'owner' });
  try {
    const result = follow();
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(navigate).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(4);
    expect(Reflect.get(adapter, 'current').owner).toBe('owner');
  } finally { adapter.close(); }
});

it.each(['CLIENT_DENIED', 'OUTCOME_UNKNOWN'])('does not retry or navigate after %s owner discovery', async code => {
  const { adapter, navigate, request, follow } = fixture();
  request.mockRejectedValue(new RemoteError(code, 'Discovery failed'));
  try {
    await expect(follow()).rejects.toMatchObject({ code });
    expect(request).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  } finally { adapter.close(); }
});
