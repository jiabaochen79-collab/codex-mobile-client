import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/agent/agent.js';

afterEach(() => vi.restoreAllMocks());
it('uses a short metadata timeout and a separate download budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-request-test-'));
  const agent = new Agent({ dir, origin: 'https://example.test', adapter: { close() {} } as any });
  try {
    (agent as any).credentials = { id: '123456789', secret: 'fixture-only' };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ count: 3 }));
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal);
    const signal = new AbortController().signal;
    await agent.serviceRequest('/api/updates/device/check?version=0.4.31', { signal });
    await agent.serviceRequest('/api/updates/download/' + 'a'.repeat(64), { signal });
    expect(timeout.mock.calls.map(call => call[0])).toEqual([15000, 1800000]);
    await agent.refreshFeedbackUnread(); expect(agent.state().feedbackUnread).toBe(3);
  } finally { await agent.close(); rmSync(dir, { recursive: true, force: true }); }
});
