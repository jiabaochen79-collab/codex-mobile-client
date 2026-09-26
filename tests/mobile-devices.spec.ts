import { expect, test, type Page } from '@playwright/test';

const origin = 'http://127.0.0.1:18890'; const password = 'Multiple-Computers-Fixture42';
let home: string, office: string;
const webkit = process.env.TEST_BROWSER === 'webkit';
test.use({ browserName: webkit ? 'webkit' : 'chromium', viewport: { width: 390, height: 844 }, launchOptions: webkit ? {} : { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } });
test.beforeEach(async ({ request }) => {
  for (const [port, token] of [[18891, process.env.FIXTURE_LOCAL_TOKEN], [18894, process.env.FIXTURE_SECOND_LOCAL_TOKEN]] as const) {
    if (!token) throw new Error('Start the dual computer browser fixture first.');
    const result = await request.post(`http://127.0.0.1:${port}/local/password`, { headers: { Authorization: `Bearer ${token}` }, data: { mode: 'custom', password } }); expect(result.ok()).toBe(true);
    const state = await result.json(); if (port === 18891) home = state.deviceId; else office = state.deviceId;
  }
});
async function pair(page: Page, id: string) { await page.getByLabel('设备 ID', { exact: true }).fill(id); await page.getByLabel('验证码或自定义密码').fill(password); await page.getByRole('button', { name: '连接', exact: true }).click(); await expect(page.getByRole('heading', { name: '项目与会话', exact: true })).toBeVisible(); }
async function menu(page: Page) { await page.getByTitle('切换电脑', { exact: true }).last().click(); await expect(page.getByRole('dialog', { name: '我的电脑', exact: true })).toBeVisible(); }
async function twoComputers(page: Page) { await page.goto(origin); await pair(page, home); await menu(page); await page.getByTitle('添加电脑', { exact: true }).click(); await pair(page, office); }
async function switchTo(page: Page, id: string) { await menu(page); await page.locator(`.saved-device[data-device-id="${id}"] .select-device`).click(); await expect(page.getByRole('dialog', { name: '我的电脑', exact: true })).toBeHidden(); }
async function task(page: Page, title: string) { const project = page.locator('.project-toggle').filter({ hasText: '产品研发' }); if (await project.getAttribute('aria-expanded') !== 'true') await project.click(); await page.locator('.project-conversations .nav-conversation').filter({ hasText: title }).click(); await expect(page.locator('.chat-toolbar h1')).toHaveText(title); await expect(page.getByLabel('消息', { exact: true })).toBeEnabled(); }

test('switches without passwords and preserves each computer draft and reading position', async ({ page }, info) => {
  await twoComputers(page); await task(page, '公司端验收记录'); await page.getByLabel('消息', { exact: true }).fill('公司电脑的草稿');
  await page.locator('.messages').evaluate(element => { element.scrollTop = 280; element.dispatchEvent(new Event('scroll')); });
  const position = await page.locator('.messages').evaluate(element => element.scrollTop);
  const pairings: string[] = []; page.on('request', request => { if (request.url().endsWith('/api/connect')) pairings.push(request.url()); });
  await switchTo(page, home); await task(page, '移动端验收记录'); await expect(page.getByLabel('消息', { exact: true })).toHaveValue(''); await page.getByLabel('消息', { exact: true }).fill('家里电脑的草稿');
  await switchTo(page, office); await expect(page.getByLabel('消息', { exact: true })).toHaveValue('公司电脑的草稿');
  await expect.poll(() => page.locator('.messages').evaluate(element => element.scrollTop)).toBeGreaterThan(position - 8);
  expect(await page.locator('.messages').evaluate(element => element.scrollTop)).toBeLessThan(position + 8);
  await expect(page.getByTitle('回到最新消息')).toBeVisible(); expect(pairings).toEqual([]);
  await page.screenshot({ path: info.outputPath('office-restored.png') }); await menu(page); await page.screenshot({ path: info.outputPath('computer-switcher.png') });
});
test('keeps plan mode and attachments isolated when switching computers', async ({ page }) => {
  await twoComputers(page); await task(page, '公司端验收记录');
  const close = page.getByTitle('关闭计划模式', { exact: true });
  if (await close.count()) await close.click();
  await page.locator('input[data-attachment-source="files"]').setInputFiles({ name: 'mode.txt', mimeType: 'text/plain', buffer: Buffer.from('retained attachment') });
  await expect(page.locator('.pending-attachment')).toContainText('已上传'); await page.getByLabel('消息', { exact: true }).fill('计划草稿');
  await page.getByTitle('添加照片、文件或计划模式').click(); await page.getByRole('menuitemcheckbox', { name: /计划模式/ }).click(); await expect(close).toBeEnabled();
  await expect(page.locator('.pending-attachment')).toContainText('已上传');
  await switchTo(page, home); await task(page, '移动端验收记录'); await expect(close).toBeHidden(); await expect(page.locator('.pending-attachment')).toHaveCount(0);
  await switchTo(page, office); await expect(close).toBeEnabled(); await expect(page.getByLabel('消息', { exact: true })).toHaveValue('计划草稿'); await expect(page.locator('.pending-attachment')).toContainText('已上传');
  await close.click(); await expect(close).toBeHidden(); await page.getByTitle('移除附件', { exact: true }).click();
});
test('keeps independent targets in two tabs and scopes images, subscriptions, orders, and attachments', async ({ page, context }) => {
  await twoComputers(page); const second = await context.newPage(); await second.goto(origin); await switchTo(second, home); await task(page, '公司端验收记录'); await task(second, '移动端验收记录');
  await page.getByLabel('消息', { exact: true }).fill('office only'); await expect(second.getByLabel('消息', { exact: true })).toHaveValue('');
  const images = await page.locator('.message-image img').evaluateAll(elements => elements.map(element => (element as HTMLImageElement).src)); expect(images.length).toBeGreaterThan(0); expect(images.every(url => new URL(url).searchParams.get('remoteDevice') === office)).toBe(true);
  await page.getByTitle('项目与会话', { exact: true }).click(); const subscription = page.waitForRequest(request => request.url().endsWith('/api/subscription'));
  await page.getByTitle('订阅与权益', { exact: true }).click(); expect((await subscription).headers()['x-remote-device']).toBe(office);
  const orders = page.waitForRequest(request => request.url().endsWith('/api/orders')); await page.getByRole('button', { name: '查看订单与续费' }).click(); expect((await orders).headers()['x-remote-device']).toBe(office); await expect(page.locator('.purchase-device')).toContainText(office);
  await page.getByTitle('关闭订单').click(); await page.getByTitle('关闭订阅').click(); await page.getByTitle('关闭项目列表').click();
  const upload = page.waitForRequest(request => request.method() === 'PUT' && request.url().includes('/api/uploads/'));
  await page.locator('input[data-attachment-source="files"]').setInputFiles({ name: 'office.txt', mimeType: 'text/plain', buffer: Buffer.from('office fixture') }); expect((await upload).headers()['x-remote-device']).toBe(office); await expect(page.locator('.pending-attachment')).toContainText('已上传');
  expect(await second.locator('.pending-attachment').count()).toBe(0); await expect(second.locator('.chat-toolbar h1')).toHaveText('移动端验收记录'); await second.close();
});
test('renames, sorts, removes one computer, and logs out all remembered computers', async ({ page, context }) => {
  await twoComputers(page); await menu(page); const row = page.locator(`.saved-device[data-device-id="${home}"]`); await row.locator('.saved-device-row>.icon-button').click(); await page.getByTitle('重命名电脑').click(); await page.getByLabel('电脑名称', { exact: true }).fill('家里电脑'); await page.getByRole('button', { name: '保存', exact: true }).click(); await expect(row).toContainText('家里电脑');
  await row.getByTitle('下移电脑').click(); await expect(page.locator('.saved-device').first()).toHaveAttribute('data-device-id', office); await page.reload(); await menu(page); await expect(page.locator('.saved-device').last()).toContainText('家里电脑');
  await page.locator(`.saved-device[data-device-id="${home}"] .saved-device-row>.icon-button`).click(); await page.getByTitle('移除此电脑', { exact: true }).click(); await page.getByRole('button', { name: '确认移除', exact: true }).click(); await expect(page.locator('.saved-device')).toHaveCount(1);
  await page.getByRole('button', { name: '退出全部电脑', exact: true }).click(); await page.getByRole('button', { name: '确认退出', exact: true }).click(); await expect(page.getByLabel('设备 ID', { exact: true })).toBeVisible();
  const response = await context.request.get(origin + '/api/session', { headers: { 'X-Remote-Device': office } }); expect(response.status()).toBe(401); expect((await context.cookies()).filter(cookie => cookie.name === 'remote_session')).toEqual([]);
});
test('offers wait or cancel during upload and never sends cancelled bytes to the next computer', async ({ page }) => {
  await twoComputers(page); await task(page, '公司端验收记录');
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve); const targets: string[] = [];
  await page.route('**/api/uploads/**', async route => { targets.push(route.request().headers()['x-remote-device']); await gate; await route.continue().catch(() => {}); });
  await page.locator('input[data-attachment-source="files"]').setInputFiles({ name: 'pending.txt', mimeType: 'text/plain', buffer: Buffer.alloc(128000, 'a') }); await expect.poll(() => targets.length).toBeGreaterThan(0);
  await menu(page); await page.locator(`.saved-device[data-device-id="${home}"] .select-device`).click(); await expect(page.getByRole('dialog', { name: '文件正在上传' })).toBeVisible(); await page.getByRole('button', { name: '继续等待', exact: true }).click(); await expect(page.locator('.chat-toolbar h1')).toHaveText('公司端验收记录');
  await page.locator(`.saved-device[data-device-id="${home}"] .select-device`).click(); await page.getByRole('button', { name: '取消上传并切换' }).click(); release(); await task(page, '移动端验收记录'); expect(await page.locator('.pending-attachment').count()).toBe(0); expect(targets.every(id => id === office)).toBe(true);
});
test('does not stop a running task when switching and does not automatically switch away from an offline computer', async ({ page }) => {
  let offline = false; const stopped: string[] = [];
  await page.routeWebSocket('**/ws/mobile*', ws => {
    const server = ws.connectToServer();
    ws.onMessage(data => { const frame = JSON.parse(String(data)); if (frame.command?.method === 'stop') stopped.push(String(data)); server.send(data); });
    server.onMessage(data => { const frame = JSON.parse(String(data)); if (offline && new URL(ws.url()).searchParams.get('remoteDevice') === office && frame.type === 'status') frame.online = false; ws.send(JSON.stringify(frame)); });
  });
  await twoComputers(page); await task(page, '公司端验收记录'); await page.getByLabel('消息', { exact: true }).fill('fixture running task'); await page.getByTitle('发送消息', { exact: true }).click(); await expect(page.getByTitle('停止当前生成', { exact: true })).toBeVisible();
  await switchTo(page, home); await task(page, '移动端验收记录'); await switchTo(page, office); await expect(page.locator('.message.assistant').last()).toContainText('本次检查已完成。', { timeout: 10000 }); expect(stopped).toEqual([]);
  offline = true; await page.reload(); await expect(page.locator('.navigation-footer')).toContainText('电脑离线'); await expect(page.getByTitle('切换电脑', { exact: true })).toContainText(office.replace(/(\d{3})(?=\d)/g, '$1 '));
});
test('fits the device menu and long names at phone and desktop widths', async ({ page }, info) => {
  await twoComputers(page); await menu(page); await page.locator(`.saved-device[data-device-id="${office}"] .saved-device-row>.icon-button`).click(); await page.getByTitle('重命名电脑').click(); await page.getByLabel('电脑名称', { exact: true }).fill('公司研发电脑'.repeat(6)); await page.getByRole('button', { name: '保存', exact: true }).click();
  for (const [width, height] of [[320, 568], [390, 844], [1280, 900]]) { await page.setViewportSize({ width, height }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); const box = await page.getByRole('dialog', { name: '我的电脑', exact: true }).boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width); await page.screenshot({ path: info.outputPath(`computers-${width}.png`) }); }
});
test('a late logout response from the previous computer cannot clear the new computer selection or draft', async ({ page }) => {
  await twoComputers(page); await task(page, '公司端验收记录'); await page.getByLabel('消息', { exact: true }).fill('keep office draft'); await switchTo(page, home);
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve); let finished = false;
  await page.route('**/api/logout', async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); finished = true; });
  try {
    await page.getByTitle('退出登录', { exact: true }).click(); await expect(page.getByLabel('设备 ID', { exact: true })).toBeVisible();
    await page.getByTitle('我的电脑', { exact: true }).click(); await page.locator(`.saved-device[data-device-id="${office}"] .select-device`).click(); await expect(page.getByLabel('消息', { exact: true })).toHaveValue('keep office draft');
    release(); await expect.poll(() => finished).toBe(true); await expect(page.locator('.chat-toolbar h1')).toHaveText('公司端验收记录'); expect(await page.evaluate(() => sessionStorage.getItem('remote-active-device'))).toBe(office);
  } finally { release(); }
});
test('revoking the current computer during a new pairing cannot replace the submitted device or password', async ({ page, request }) => {
  await page.goto(origin); await pair(page, home); await menu(page); await page.getByTitle('添加电脑', { exact: true }).click(); await page.getByLabel('设备 ID', { exact: true }).fill(office); await page.getByLabel('验证码或自定义密码').fill(password);
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve); let waiting = false;
  await page.route('**/api/paired-devices/restore', async route => { const response = await route.fetch(); waiting = true; await gate; await route.fulfill({ response }); });
  const submitted = page.waitForRequest(request => request.url().endsWith('/api/connect'));
  try {
    await page.getByRole('button', { name: '连接', exact: true }).click(); await expect.poll(() => waiting).toBe(true);
    await request.post('http://127.0.0.1:18891/local/password', { headers: { Authorization: `Bearer ${process.env.FIXTURE_LOCAL_TOKEN}` }, data: { mode: 'custom', password } });
    await expect(page.getByRole('alert')).toContainText('授权已失效'); release(); expect((await submitted).postDataJSON()).toMatchObject({ deviceId: office, code: password }); await expect(page.getByRole('heading', { name: '项目与会话', exact: true })).toBeVisible(); await expect(page.getByTitle('切换电脑', { exact: true })).toContainText(office.replace(/(\d{3})(?=\d)/g, '$1 '));
  } finally { release(); }
});
test('removing the last computer returns to a single login surface', async ({ page }) => {
  await page.goto(origin); await pair(page, home); await menu(page); await page.locator('.saved-device-row>.icon-button').click(); await page.getByTitle('移除此电脑', { exact: true }).click(); await page.getByRole('button', { name: '确认移除', exact: true }).click();
  await expect(page.getByRole('heading', { name: '连接电脑', exact: true })).toBeVisible(); await expect(page.locator('.mobile-shell')).toHaveCount(1); await expect(page.locator('.device-directory')).toHaveCount(0);
});
test('migrates the legacy tab controller identity when refreshing into the multi-computer interface', async ({ page, context }) => {
  await page.goto(origin); await expect(page.getByLabel('设备 ID', { exact: true })).toBeVisible(); const response = await context.request.post(origin + '/api/connect', { headers: { Origin: origin }, data: { deviceId: home, code: password, remember: true } }); expect(response.ok()).toBe(true);
  const legacyId = '76543210-1234-4234-8234-123456789abc';
  await page.evaluate(async legacyId => {
    sessionStorage.setItem('remote-client-id', legacyId);
    await new Promise<void>((resolve, reject) => { const socket = new WebSocket(location.origin.replace('http:', 'ws:') + '/ws/mobile?clientId=' + legacyId); (window as any).legacyTestSocket = socket; socket.onmessage = event => { const frame = JSON.parse(event.data); if (frame.type === 'status') { if (frame.control?.role === 'controller') resolve(); else reject(new Error('Fixture legacy controller not granted')); } }; socket.onerror = reject; });
  }, legacyId);
  await page.reload(); await expect(page.locator('.navigation-footer .status')).toHaveText('已连接'); expect(await page.evaluate(home => sessionStorage.getItem('remote-client-id:' + home), home)).toBe(legacyId); expect(await page.evaluate(() => sessionStorage.getItem('remote-client-id'))).toBeNull();
});
