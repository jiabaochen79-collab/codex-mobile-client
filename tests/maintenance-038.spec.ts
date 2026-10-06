import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const origin = process.env.PLAN_WEB_ORIGIN ?? 'http://127.0.0.1:19975';
for (const width of [320, 390]) test(`feedback pages and reply preserve older messages at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  const ticket = { id: 'fixture', state: 'open', category: 'chat', updated: 1 };
  const message = (seq: number) => ({ id: String(seq), seq, actor: 'user', text: 'Feedback ' + seq, created: seq, images: [] });
  await page.route('**/api/feedback**', async route => {
    const url = new URL(route.request().url()); let result: any;
    if (url.pathname.endsWith('/read')) result = { ok: true };
    else if (url.pathname.endsWith('/messages')) result = { ticket, messages: [message(51), { ...message(52), text: 'Reply accepted' }], nextBefore: 51 };
    else if (url.pathname.endsWith('/fixture')) result = url.searchParams.has('before') ? { ticket, messages: [message(1)] } : { ticket, messages: [message(51)], nextBefore: 51, revision: 'a'.repeat(64) };
    else result = { rows: [ticket], total: 1 };
    await route.fulfill({ json: result });
  });
  await page.goto(origin + '/@fs/' + fileURLToPath(new URL('./component-harness.html', import.meta.url)).replaceAll('\\', '/') + '?component=feedback');
  await page.locator('.feedback-list button').click();
  await page.getByRole('button', { name: '加载更早的消息', exact: true }).click();
  await expect(page.getByText('Feedback 1', { exact: true })).toBeVisible();
  await page.getByLabel('补充信息', { exact: true }).fill('Reply draft');
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await expect(page.getByText('Reply accepted', { exact: true })).toBeVisible();
  await expect(page.getByText('Feedback 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '加载更早的消息', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('feedback-paging-' + width + '.png') });
});
