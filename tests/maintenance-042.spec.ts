import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const origin = process.env.PLAN_WEB_ORIGIN ?? 'http://127.0.0.1:19975';
const harness = origin + '/@fs/' + fileURLToPath(new URL('./component-harness.html', import.meta.url)).replaceAll('\\', '/');
for (const width of [320, 390]) {
  test(`HTTP read acknowledgement prevents delayed unread rows at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const item = (n: number) => ({ id: String(n), taskId: String(n), deviceId: '123456789', turnId: 'turn', status: 'completed', createdAt: n, occurredAt: Date.now(), sequence: n, readAt: null });
    await page.route('**/api/notifications**', route => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ json: path.endsWith('/settings') ? { settings: { enabled: false }, pushConfigured: false } : path.endsWith('/read-all') ? { unread: 0, throughSequence: 2, readAt: Date.now() } : { items: [item(1)], unread: 1, throughSequence: 2 } });
    });
    await page.goto(harness + '?component=notifications');
    await page.getByRole('button', { name: '全部标为已读', exact: true }).click();
    await expect(page.locator('#unread')).toHaveText('0');
    await page.evaluate(detail => window.dispatchEvent(new CustomEvent('remote-notification', { detail })), item(2));
    await expect(page.locator('.notification-item')).toHaveCount(2); await expect(page.locator('.notification-item.unread')).toHaveCount(0);
    await page.evaluate(detail => window.dispatchEvent(new CustomEvent('remote-notification', { detail })), item(3));
    await expect(page.locator('#unread')).toHaveText('1'); await expect(page.locator('.notification-item.unread')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('read-receipt.png') });
  });
  test(`foreground recovery retains loaded notification history at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 }); let release: (() => void) | undefined, recovering = false;
    const item = (n: number) => ({ id: String(n), taskId: String(n), deviceId: '123456789', turnId: 'turn', status: 'completed', createdAt: n, occurredAt: Date.now(), sequence: n, readAt: null });
    await page.route('**/api/notifications**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/settings')) return route.fulfill({ json: { settings: { enabled: false }, pushConfigured: false } });
      if (url.searchParams.has('cursor')) return route.fulfill({ json: { items: [item(1)], unread: 2, throughSequence: 2, nextCursor: 'older' } });
      if (recovering) await new Promise<void>(resolve => release = resolve);
      return route.fulfill({ json: { items: [item(2)], unread: 2, throughSequence: 2, nextCursor: 'page-2' } });
    });
    await page.goto(harness + '?component=notifications'); await page.getByRole('button', { name: '加载更多提醒', exact: true }).click();
    await expect(page.getByText('任务 1', { exact: true })).toBeVisible();
    recovering = true; await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => !!release).toBe(true); await expect(page.getByText('任务 1', { exact: true })).toBeVisible();
    release!(); await expect(page.getByRole('button', { name: '加载更多提醒', exact: true })).toBeEnabled(); await expect(page.getByText('任务 1', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('notification-recovery.png') });
  });
  test(`feedback conflicts leave an editable persistent draft at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.route('**/api/feedback**', route => route.fulfill(route.request().method() === 'POST' ? { status: 409, json: { error: { code: 'CONFLICT', message: '提交编号已用于不同内容。' } } } : { json: { rows: [], total: 0 } }));
    await page.goto(harness + '?component=feedback'); await page.getByRole('button', { name: '提交问题', exact: true }).click();
    await page.getByLabel('问题描述', { exact: true }).fill('Retain my feedback after a conflict'); await page.getByRole('button', { name: '提交', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('核对已有工单'); await expect(page.getByLabel('问题描述', { exact: true })).toBeEnabled();
    await page.reload(); await page.getByRole('button', { name: '提交问题', exact: true }).click();
    await expect(page.getByLabel('问题描述', { exact: true })).toHaveValue('Retain my feedback after a conflict'); await expect(page.getByLabel('问题描述', { exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('feedback-conflict.png') });
  });
}
