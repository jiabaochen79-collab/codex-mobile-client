import { expect, test, type Page } from '@playwright/test';
import { mockPairedBrowser } from './paired-browser-fixture';

const webkit = process.env.TEST_BROWSER === 'webkit';
test.use({ browserName: webkit ? 'webkit' : 'chromium', viewport: { width: 390, height: 670 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', launchOptions: webkit ? {} : { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } });
const origin = process.env.VIEWPORT_WEB_ORIGIN ?? 'http://127.0.0.1:18890';
const task = { id: '12345678-1234-4234-8234-123456789abc', title: '恢复保护验收', cwd: 'C:/fixture', updatedAt: 1 };
async function fixture(page: Page) {
  await page.addInitScript(() => {
    sessionStorage.setItem('fixture-documents', String(Number(sessionStorage.getItem('fixture-documents')) + 1));
    if (sessionStorage.getItem('fixture-cold-start')) { sessionStorage.removeItem('fixture-cold-start'); sessionStorage.setItem('remote-viewport-hidden-at', String(Date.now() - 120_000)); }
    let hidden = false; let offset = 0; const now = Date.now.bind(Date); Date.now = () => now() + offset;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
    (window as any).resumeFixture = {
      visible(value: boolean) { hidden = !value; document.dispatchEvent(new Event('visibilitychange')); },
      advance(ms: number) { offset += ms; }
    };
  });
  await mockPairedBrowser(page);
  const writes: string[] = []; let gone = false;
  await page.routeWebSocket('**/ws/mobile*', socket => {
    socket.send(JSON.stringify({ type: 'status', online: true, enabled: true, helperVersion: '0.4.4', client: { available: true, capabilities: ['attachments', 'task-mode', 'queued-send', 'project-navigation'] } }));
    socket.onMessage(raw => {
      const { id, command } = JSON.parse(String(raw));
      if (!['read', 'list', 'projects', 'queue.list'].includes(command.method)) writes.push(command.method);
      if (command.method === 'upload.begin' || command.method === 'read' && gone) { socket.send(JSON.stringify({ type: 'result', id, error: { code: gone ? 'NOT_FOUND' : 'FIXTURE', message: 'Fixture failure' } })); return; }
      const result = command.method === 'projects' ? { projects: [{ id: 'fixture', name: '验收项目', path: 'C:/fixture' }] } : command.method === 'list' ? { conversations: gone ? [] : [task], hasMore: false } : command.method === 'queue.list' ? { queued: [] } : { ...task, epoch: 'fixture', busy: false, turnId: null, requests: [], hasMore: false, settings: { model: 'fixture', mode: 'default', revision: 'v1' }, messages: Array.from({ length: 30 }, (_, i) => ({ id: String(i), role: 'assistant', text: `记录 ${i}. `.repeat(50) })) };
      socket.send(JSON.stringify({ type: 'result', id, result }));
    });
  });
  await page.goto(origin); await expect(page.getByRole('heading', { name: '项目与会话', exact: true })).toBeVisible();
  return { writes, removeTask() { gone = true; } };
}
const documents = (page: Page) => page.evaluate(() => Number(sessionStorage.getItem('fixture-documents')));
async function suspend(page: Page, ms = 120_000) {
  await page.evaluate(ms => { const f = (window as any).resumeFixture; f.visible(false); f.advance(ms); f.visible(true); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); }, ms);
}

test('recreates the page after a browser close and immediate reopen', async ({ page }, info) => {
  const f = await fixture(page);
  await page.evaluate(() => { const overlay = document.createElement('div'); overlay.id = 'stale-native-layer-surrogate'; overlay.style.cssText = 'position:fixed;bottom:0;height:96px;left:0;right:0;background:white;z-index:99999'; document.body.append(overlay); });
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.evaluate(() => { const f = (window as any).resumeFixture; f.visible(false); f.advance(1000); f.visible(true); });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })));
  await expect.poll(() => documents(page)).toBe(2);
  await expect(page.locator('#stale-native-layer-surrogate')).toHaveCount(0); await expect.poll(() => f.writes).toEqual([]);
  await page.waitForTimeout(1200); expect(await documents(page)).toBe(2);
  await page.screenshot({ path: info.outputPath('home-after-close-reopen.png') });
});

test('does not expose a manual home page refresh control', async ({ page }) => {
  const f = await fixture(page);
  await expect(page.getByTitle('刷新页面', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '项目与会话', exact: true })).toBeVisible();
  expect(f.writes).toEqual([]);
});

test('recreates the iPhone home document once after long suspension without task writes or a loop', async ({ page }, info) => {
  const f = await fixture(page);
  // A compositor-only defect cannot be inferred from DOM geometry; this overlay is a surrogate, not an iPhone reproduction.
  await page.evaluate(() => { const overlay = document.createElement('div'); overlay.id = 'stale-native-layer-surrogate'; overlay.style.cssText = 'position:fixed;bottom:0;height:96px;left:0;right:0;background:white;z-index:99999'; document.body.append(overlay); });
  await suspend(page); await expect.poll(() => documents(page)).toBe(2);
  await expect(page.getByRole('heading', { name: '项目与会话', exact: true })).toBeVisible(); await expect(page.locator('#stale-native-layer-surrogate')).toHaveCount(0);
  await page.waitForTimeout(1200); expect(await documents(page)).toBe(2); expect(f.writes).toEqual([]);
  expect(await page.locator('.navigation-footer').evaluate(e => Math.round(e.getBoundingClientRect().bottom))).toBe(670);
  await page.screenshot({ path: info.outputPath('home-after-recovery.png') });
});
test('adds one fresh load after a discarded background page and keeps the selected computer', async ({ page }) => {
  await fixture(page); const selected = await page.evaluate(() => sessionStorage.getItem('remote-active-device'));
  await page.evaluate(() => sessionStorage.setItem('fixture-cold-start', '1'));
  await page.reload(); await expect.poll(() => documents(page)).toBe(3); await expect(page.getByRole('heading', { name: '项目与会话', exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('remote-active-device'))).toBe(selected);
  await page.waitForTimeout(1000); expect(await documents(page)).toBe(3);
  await suspend(page, 61_000); await page.waitForTimeout(1000); expect(await documents(page)).toBe(3);
});
test('does not refresh short switches, search input or an open new-task draft', async ({ page }) => {
  await fixture(page); await suspend(page, 10_000); await page.waitForTimeout(700); expect(await documents(page)).toBe(1);
  await page.getByLabel('搜索会话', { exact: true }).fill('保留搜索'); await page.getByLabel('搜索会话', { exact: true }).blur(); await suspend(page); await page.waitForTimeout(700);
  expect(await documents(page)).toBe(1); await expect(page.getByLabel('搜索会话', { exact: true })).toHaveValue('保留搜索');
  await page.getByLabel('搜索会话', { exact: true }).fill(''); await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.getByLabel('任务', { exact: true }).fill('新任务草稿'); await page.getByLabel('任务', { exact: true }).blur(); await suspend(page); await page.waitForTimeout(700);
  expect(await documents(page)).toBe(1); await expect(page.getByLabel('任务', { exact: true })).toHaveValue('新任务草稿');
});
test('preserves a chat draft, failed attachment and reading position without automatic reload', async ({ page }) => {
  const f = await fixture(page); await page.getByRole('button', { name: task.title, exact: true }).first().click(); await page.getByLabel('消息', { exact: true }).fill('不丢失草稿');
  await page.getByLabel('消息', { exact: true }).blur(); await page.locator('.messages').evaluate(e => { e.scrollTop = 400; e.dispatchEvent(new Event('scroll')); });
  const before = await page.locator('.messages').evaluate(e => e.scrollTop);
  await page.locator('[data-attachment-source="files"]').setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('local file') });
  await expect(page.locator('.pending-attachment')).toContainText('Fixture failure');
  await suspend(page); await page.waitForTimeout(1000); expect(await documents(page)).toBe(1);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('不丢失草稿'); await expect(page.locator('.pending-attachment')).toContainText('draft.txt');
  expect(Math.abs(await page.locator('.messages').evaluate(e => e.scrollTop) - before)).toBeLessThan(4);
  expect(f.writes).toEqual(['upload.begin']);
});
test('keeps an attachment even when its task disappeared and the UI returned home', async ({ page }) => {
  const f = await fixture(page); await page.getByRole('button', { name: task.title, exact: true }).first().click();
  await page.locator('[data-attachment-source="files"]').setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('local file') }); await expect(page.locator('.pending-attachment')).toContainText('Fixture failure');
  f.removeTask(); await page.getByTitle('更多操作', { exact: true }).click(); await page.getByRole('button', { name: '刷新会话', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目与会话', exact: true })).toBeVisible(); await suspend(page); await page.waitForTimeout(800); expect(await documents(page)).toBe(1);
});
test('does not refresh a second computer home while another computer has a cached chat draft', async ({ page }) => {
  await fixture(page); await page.getByRole('button', { name: task.title, exact: true }).first().click(); await page.getByLabel('消息', { exact: true }).fill('第一台电脑的草稿');
  const devices = ['123456789', '987654321'].map((deviceId, i) => ({ deviceId, name: `电脑${i + 1}`, lastUsed: i, expires: Date.now() + 86_400_000, remembered: true, authorized: true, online: true, enabled: true }));
  await page.route(/\/api\/paired-devices(?:\/restore|\/\d+\/select)?$/, route => route.fulfill({ json: { devices } }));
  await page.getByTitle('切换电脑', { exact: true }).click(); await page.getByRole('button', { name: '连接 电脑2', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目与会话', exact: true })).toBeVisible(); await suspend(page); await page.waitForTimeout(800); expect(await documents(page)).toBe(1);
  await page.getByTitle('切换电脑', { exact: true }).click(); await page.getByRole('button', { name: '连接 电脑1', exact: true }).click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('第一台电脑的草稿');
});
test('removes the HEIC footer without removing photo choices, plan mode or distributed notices', async ({ page }, info) => {
  await fixture(page); await page.getByRole('button', { name: task.title, exact: true }).first().click();
  await page.getByTitle('添加照片、文件或计划模式', { exact: true }).click(); const menu = page.getByRole('dialog', { name: '添加内容', exact: true });
  await expect(menu.getByRole('button', { name: '照片图库', exact: true })).toBeVisible(); await expect(menu.getByRole('button', { name: '拍照', exact: true })).toBeVisible(); await expect(menu.getByRole('button', { name: '文件', exact: true })).toBeVisible(); await expect(menu.getByRole('menuitemcheckbox', { name: /计划模式/ })).toBeVisible();
  await expect(menu.locator('a')).toHaveCount(0); expect((await page.request.get(origin + '/third-party/heic-to/NOTICE.txt')).ok()).toBe(true);
  for (const width of [320, 390, 1280]) { await page.setViewportSize({ width, height: 670 }); await page.screenshot({ path: info.outputPath(`menu-${width}.png`) }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
});
