import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
test.use({ viewport: { width: 390, height: 844 }, launchOptions: { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } });
const origin = 'http://127.0.0.1:18890';
let deviceId: string;
test.beforeEach(async ({ request }) => {
  const response = await request.post('http://127.0.0.1:18891/local/password', { headers: { Authorization: `Bearer ${process.env.FIXTURE_LOCAL_TOKEN}`, Origin: 'http://127.0.0.1:18891' }, data: { mode: 'custom', password: 'Fixture-Only-Password42' } });
  expect(response.ok()).toBe(true); deviceId = (await response.json()).deviceId;
});
async function login(page: Page) {
  await page.goto(origin); await page.getByLabel('设备 ID', { exact: true }).fill(deviceId);
  await page.getByLabel('验证码或自定义密码').fill('Fixture-Only-Password42'); await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.locator('.project-toggle').filter({ hasText: '产品研发' }).click();
  await page.locator('.nav-conversation').filter({ hasText: '移动端验收记录' }).click();
}
test('renders historical input and final photos and opens a bounded full-screen preview', async ({ page }, info) => {
  const errors: string[] = []; const imageRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/api/images/')) imageRequests.push(request.url()); });
  await login(page);
  const result = page.getByRole('img', { name: '返回的图片', exact: true }); await result.scrollIntoViewIfNeeded();
  await expect.poll(() => result.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
  const input = page.getByRole('img', { name: '历史上传照片', exact: true }); await input.scrollIntoViewIfNeeded();
  await expect.poll(() => input.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
  const before = imageRequests.length;
  await page.getByTitle('更多操作', { exact: true }).click(); await page.getByRole('button', { name: '刷新会话', exact: true }).click();
  await expect(input).toBeVisible(); expect(imageRequests.length).toBe(before);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 }); await page.getByTitle('查看大图：返回的图片').click();
    const dialog = page.getByRole('dialog', { name: '图片预览', exact: true }); await expect(dialog).toBeVisible();
    const photo = dialog.getByRole('img', { name: '返回的图片', exact: true });
    await expect.poll(() => photo.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await expect(dialog.locator('.image-loading')).toHaveCount(0);
    const bounds = await photo.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`image-preview-${width}.png`) });
    await page.getByTitle('关闭图片', { exact: true }).click(); await expect(dialog).toHaveCount(0);
  }
  await page.setViewportSize({ width: 390, height: 844 }); await result.scrollIntoViewIfNeeded();
  await page.locator('.messages').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await expect(page.getByTitle('回到最新消息', { exact: true })).toBeVisible();
  await page.getByTitle('回到最新消息', { exact: true }).click();
  await expect(page.getByTitle('回到最新消息', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('image-history.png') }); expect(errors).toEqual([]);
});
test('retries failed images and keeps uploaded image-only messages after sending', async ({ page }) => {
  let fail = true;
  await page.route('**/api/images/**', route => fail ? route.fulfill({ status: 503, body: '' }) : route.continue());
  await login(page);
  const failedResult = page.locator('[data-scroll-key="message:f-4"] .image-failure');
  await failedResult.scrollIntoViewIfNeeded(); await expect(failedResult).toBeVisible();
  fail = false; await failedResult.getByRole('button', { name: '重试', exact: true }).click();
  await expect.poll(() => page.getByRole('img', { name: '返回的图片', exact: true }).evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
  const bytes = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#bf4d71' } }).jpeg().toBuffer();
  const fileName = `sent-${crypto.randomUUID()}.jpg`;
  await page.locator('input[data-attachment-source=photos]').setInputFiles({ name: fileName, mimeType: 'image/jpeg', buffer: bytes });
  await expect(page.getByText('已上传', { exact: true })).toBeVisible(); await page.getByTitle('发送消息', { exact: true }).click();
  const sent = page.locator('.message.user').getByRole('img', { name: fileName, exact: true });
  await expect.poll(() => sent.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
  await expect(page.locator('.pending-attachment')).toHaveCount(0);
  await expect(page.getByTitle('停止当前生成', { exact: true })).toHaveCount(0, { timeout: 12000 });
  await page.reload(); await page.locator('.project-toggle').filter({ hasText: '产品研发' }).click(); await page.locator('.nav-conversation').filter({ hasText: '移动端验收记录' }).click();
  await expect.poll(() => page.getByRole('img', { name: fileName, exact: true }).evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
});
