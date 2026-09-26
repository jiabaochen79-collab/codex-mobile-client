import { describe, expect, it } from 'vitest';
import { equalSecret, originUrl, RateLimit, verificationCode } from '../src/shared/security.js';
import { commandFrame } from '../src/shared/protocol.js';
import { randomUUID } from 'node:crypto';
describe('security boundaries', () => {
  it('requires HTTPS outside loopback and disallows URL credentials or paths', () => {
    expect(originUrl('https://relay.example.com')).toBe('https://relay.example.com');
    expect(originUrl('http://127.0.0.1:8790')).toBe('http://127.0.0.1:8790');
    for (const u of ['http://192.168.1.1', 'http://example.com', 'https://a:b@example.com', 'https://example.com/path', 'https://example.com/#secret', 'ws://localhost:100']) expect(() => originUrl(u)).toThrow();
  });
  it('generates unambiguous codes and compares different-length secrets safely', () => {
    const values = new Set(Array.from({ length: 1000 }, verificationCode));
    expect(values.size).toBe(1000); for (const v of values) expect(v).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(equalSecret('abc', 'abc')).toBe(true); expect(equalSecret('', 'abc')).toBe(false);
  });
  it('limits attempts until the actual expiry', () => {
    let now = 1; const limiter = new RateLimit(2, 100, () => now);
    limiter.take('a'); limiter.take('a'); expect(() => limiter.take('a')).toThrow();
    now = 102; expect(() => limiter.take('a')).not.toThrow();
  });
  it('reports the remaining cooldown without extending it on blocked retries', () => {
    let now = 1000; const limiter = new RateLimit(1, 900000, () => now);
    limiter.take('a'); now += 2500;
    expect(() => limiter.take('a')).toThrow(expect.objectContaining({ code: 'RATE_LIMIT', retryAfterSeconds: 898 }));
    now += 1000;
    expect(() => limiter.take('a')).toThrow(expect.objectContaining({ retryAfterSeconds: 897 }));
  });
  it('resets only the authenticated device prefix', () => {
    const limiter = new RateLimit(1, 900000);
    for (const key of ['123:one','123:two','1234:one']) limiter.take(key);
    limiter.resetPrefix('123:');
    expect(() => limiter.take('123:one')).not.toThrow(); expect(() => limiter.take('123:two')).not.toThrow();
    expect(() => limiter.take('1234:one')).toThrow();
  });
  it('does not accept arbitrary IPC, scripts or extra privileged parameters', () => {
    const id = randomUUID();
    expect(commandFrame.safeParse({ type: 'command', id, command: { method: 'list', params: {} } }).success).toBe(true);
    for (const command of [{ method: 'Runtime.evaluate', params: { expression: '1' } }, { method: 'send', params: { id, text: 'Hi', epoch: '1', shell: 'cmd.exe' } }, { method: 'create', params: { projectId: 'x', text: 'Hi', cwd: 'C:/' } }]) expect(commandFrame.safeParse({ type: 'command', id, command }).success).toBe(false);
  });
});
