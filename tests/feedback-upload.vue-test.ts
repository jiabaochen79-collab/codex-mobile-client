import { afterEach, expect, it, vi } from 'vitest';
import { uploadFeedbackPictures, type FeedbackPicture } from '../web/feedback-upload';
const api = vi.hoisted(() => vi.fn());
vi.mock('../web/api', () => ({ api: (...args: unknown[]) => api(...args) }));
afterEach(() => api.mockReset());
it('revalidates ready uploads and reuploads an expired file without losing draft identity', async () => {
  const picture: FeedbackPicture = { data: btoa('fixture'), uploadId: crypto.randomUUID(), ready: true };
  api.mockResolvedValueOnce({ offset: 0, ready: false }).mockResolvedValueOnce({ offset: 7, ready: true });
  const saved = vi.fn().mockResolvedValue(true); expect(await uploadFeedbackPictures('/api/feedback', [picture], undefined, saved)).toEqual([{ uploadId: picture.uploadId }]);
  expect(api.mock.calls[0][1].id).toBe(picture.uploadId); expect(api.mock.calls[1][1].offset).toBe(0); expect(saved).toHaveBeenCalledTimes(2);
});
it('queries confirmed offset after losing a chunk response instead of restarting the screenshot', async () => {
  vi.useFakeTimers();
  try {
    const bytes = new Uint8Array(65537), data = btoa(Array.from(bytes, b => String.fromCharCode(b)).join('')); const picture = { data };
    api.mockResolvedValueOnce({ offset: 0 }).mockRejectedValueOnce({ code: 'OUTCOME_UNKNOWN' }).mockResolvedValueOnce({ offset: 65536 }).mockResolvedValueOnce({ offset: 65537, ready: true });
    const uploading = uploadFeedbackPictures('/api/feedback', [picture], undefined, async () => true);
    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(2)); await vi.advanceTimersByTimeAsync(1000); await uploading;
    expect(api.mock.calls[3][1]).toMatchObject({ offset: 65536 }); expect(api.mock.calls.filter(call => call[0] === '/api/feedback/uploads')).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});
