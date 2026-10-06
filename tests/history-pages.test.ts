import { describe, expect, it } from 'vitest';
import { normalizeSnapshot } from '../src/agent/desktop.js';
describe('bounded history pages', () => {
  it.each([100, 8000])('loads all 1200 records despite item and byte caps (%i-byte messages)', bytes => {
    const items = Array.from({ length: 1200 }, (_, i) => ({ id: String(i), type: 'agentMessage', text: 'x'.repeat(bytes) }));
    const state = { id: 'fixture', turns: [{ turnId: 'turn', status: 'completed', items }] };
    const seen = new Set<string>(); let before: string | undefined;
    for (let page = 0; page < 100; page++) {
      const snapshot = normalizeSnapshot(state, 'fixture', 100, undefined, before);
      expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(750000);
      for (const message of snapshot.messages) { expect(seen.has(message.id)).toBe(false); seen.add(message.id); }
      if (!snapshot.hasMore) break;
      expect(snapshot.historyCursor).not.toBe(before); before = snapshot.historyCursor;
    }
    expect(seen.size).toBe(1200); expect(seen.has('0')).toBe(true);
  });
  it('rejects a missing history anchor instead of returning the newest page again', () => {
    expect(() => normalizeSnapshot({ id: 'fixture', turns: [] }, 'epoch', 100, undefined, 'missing')).toThrow('历史位置已变化');
  });
});
