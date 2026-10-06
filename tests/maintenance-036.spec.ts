import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mockPairedBrowser } from './paired-browser-fixture';
const origin = process.env.PLAN_WEB_ORIGIN ?? 'http://127.0.0.1:19975';
for (const width of [320, 390]) test(`fills a recovered history gap and preserves the reading position at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 }); await mockPairedBrowser(page);
  const task = { id: '11111111-1111-4111-8111-111111111111', title: 'Recovery fixture', cwd: '', updatedAt: 1 };
  const messages = Array.from({ length: 500 }, (_, n) => ({ id: String(n), role: 'assistant', text: 'Message ' + n, turnId: 'turn-' + n, turnStatus: 'completed', phase: 'final' }));
  let tail = 100; let changed!: () => void; const cursors: string[] = [];
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { mode: 'mobile' } }));
  await page.route('**/api/notifications', route => route.fulfill({ json: { items: [], unread: 0 } }));
  await page.routeWebSocket('**/ws/mobile*', socket => {
    changed = () => socket.send(JSON.stringify({ type: 'changed', conversationId: task.id }));
    socket.send(JSON.stringify({ type: 'status', online: true, enabled: true, subscription: { access: true }, client: { available: true, capabilities: ['history-pages', 'multi-terminal'] }, control: { role: 'controller', epoch: 'fixture', terminals: [] } }));
    socket.onMessage(raw => {
      const { id, command } = JSON.parse(String(raw)); const end = command.params.before === undefined ? tail : Number(command.params.before); const start = Math.max(0, end - 100);
      if (command.params.before !== undefined) cursors.push(command.params.before);
      const result = command.method === 'list' ? { conversations: [task], hasMore: false } : { ...task, epoch: 'fixture', busy: false, turnId: null, requests: [], messages: messages.slice(start, end), hasMore: start > 0, historyCursor: String(start), settings: { mode: 'default' } };
      socket.send(JSON.stringify({ type: 'result', id, result }));
    });
  });
  await page.goto(origin); await page.getByRole('button', { name: task.title, exact: true }).click(); await expect(page.getByText('Message 99', { exact: true })).toBeVisible();
  const anchor = page.locator('[data-scroll-key="message:50"]'); await anchor.scrollIntoViewIfNeeded(); const top = (await anchor.boundingBox())!.y;
  tail = 500; changed(); await expect(page.getByText('Message 250', { exact: true })).toBeAttached(); await expect(page.getByText('Message 499', { exact: true })).toBeAttached();
  await expect.poll(() => cursors.length).toBe(4); expect(cursors).toEqual(['400', '300', '200', '100']); expect(await page.locator('[data-scroll-key^="message:"]').count()).toBe(500);
  expect(Math.abs((await anchor.boundingBox())!.y - top)).toBeLessThan(4); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('recovered-history-' + width + '.png') });
});
test('an in-flight notification list cannot restore a cross-terminal read indicator', async ({ page }) => {
  const harness = origin + '/@fs/' + fileURLToPath(new URL('./component-harness.html', import.meta.url)).replaceAll('\\', '/') + '?component=notifications';
  let release!: () => void; const wait = new Promise<void>(resolve => release = resolve); let entered!: () => void; const started = new Promise<void>(resolve => entered = resolve);
  await page.route('**/api/notifications/settings', route => route.fulfill({ json: { settings: { enabled: false, completed: true, failed: true } } }));
  await page.route('**/api/notifications', async route => { entered(); await wait; await route.fulfill({ json: { items: [{ id: 'fixture', taskId: 'task', deviceId: '123456789', sequence: 1, status: 'completed', occurredAt: 1, createdAt: 1, readAt: null }], unread: 1, throughSequence: 1 } }); });
  await page.goto(harness); await started;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('remote-notification-read', { detail: { deviceId: '123456789', id: 'fixture', readAt: 100, unread: 0, throughSequence: 1 } })));
  release(); await expect(page.locator('.notification-item')).toHaveCount(1); await expect(page.locator('.notification-item.unread')).toHaveCount(0); await expect(page.locator('#unread')).toHaveText('0');
});
