import { test, expect } from '@playwright/test';
test.use({ viewport: { width: 900, height: 780 }, launchOptions: process.env.TEST_BROWSER === 'webkit' ? {} : { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } });
const origin = process.env.PLAN_WEB_ORIGIN ?? 'http://127.0.0.1:18890';

for (const mode of ['custom', 'automatic']) {
  test(`${mode} desktop credentials use distinct refresh and revoke controls with confirmation`, async ({ page }, info) => {
    let rotations = 0;
    let clipboard = '';
    await page.exposeFunction('captureDesktopCopy', (text: string) => { clipboard = text; });
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: (text: string) => (window as any).captureDesktopCopy(text) } }));
    const state = { deviceId: '123456789', code: mode === 'custom' ? 'Ab9!'.repeat(16) : 'ABCD5678', passwordMode: mode, enabled: true, connection: 'online', client: { available: true, version: '26.901.6511.0' }, authorizedCount: 2, url: 'https://example.invalid:9443' };
    await page.route('**/api/bootstrap', route => route.fulfill({ json: { mode: 'desktop' } }));
    await page.route('**/local/state', route => route.fulfill({ json: state }));
    await page.route('**/local/rotate', route => { rotations++; state.authorizedCount = 0; if (mode === 'automatic') state.code = 'EFGH5678'; return route.fulfill({ json: state }); });
    await page.goto(origin); await expect(page.getByRole('heading', { name: 'ChatGPT 远程助手', exact: true })).toBeVisible();
    await expect(page.getByText('服务器已连接', { exact: true })).toBeVisible();
    await expect(page.getByText('中继已连接', { exact: true })).toHaveCount(0);
    const copyConnection = page.getByRole('button', { name: '复制连接信息', exact: true });
    const openWeb = page.getByRole('link', { name: '打开手机网页', exact: true });
    await expect(copyConnection).toHaveClass(/primary/); await expect(openWeb).not.toHaveClass(/primary/);
    await expect(openWeb).toHaveAttribute('href', state.url); await expect(openWeb).toHaveAttribute('target', '_blank');
    const refresh = page.getByTitle('更换验证码并撤销现有手机授权', { exact: true });
    if (mode === 'custom') await expect(refresh).toHaveCount(0); else await expect(refresh).toBeVisible();
    const revoke = page.getByRole('button', { name: '撤销全部授权', exact: true });
    await expect(revoke.locator('svg.lucide-unplug')).toHaveCount(1); await expect(revoke.locator('svg.lucide-refresh-cw')).toHaveCount(0);
    await page.getByTitle('显示密码', { exact: true }).click();
    await expect(page.locator('.credential-value .code')).toHaveText(state.code);
    for (const width of [320, 390, 700, 900]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.getByTitle('助手更新', { exact: true }).evaluate(element => getComputedStyle(element).whiteSpace)).toBe('nowrap');
      expect(await page.getByTitle('问题反馈', { exact: true }).evaluate(element => getComputedStyle(element).borderTopWidth)).toBe('0px');
      for (const action of [copyConnection, openWeb]) {
        await expect(action).toBeVisible();
        expect(await action.evaluate(element => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)).toBe(true);
      }
      const copyBounds = (await copyConnection.boundingBox())!; const openBounds = (await openWeb.boundingBox())!;
      expect(width <= 620 ? copyBounds.y + copyBounds.height <= openBounds.y : copyBounds.x + copyBounds.width <= openBounds.x).toBe(true);
      await page.screenshot({ path: info.outputPath(`${mode}-${width}.png`), fullPage: true });
    }
    await copyConnection.click(); await expect(page.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
    expect(clipboard).toBe(`${state.url}\n设备 ID：123 456 789\n连接密码：${state.code}`); expect(rotations).toBe(0);
    await revoke.click();
    const confirmation = page.getByRole('dialog', { name: '撤销全部授权？', exact: true }); await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await expect(confirmation).toContainText(mode === 'custom' ? '自定义固定密码保持不变' : '当前验证码将同时更换');
    await confirmation.getByRole('button', { name: '取消', exact: true }).click(); expect(rotations).toBe(0);
    if (mode === 'automatic') {
      await refresh.click(); const codeConfirmation = page.getByRole('dialog', { name: '更换验证码？', exact: true });
      await expect(codeConfirmation).toBeVisible(); await codeConfirmation.getByRole('button', { name: '取消', exact: true }).click(); expect(rotations).toBe(0);
    }
    await revoke.click(); await page.getByRole('button', { name: '确认撤销', exact: true }).click();
    await expect(confirmation).toHaveCount(0); expect(rotations).toBe(1); await expect(revoke).toBeDisabled();
    await expect(page.locator('.credential-value .code')).toHaveText(mode === 'custom' ? 'Ab9!'.repeat(16) : 'EFGH5678');
  });
}
