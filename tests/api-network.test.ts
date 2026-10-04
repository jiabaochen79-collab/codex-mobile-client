import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../web/api.js';

afterEach(() => vi.restoreAllMocks());
describe('weak network HTTP behavior', () => {
  it('retries a transient GET once', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('lost response')).mockResolvedValueOnce(Response.json({ ok: true }));
    await expect(api('/fixture')).resolves.toEqual({ ok: true }); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('never retries a write whose outcome is unknown', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('lost response'));
    await expect(api('/fixture', { value: 1 })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not retry rejected authentication and rejects malformed success bodies', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ error: { code: 'AUTH', message: 'expired' } }, { status: 401 })).mockResolvedValueOnce(new Response('{broken', { headers: { 'Content-Type': 'application/json' } }));
    await expect(api('/fixture')).rejects.toMatchObject({ code: 'AUTH' }); expect(fetch).toHaveBeenCalledTimes(1);
    await expect(api('/fixture')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
