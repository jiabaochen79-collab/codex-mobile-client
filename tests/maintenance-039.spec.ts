import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const origin = process.env.PLAN_WEB_ORIGIN ?? 'http://127.0.0.1:19975';
for (const width of [320, 390]) test(`disjoint feedback pages retain the middle-page entry at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  const ticket = { id: 'fixture', state: 'open', category: 'chat', updated: 1 };
  const messages = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, n) => ({ id: String(start + n), seq: start + n, actor: 'user', text: 'Feedback ' + (start + n), created: 1, images: [] }));
  await page.route('**/api/feedback**', async route => {
    const url = new URL(route.request().url());
    const result = url.pathname.endsWith('/read') ? { ok: true } : url.pathname.endsWith('/messages') ? { ticket, messages: messages(101, 150), nextBefore: 101 } : url.pathname.endsWith('/fixture') ? url.searchParams.has('before') ? { ticket, messages: messages(51, 100), nextBefore: 51 } : { ticket, messages: messages(1, 50) } : { rows: [ticket], total: 1 };
    await route.fulfill({ json: result });
  });
  await page.goto(origin + '/@fs/' + fileURLToPath(new URL('./component-harness.html', import.meta.url)).replaceAll('\\', '/') + '?component=feedback');
  await page.locator('.feedback-list button').click(); await page.getByLabel('补充信息', { exact: true }).fill('Reply');
  await page.getByRole('button', { name: '提交', exact: true }).click();
  const older = page.getByRole('button', { name: '加载更早的消息', exact: true }); await expect(older).toBeVisible(); await older.click();
  await expect(page.getByText('Feedback 75', { exact: true })).toBeVisible(); await expect(page.getByText('Feedback 150', { exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('feedback-middle-' + width + '.png') });
});
