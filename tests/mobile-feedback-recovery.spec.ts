import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import { mockPairedBrowser } from './paired-browser-fixture';

const origin = 'http://127.0.0.1:18890';
async function fixture(page: Page, rejectImage = false) {
  const submissions: any[] = [];
  await mockPairedBrowser(page);
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { mode: 'mobile' } }));
  await page.route('**/api/notifications', route => route.fulfill({ json: { items: [], unread: 0 } }));
  await page.route('**/api/feedback**', route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { rows: [], total: 0 } });
    const payload = route.request().postDataJSON(); submissions.push(payload);
    if (rejectImage && payload.images.length) return route.fulfill({ status: 400, json: { error: { code: 'INVALID', message: '截图无法处理，请移除图片。' } } });
    return route.fulfill({ json: { ticket: { id: payload.requestId, state: 'open' }, messages: [{ id: payload.requestId, seq: 1, actor: 'user', text: payload.text, images: [], created: Date.now() }] } });
  });
  await page.routeWebSocket('**/ws/mobile*', socket => {
    socket.send(JSON.stringify({ type: 'status', online: true, enabled: true, client: { available: true, capabilities: [] } }));
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      socket.send(JSON.stringify({ type: 'result', id: frame.id, result: { conversations: [], hasMore: false } }));
    });
  });
  await page.goto(origin);
  await page.getByTitle('更多操作', { exact: true }).click(); await page.getByTitle('问题反馈', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '问题反馈', exact: true });
  await dialog.getByRole('button', { name: '提交问题', exact: true }).click();
  await expect(dialog.getByLabel('问题描述', { exact: true })).toBeEnabled();
  return { dialog, submissions };
}

test('allows correcting a definitively rejected screenshot and submitting the retained text', async ({ page }) => {
  const { dialog, submissions } = await fixture(page, true);
  await dialog.getByLabel('问题描述', { exact: true }).fill('Keep feedback after rejected image');
  const image = await sharp({ create: { width: 48, height: 48, channels: 3, background: 'white' } }).jpeg().toBuffer();
  await dialog.locator('input[type=file]').setInputFiles({ name: 'screenshot.jpg', mimeType: 'image/jpeg', buffer: image });
  await expect(dialog.getByRole('img', { name: '待提交截图' })).toHaveCount(1);
  await dialog.getByRole('button', { name: '提交', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('请修改反馈内容');
  await expect(dialog.getByLabel('问题描述', { exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('问题描述', { exact: true })).toHaveValue('Keep feedback after rejected image');
  await dialog.getByTitle('移除截图', { exact: true }).click();
  await dialog.getByRole('button', { name: '提交', exact: true }).click();
  await expect(dialog).toContainText('反馈详情');
  expect(submissions).toHaveLength(2); expect(submissions[1].images).toEqual([]);
  expect(submissions[1].requestId).not.toBe(submissions[0].requestId);
});

test('does not submit when the pending retry identity cannot be saved', async ({ page }) => {
  await page.addInitScript(() => {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
      if (this.name === 'codex-mobile-feedback' && args[1] === 'readwrite' && (window as any).failFeedbackStorage) throw new DOMException('Full storage', 'QuotaExceededError');
      return transaction.apply(this, args);
    };
  });
  const { dialog, submissions } = await fixture(page);
  await page.evaluate(() => { (window as any).failFeedbackStorage = true; });
  await dialog.getByLabel('问题描述', { exact: true }).fill('Feedback with unavailable storage');
  await dialog.getByRole('button', { name: '提交', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('草稿保存失败');
  expect(submissions).toEqual([]); await expect(dialog.getByLabel('问题描述', { exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as any).failFeedbackStorage = false; });
  await dialog.getByRole('button', { name: '提交', exact: true }).click();
  await expect(dialog).toContainText('反馈详情'); expect(submissions).toHaveLength(1);
});
