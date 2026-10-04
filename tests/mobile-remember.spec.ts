import { test, expect, chromium, webkit, type Page } from '@playwright/test';

const origin = 'http://127.0.0.1:18890';
const local = 'http://127.0.0.1:18891';
const executablePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const password = 'Remember-Fixture-Password42';
let deviceId: string;
const browser = process.env.TEST_BROWSER === 'webkit' ? webkit : chromium;
const launchOptions = process.env.TEST_BROWSER === 'webkit' ? {} : { executablePath };
test.use({ viewport: { width: 390, height: 844 }, launchOptions });
test.beforeEach(async ({ request }) => {
  if (!process.env.FIXTURE_LOCAL_TOKEN) throw new Error('Start the isolated browser fixture first.');
  const response = await request.post(`${local}/local/password`, { headers: { Authorization: `Bearer ${process.env.FIXTURE_LOCAL_TOKEN}`, Origin: local }, data: { mode: 'custom', password } });
  expect(response.ok()).toBe(true); deviceId = (await response.json()).deviceId;
});
async function login(page: Page, remember = true) {
  await page.goto(origin);
  await page.getByLabel('设备 ID', { exact: true }).fill(deviceId);
  await page.getByLabel('验证码或自定义密码').fill(password);
  await page.getByRole('checkbox', { name: '记住此设备' }).setChecked(remember);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目与会话', exact: true })).toBeVisible();
}
test('reopens a real browser profile without entering a password or pairing again', async ({}, testInfo) => {
  const profile = testInfo.outputPath('browser-profile');
  let context = await browser.launchPersistentContext(profile, { ...launchOptions, viewport: { width: 390, height: 844 } });
  try {
    const first = await context.newPage(); const paired = first.waitForResponse(response => response.url().endsWith('/api/connect')); await login(first);
    const cookie = (await context.cookies()).find(c => c.name === 'remote_browser')!;
    expect(cookie.httpOnly).toBe(true);
    // Verify the attribute at the HTTP boundary, independently of browser cookie metadata.
    expect(await (await paired).headerValue('set-cookie')).toMatch(/remote_browser=.*SameSite=Strict/i);
    expect(cookie.expires * 1000 - Date.now()).toBeGreaterThan(29 * 86400000);
    expect(await first.evaluate(() => JSON.parse(localStorage.getItem('remote-login')!))).toEqual({ remember: true, deviceId });
    expect(await first.evaluate(() => JSON.stringify(localStorage))).not.toContain(password);
    expect(await first.evaluate(() => document.cookie)).not.toContain('remote_browser');
    await context.close();
    context = await browser.launchPersistentContext(profile, { ...launchOptions, viewport: { width: 390, height: 844 } });
    const reopened = await context.newPage(); const pairings: string[] = [];
    reopened.on('request', r => { if (r.url().endsWith('/api/connect')) pairings.push(r.url()); });
    await reopened.goto(origin);
    await expect(reopened.getByRole('heading', { name: '项目与会话', exact: true })).toBeVisible();
    await reopened.locator('.project-toggle').filter({ hasText: '产品研发' }).click();
    await expect(reopened.locator('.nav-conversation').filter({ hasText: '移动端验收记录' })).toBeVisible();
    expect(pairings).toEqual([]);
    await reopened.getByTitle('退出登录', { exact: true }).click();
    await expect(reopened.getByLabel('设备 ID', { exact: true })).toHaveValue(deviceId);
    await expect(reopened.getByLabel('验证码或自定义密码')).toHaveValue('');
    await reopened.reload(); await expect(reopened.getByRole('heading', { name: '连接电脑', exact: true })).toBeVisible();
    expect((await (await context.request.get(origin + '/api/paired-devices')).json()).devices).toEqual([]);
  } finally { await context.close(); }
});
test('keeps unchecked login temporary and does not save the device ID', async ({ page, context }) => {
  await login(page, false);
  const cookie = (await context.cookies()).find(c => c.name === 'remote_browser')!;
  expect(cookie.expires * 1000 - Date.now()).toBeLessThanOrEqual(86401000);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('remote-login')!))).toEqual({ remember: false, deviceId: '' });
  await page.getByTitle('退出登录', { exact: true }).click(); await page.reload();
  await expect(page.getByLabel('设备 ID', { exact: true })).toHaveValue('');
  await expect(page.getByRole('checkbox', { name: '记住此设备' })).not.toBeChecked();
});

test('compares the page entry rather than its lazy component when checking web updates', async ({ page }) => {
  const checked = page.waitForResponse(response => response.url().endsWith('/api/web-version'));
  await page.goto(origin); await checked;
  await page.getByLabel('设备 ID', { exact: true }).fill(deviceId);
  await page.getByLabel('验证码或自定义密码').fill(password);
  await expect(page.locator('.web-update')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeEnabled();
  await page.route('**/api/web-version', route => route.fulfill({ json: { entry: '/assets/index-newversion.js' } }));
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect(page.locator('.web-update')).toContainText('网页已有新版本');
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeDisabled();
});
test('password changes invalidate remembered access without reusing a saved password', async ({ page, request }) => {
  await login(page);
  const response = await request.post(`${local}/local/password`, { headers: { Authorization: `Bearer ${process.env.FIXTURE_LOCAL_TOKEN}`, Origin: local }, data: { mode: 'custom', password: 'Changed-Fixture-Password42' } });
  expect(response.ok()).toBe(true);
  await expect(page.getByRole('alert')).toContainText('授权已失效');
  await expect(page.getByLabel('设备 ID', { exact: true })).toHaveValue(deviceId);
  await expect(page.getByLabel('验证码或自定义密码')).toHaveValue('');
  await page.reload(); await expect(page.getByRole('heading', { name: '连接电脑', exact: true })).toBeVisible();
});
test('remembered login controls fit small phones and support browser password managers', async ({ page }, testInfo) => {
  await page.goto(origin);
  await expect(page.getByRole('checkbox', { name: '记住此设备' })).toBeChecked();
  await expect(page.getByLabel('设备 ID', { exact: true })).toHaveAttribute('autocomplete', 'username');
  await expect(page.getByLabel('验证码或自定义密码')).toHaveAttribute('autocomplete', 'current-password');
  for (const [width, height] of [[320, 568], [390, 844], [1280, 900]]) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const label = await page.locator('.remember-login').boundingBox(); const submit = await page.locator('.connect-submit').boundingBox();
    expect(label!.y + label!.height).toBeLessThanOrEqual(submit!.y);
    await page.screenshot({ path: testInfo.outputPath(`remember-login-${width}.png`), fullPage: true });
  }
});
test('login works when preference storage is blocked', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } }); });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await login(page); expect(errors).toEqual([]);
});
