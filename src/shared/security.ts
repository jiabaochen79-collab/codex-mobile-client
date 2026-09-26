import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isIP } from 'node:net';
import { RemoteError } from './protocol.js';

export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const equalSecret = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
export function verificationCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
}
export function originUrl(value: string) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!loopback && url.protocol !== 'https:') || (loopback && !['http:', 'https:'].includes(url.protocol)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Relay URL must be an HTTPS origin (HTTP is allowed only on loopback).');
  return url.origin;
}
export function privateDirectory(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-5-[0-9-]+/)?.[0];
    if (!sid) throw new Error('Cannot identify the current Windows user.');
    execFileSync('icacls.exe', [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { stdio: 'ignore', windowsHide: true });
  } else chmodSync(dir, 0o700);
}
export class RateLimit {
  private entries = new Map<string, { count: number; until: number }>();
  constructor(private max: number, private windowMs: number, private now = Date.now) {}
  reset(key: string) { this.entries.delete(key); }
  resetPrefix(prefix: string) { for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key); }
  take(key: string) {
    const now = this.now();
    for (const [k, v] of this.entries) if (v.until <= now) this.entries.delete(k);
    const value = this.entries.get(key) ?? { count: 0, until: now + this.windowMs };
    if (this.entries.size >= 10000 && !this.entries.has(key)) throw new RemoteError('RATE_LIMIT', '请求过于频繁，请稍后再试。');
    this.entries.set(key, value);
    if (++value.count > this.max) {
      const seconds = Math.max(1, Math.ceil((value.until - now) / 1000));
      throw new RemoteError('RATE_LIMIT', `请求过于频繁，请在 ${Math.ceil(seconds / 60)} 分钟后重试。`, seconds);
    }
  }
}
export function trustedProxy(value?: string) {
  if (!value) return false;
  if (!value.split(',').every(x => x === 'loopback' || isIP(x.trim()))) throw new Error('TRUST_PROXY must contain explicit proxy IPs or loopback.');
  return value.split(',').map(x => x.trim());
}
