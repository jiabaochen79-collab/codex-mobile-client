import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { CodexDesktop, normalizeSnapshot } from '../src/agent/desktop.js';
import { ConversationImages } from '../src/agent/images.js';
import { DesktopActivity } from '../src/agent/activity.js';
import { conversationTurns } from '../web/conversation-model.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const cb of cleanup.splice(0).reverse()) cb(); vi.restoreAllMocks(); });
function directory() { const dir = mkdtempSync(resolve('.runtime/fixes-038-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function library(count: number) {
  const dir = directory(), rollout = join(dir, 'fixture.jsonl'); writeFileSync(rollout, '{}\n');
  const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT,title TEXT,cwd TEXT,updated_at_ms INTEGER,updated_at INTEGER,project_id TEXT,source TEXT,archived INTEGER,rollout_path TEXT)');
  const insert = db.prepare("INSERT INTO threads VALUES(?,'fixture','','C:/fixture',?,0,NULL,'vscode',0,?)");
  db.exec('BEGIN'); for (let i = 0; i < count; i++) insert.run(randomUUID(), i, rollout); db.exec('COMMIT'); db.close();
  const desktop = new CodexDesktop('unused', dir); cleanup.push(() => desktop.close());
  (desktop as any).taskActivity = () => ({ running: false, unread: false }); return desktop;
}
it('F12 splits long replies on Unicode boundaries and renders a single Markdown item', () => {
  const text = '```text\n' + 'x'.repeat(63992) + String.fromCodePoint(0x1f600) + '\n```\nend';
  const snapshot = normalizeSnapshot({ id: randomUUID(), turns: [{ turnId: 'round', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text, phase: 'final' }] }] }, 'epoch');
  expect(snapshot.messages).toHaveLength(2);
  for (const message of snapshot.messages) expect(message.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  expect(conversationTurns(snapshot)[0].results).toHaveLength(1);
  expect(conversationTurns(snapshot)[0].results[0].text).toBe(text);
});
it('F13 legacy final answers include all chunks of the final logical item', () => {
  const text = 'begin-' + 'x'.repeat(64000) + '-end';
  const snapshot = normalizeSnapshot({ id: randomUUID(), turns: [{ turnId: 'round', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text }] }] }, 'epoch');
  const turn = conversationTurns(snapshot)[0]; expect(turn.results[0].text).toBe(text); expect(turn.process).toEqual([]);
  expect(snapshot.messages[0].text.length).toBeLessThan(64001);
});
it('F16 continues beyond ten thousand tasks without silently truncating', () => {
  const desktop = library(10001), ids = new Set<string>();
  let page = desktop.list(0, { cursor: 'new' });
  for (;;) { for (const row of page.conversations) ids.add(row.id); if (!page.hasMore) break; page = desktop.list(page.nextOffset!, { cursor: page.cursor }); }
  expect(ids.size).toBe(10001);
});
it('F17 another 32 cursors cannot evict active navigation; expiry resumes at the requested offset', () => {
  const desktop = library(60), first = desktop.list(0, { cursor: 'new' });
  for (let i = 0; i < 32; i++) desktop.list(0, { cursor: 'new', query: 'fixture' });
  const second = desktop.list(30, { cursor: first.cursor });
  expect(second.reset).toBe(false); expect(second.conversations.some(row => first.conversations.some(old => old.id === row.id))).toBe(false);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60000);
  const restored = desktop.list(30, { cursor: first.cursor }); expect(restored.reset).toBe(true); expect(restored.conversations).toEqual(second.conversations);
});
it('F18 concurrent cache misses never account replaced image buffers twice', async () => {
  const images = new ConversationImages(), task = randomUUID();
  const bytes = await sharp(randomBytes(800 * 800 * 3), { raw: { width: 800, height: 800, channels: 3 } }).png().toBuffer();
  images.begin(task); const photo = images.register(task, 'data:image/png;base64,' + bytes.toString('base64'), 'photo')!;
  const results = await Promise.all(Array.from({ length: 45 }, () => images.read(task, photo.id, 'full')));
  expect(results.every(result => result.data)).toBe(true);
  const cache = images as any;
  expect(cache.cacheBytes).toBe([...cache.cache.values()].reduce((n: number, value: Buffer) => n + value.length, 0));
  expect(cache.cache.size).toBe(1);
});
it('F14 completion history filters only candidates; runtime status still decides whether a project is running', () => {
  const dir = directory(), file = join(dir, 'turn.jsonl'), activity = new DesktopActivity(dir);
  const record = (type: string, turn: string) => JSON.stringify({ type: 'event_msg', timestamp: turn, payload: { type, turn_id: turn } }) + '\n';
  writeFileSync(file, record('task_complete', 'old') + record('task_started', 'new'));
  expect(activity.read(file)).toMatchObject({ completionId: 'old:old', pending: true });
  writeFileSync(file, record('task_complete', 'old') + record('task_started', 'new') + record('task_complete', 'new'));
  expect(activity.read(file)).toMatchObject({ completionId: 'new:new', pending: false });
});
