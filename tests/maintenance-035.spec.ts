import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mockPairedBrowser } from './paired-browser-fixture';
const origin = process.env.PLAN_WEB_ORIGIN ?? 'http://127.0.0.1:19975';
const mount = (kind: string) => origin + '/@fs/' + fileURLToPath(new URL('./component-harness.html', import.meta.url)).replaceAll('\\', '/') + '?component=' + kind;
test('restores a rejected remote-enable switch to the confirmed state', async ({ page }) => {
  const state = { helperVersion: '0.4.35', deviceId: '123456789', url: 'https://fixture.invalid', enabled: false, code: 'fixture-123', passwordMode: 'automatic', client: { available: true, version: 'fixture', reason: null }, authorizedCount: 0, connection: 'online' };
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.route('**/local/**', route => route.request().url().endsWith('/enabled') ? route.fulfill({ status: 500, json: { error: { code: 'LOCAL_SERVICE_ERROR', message: 'fixture failure' } } }) : route.fulfill({ json: state }));
  await page.goto(mount('desktop')); const toggle = page.locator('input.switch'); await expect(toggle).not.toBeChecked();
  await toggle.click(); await expect(page.getByRole('alert').filter({ hasText: 'fixture failure' })).toBeVisible();
  await expect(toggle).not.toBeChecked(); await page.waitForTimeout(3400); await expect(toggle).not.toBeChecked();
});
test('strips application classes and IDs from assistant HTML', async ({ page }) => {
  await page.goto(mount('message')); await expect(page.locator('.prose')).toHaveText('Fixture message');
  await expect(page.locator('.prose .modal-backdrop')).toHaveCount(0);
  await expect(page.locator('.prose [id], .prose [style], .prose [class]')).toHaveCount(0);
});
for (const width of [320, 390]) test(`reads beyond 500 messages without moving the history anchor at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 }); await mockPairedBrowser(page);
  const task = { id: '11111111-1111-4111-8111-111111111111', title: 'History fixture', cwd: 'C:/fixture', updatedAt: 1 };
  const messages = Array.from({ length: 1200 }, (_, n) => ({ id: String(n), role: n % 2 ? 'assistant' : 'user', text: 'History message ' + n, turnId: 'turn-' + n, turnStatus: 'completed', phase: 'final' }));
  const before: string[] = [];
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { mode: 'mobile' } }));
  await page.route('**/api/notifications', route => route.fulfill({ json: { items: [], unread: 0 } }));
  await page.routeWebSocket('**/ws/mobile*', socket => {
    socket.send(JSON.stringify({ type: 'status', online: true, enabled: true, subscription: { access: true }, client: { available: true, capabilities: ['history-pages', 'multi-terminal'] }, control: { role: 'controller', epoch: 'fixture', terminals: [] } }));
    socket.onMessage(raw => {
      const { id, command } = JSON.parse(String(raw)); const end = command.params.before === undefined ? messages.length : Number(command.params.before);
      if (command.params.before !== undefined) before.push(command.params.before);
      const start = Math.max(0, end - 100);
      const result = command.method === 'list' ? { conversations: [task], hasMore: false } : { ...task, epoch: 'fixture', busy: false, turnId: null, requests: [], messages: messages.slice(start, end), hasMore: start > 0, historyCursor: String(start), settings: { mode: 'default' } };
      socket.send(JSON.stringify({ type: 'result', id, result }));
    });
  });
  await page.goto(origin); await page.getByRole('button', { name: task.title, exact: true }).click();
  await expect(page.getByText('History message 1199', { exact: true })).toBeVisible();
  const history = page.getByRole('button', { name: '加载更早的消息', exact: true });
  for (let n = 0; n < 11; n++) {
    await history.scrollIntoViewIfNeeded(); const anchor = page.locator(`[data-scroll-key="message:${1100 - n * 100}"]`);
    const top = (await anchor.boundingBox())!.y; await history.click();
    await expect(page.getByText('History message ' + (1000 - n * 100), { exact: true })).toBeAttached();
    expect(Math.abs((await anchor.boundingBox())!.y - top)).toBeLessThan(4);
  }
  await expect(history).toHaveCount(0); expect(before).toEqual(Array.from({ length: 11 }, (_, n) => String(1100 - n * 100)));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('history-' + width + '.png') });
});
