import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const origin = process.env.PLAN_WEB_ORIGIN ?? 'http://127.0.0.1:19975';
for (const width of [320, 390]) test(`notification pagination retains incoming unread state at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  let release!: () => void;
  const item = (sequence: number) => ({ id: String(sequence), taskId: String(sequence), turnId: 'turn', deviceId: '123456789', status: 'completed', createdAt: sequence, occurredAt: Date.now(), sequence, readAt: null });
  await page.route('**/api/notifications**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/settings')) return route.fulfill({ json: { settings: { enabled: false, completed: true, failed: true }, pushConfigured: false } });
    if (url.searchParams.has('cursor')) { await new Promise<void>(resolve => release = resolve); return route.fulfill({ json: { items: [item(1)], unread: 1, throughSequence: 2, nextCursor: null } }); }
    return route.fulfill({ json: { items: [item(2)], unread: 1, throughSequence: 2, nextCursor: 'fixture' } });
  });
  await page.goto(origin + '/@fs/' + fileURLToPath(new URL('./component-harness.html', import.meta.url)).replaceAll('\\', '/') + '?component=notifications');
  await expect(page.locator('#unread')).toHaveText('1'); await page.getByRole('button', { name: '加载更多提醒', exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  await page.evaluate(detail => window.dispatchEvent(new CustomEvent('remote-notification', { detail })), item(3));
  await expect(page.locator('#unread')).toHaveText('2'); release(); await expect(page.getByText('任务 1', { exact: true })).toBeVisible(); await expect(page.locator('#unread')).toHaveText('2');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('notification-page-' + width + '.png') });
});
