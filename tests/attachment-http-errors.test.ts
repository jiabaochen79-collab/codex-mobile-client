import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAttachments } from '../web/use-attachments';
import type { Command } from '../src/shared/protocol';

vi.mock('../web/prepare-photo', () => ({ preparePhoto: async (file: File) => file }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture() {
  const file = new File(['fixture bytes'], 'fixture.txt', { type: 'text/plain' });
  const attachment = { id: crypto.randomUUID(), name: file.name, size: file.size, offset: 0, mediaType: file.type, ready: false };
  const request = vi.fn(async (command: Command) => {
    if (command.method === 'upload.complete') attachment.ready = true;
    return { ...attachment };
  });
  const uploads = useAttachments({ request, thread: () => 'fixture', deviceId: '123456789', control: () => ({ clientId: 'fixture', epoch: 'fixture', allowed: true }) });
  return { file, attachment, request, uploads };
}
describe('A04: upload HTTP status survives non-JSON gateway responses', () => {
  for (const status of [502, 503, 504]) it(`retries HTML ${status} after verifying the durable offset`, async () => {
    vi.useFakeTimers(); const { file, attachment, request, uploads } = fixture();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('<html>Temporary gateway failure</html>', { status })).mockImplementation(async () => {
      attachment.offset = file.size; return Response.json(attachment);
    });
    vi.stubGlobal('fetch', fetcher); const adding = uploads.add([file]);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); await vi.runAllTimersAsync(); await adding;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([command]) => command.method)).toEqual(['upload.begin', 'upload.status', 'upload.complete']);
    expect(uploads.current.value[0].attachment?.ready).toBe(true); expect(uploads.current.value[0].error).toBe('');
  });
  it('does not resend bytes already confirmed after the gateway failure', async () => {
    vi.useFakeTimers(); const { file, attachment, request, uploads } = fixture();
    const fetcher = vi.fn(async () => { attachment.offset = file.size; return new Response('gateway error', { status: 503 }); });
    vi.stubGlobal('fetch', fetcher); const adding = uploads.add([file]);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); await vi.runAllTimersAsync(); await adding;
    expect(fetcher).toHaveBeenCalledTimes(1); expect(request.mock.calls.map(([command]) => command.method)).toEqual(['upload.begin', 'upload.status', 'upload.complete']);
    expect(uploads.current.value[0].attachment?.ready).toBe(true);
  });
  it('stops after the existing three retries and keeps the attachment retryable', async () => {
    vi.useFakeTimers(); const { file, attachment, request, uploads } = fixture();
    const fetcher = vi.fn(async () => new Response('<html>Unavailable</html>', { status: 503 })); vi.stubGlobal('fetch', fetcher);
    const adding = uploads.add([file]); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); await vi.runAllTimersAsync(); await adding;
    expect(fetcher).toHaveBeenCalledTimes(4); expect(request.mock.calls.filter(([command]) => command.method === 'upload.status')).toHaveLength(3);
    expect(uploads.current.value[0].file).toBe(file); expect(uploads.current.value[0].error).toBe('上传失败，请重试。'); expect(uploads.current.value[0].uploading).toBe(false);
    fetcher.mockImplementation(async () => { attachment.offset = file.size; return Response.json(attachment); });
    await uploads.upload(uploads.current.value[0]);
    expect(fetcher).toHaveBeenCalledTimes(5); expect(uploads.current.value[0].attachment?.ready).toBe(true); expect(uploads.current.value[0].error).toBe('');
  });
  it('does not retry a non-JSON authorization rejection', async () => {
    const { file, request, uploads } = fixture(); const fetcher = vi.fn(async () => new Response('Forbidden', { status: 403 })); vi.stubGlobal('fetch', fetcher);
    await uploads.add([file]); expect(fetcher).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledTimes(1);
    expect(uploads.current.value[0].error).toBe('上传失败，请重试。');
  });
  it('retains structured server error messages', async () => {
    const { file, uploads } = fixture(); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'CONTROL', message: 'Control ownership changed' } }, { status: 409 })));
    await uploads.add([file]); expect(uploads.current.value[0].error).toBe('Control ownership changed');
  });
});
