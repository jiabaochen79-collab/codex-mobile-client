import { expect, test, type Page } from '@playwright/test';
import { mockPairedBrowser } from './paired-browser-fixture';

const webkit = process.env.TEST_BROWSER === 'webkit';
test.use({ browserName: webkit ? 'webkit' : 'chromium', viewport: { width: 390, height: 844 }, launchOptions: webkit ? {} : { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } });
const origin = 'http://127.0.0.1:18890';
async function fixture(page: Page, sendError?: string) {
  const task = { id: '12345678-1234-4234-8234-123456789abc', title: '弱网测试任务', cwd: 'C:/fixture', updatedAt: 1 };
  const snapshot = { ...task, epoch: 'fixture', busy: true, turnId: 'running', hasMore: false, queued: [], requests: [], messages: [{ id: 'old', role: 'assistant', text: '已有结果' }], settings: { mode: 'default', revision: 'settings', permission: 'ask' } };
  const status: any = { type: 'status', transport: { heartbeat: true }, online: true, enabled: true, subscription: { access: true }, control: { role: 'controller', epoch: '12345678-1234-4234-8234-123456789abd', terminals: [] }, client: { available: true, capabilities: ['multi-terminal','queued-send','task-mode','command-status','send-messages','project-navigation'] } };
  const frames: any[] = []; let sends = 0, connects = 0, state = 'unknown', silent = false, readFailure = false, activationFailed = false, listFailure = false, searchFailure = false, projectFailure = false;
  let heldNavigation: 'list'|'projects'|'search'|undefined, acceptSends = false;
  let update!: () => void, disconnect!: () => void;
  await mockPairedBrowser(page);
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { mode: 'mobile' } }));
  await page.route('**/api/notifications', route => route.fulfill({ json: { items: [], unread: 0 } }));
  await page.routeWebSocket('**/ws/mobile*', socket => {
    connects++; socket.send(JSON.stringify(status));
    update = () => socket.send(JSON.stringify({ type: 'changed', conversationIds: [task.id] })); disconnect = () => socket.close();
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw)); frames.push(frame);
      if (silent) return;
      if (frame.type === 'ping') { socket.send(JSON.stringify({ type: 'pong', id: frame.id })); return; }
      const command = frame.command;
      if (command.method === 'send') { sends++; if (sendError) socket.send(JSON.stringify({ type: 'result', id: frame.id, error: { code: sendError, message: 'fixture send exception' } })); else if (acceptSends) socket.send(JSON.stringify({ type: 'result', id: frame.id, result: { accepted: true } })); return; }
      if (command.method === 'read' && (readFailure || !activationFailed)) { activationFailed = true; socket.send(JSON.stringify({ type: 'result', id: frame.id, error: { code: 'CLIENT_UNAVAILABLE', message: '任务连接正在恢复' } })); return; }
      if (command.method === 'projects' && heldNavigation === 'projects' || command.method === 'list' && heldNavigation === (command.params.query ? 'search' : 'list')) return;
      if (command.method === 'list' && (command.params.query ? searchFailure : listFailure) || command.method === 'projects' && projectFailure) { socket.send(JSON.stringify({ type: 'result', id: frame.id, error: { code: 'READ_TIMEOUT', message: '列表读取暂时失败' } })); return; }
      const result = command.method === 'list' ? { conversations: [task], hasMore: false } : command.method === 'projects' ? { projects: [] } : command.method === 'read' ? snapshot : command.method === 'command.status' ? { state } : {};
      socket.send(JSON.stringify({ type: 'result', id: frame.id, result }));
    });
  });
  await page.goto(origin); await page.getByRole('button', { name: task.title, exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('任务连接正在恢复'); update();
  await expect(page.getByText('已有结果', { exact: true })).toBeVisible();
  return { task, frames, update: () => update(), disconnect: () => disconnect(), sends: () => sends, connects: () => connects,
    confirm: () => { state = 'succeeded'; }, silent: () => { silent = true; }, rejectReads: (value: boolean) => { readFailure = value; },
    rejectNavigation: (source: 'list'|'projects'|'search', value: boolean) => { if (source === 'list') listFailure = value; else if (source === 'projects') projectFailure = value; else searchFailure = value; },
    holdNavigation: (source?: 'list'|'projects'|'search') => { heldNavigation = source; }, acceptSends: () => { acceptSends = true; } };
}

test('retains explicit activation until the task reconnects, and restores it on reconnect', async ({ page }) => {
  const f = await fixture(page);
  expect(f.frames.filter(f => f.command?.method === 'read').slice(0, 2).every(f => f.command.params.activate)).toBe(true);
  f.disconnect(); await expect.poll(f.connects, { timeout: 10000 }).toBe(2);
  await expect.poll(() => f.frames.filter(f => f.command?.method === 'read').length).toBeGreaterThan(2);
  expect(f.frames.filter(f => f.command?.method === 'read').at(-1).command.params.activate).toBe(true);
  expect(f.frames.some(f => ['send','stop'].includes(f.command?.method))).toBe(false);
});

for (const source of ['list', 'projects', 'search'] as const) test(`does not show an interrupted hidden ${source} request after chat reconnects and sends successfully`, async ({ page }, info) => {
  const f = await fixture(page); const before = f.frames.length;
  await page.getByLabel('消息', { exact: true }).fill('重连后保留的消息');
  f.holdNavigation(source); await page.getByTitle('项目与会话', { exact: true }).click();
  if (source === 'search') await page.getByLabel('搜索会话', { exact: true }).fill('弱网');
  await expect.poll(() => f.frames.slice(before).some(frame => source === 'projects' ? frame.command?.method === 'projects' : frame.command?.method === 'list' && !!frame.command.params.query === (source === 'search'))).toBe(true);
  await page.getByTitle('关闭项目列表', { exact: true }).click(); f.disconnect();
  await expect(page.locator('.chat-status')).toContainText('正在重连');
  await expect.poll(f.connects, { timeout: 10000 }).toBe(2);
  await expect(page.getByTitle('排队发送', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('重连后保留的消息');
  f.acceptSends(); await page.getByTitle('排队发送', { exact: true }).click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue(''); expect(f.sends()).toBe(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(f.frames.some(frame => frame.command?.method === 'stop')).toBe(false);
  f.holdNavigation(); await page.getByTitle('项目与会话', { exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByTitle('关闭项目列表', { exact: true }).click();
  await page.screenshot({ path: info.outputPath(`reconnected-${source}.png`) });
});

test('dismisses only the visible navigation error without erasing an unresolved task read error', async ({ page }) => {
  const f = await fixture(page); f.rejectReads(true); f.update();
  await expect(page.getByRole('alert')).toContainText('任务连接正在恢复');
  f.rejectNavigation('projects', true);
  await page.getByTitle('项目与会话', { exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('列表读取暂时失败');
  await page.getByTitle('关闭提示', { exact: true }).click(); await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByTitle('关闭项目列表', { exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('任务连接正在恢复');
  f.rejectNavigation('projects', false); f.rejectReads(false); f.update(); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('retains an unknown send across reload and queries instead of repeating it', async ({ page }, info) => {
  const f = await fixture(page); await page.getByLabel('消息', { exact: true }).fill('关闭浏览器也不能丢掉');
  await page.getByTitle('排队发送', { exact: true }).click();
  await expect.poll(f.sends).toBe(1); f.disconnect();
  await expect(page.locator('.send-confirmation')).toContainText('发送结果待核对');
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('关闭浏览器也不能丢掉');
  await expect(page.getByTitle('排队发送', { exact: true })).toBeDisabled();
  await page.reload(); await page.getByRole('button', { name: f.task.title, exact: true }).click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('关闭浏览器也不能丢掉');
  await expect(page.locator('.send-confirmation')).toBeVisible(); expect(f.sends()).toBe(1);
  for (const [width, height] of [[320, 360], [390, 400]]) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect.poll(async () => { const box = await page.locator('.composer').boundingBox(); return box!.y + box!.height; }).toBeLessThanOrEqual(height);
    const composer = await page.locator('.composer').boundingBox();
    expect(composer!.x).toBeGreaterThanOrEqual(0); expect(composer!.x + composer!.width).toBeLessThanOrEqual(width);
    expect(composer!.y).toBeGreaterThanOrEqual(0); expect(composer!.y + composer!.height).toBeLessThanOrEqual(height);
    await page.screenshot({ path: info.outputPath(`send-confirmation-${width}.png`) });
  }
  f.confirm(); await page.evaluate(() => document.querySelector<HTMLButtonElement>('.send-confirmation button')?.click());
  await expect(page.locator('.send-confirmation')).toHaveCount(0); await expect(page.getByLabel('消息', { exact: true })).toHaveValue('');
  expect(f.sends()).toBe(1); expect(f.frames.some(f => f.command?.method === 'command.status')).toBe(true);
});

test('coalesces a burst of changed events and clears only the recovered read error', async ({ page }) => {
  const f = await fixture(page); const before = f.frames.filter(f => f.command?.method === 'read').length;
  for (let i = 0; i < 25; i++) f.update();
  await expect.poll(() => f.frames.filter(f => f.command?.method === 'read').length).toBeGreaterThan(before);
  await page.waitForTimeout(700);
  expect(f.frames.filter(f => f.command?.method === 'read').length - before).toBeLessThanOrEqual(2);
  f.rejectReads(true); f.update(); await expect(page.getByRole('alert')).toContainText('任务连接正在恢复');
  f.rejectReads(false); f.update(); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('keeps an internal send failure pending until its outcome is confirmed', async ({ page }) => {
  const f = await fixture(page, 'INTERNAL'); await page.getByLabel('消息', { exact: true }).fill('不能当作发送失败而重复提交');
  await page.getByTitle('排队发送', { exact: true }).click();
  await expect(page.locator('.send-confirmation')).toContainText('发送结果待核对');
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('不能当作发送失败而重复提交');
  await expect(page.getByTitle('排队发送', { exact: true })).toBeDisabled();
  f.update(); await page.waitForTimeout(500); expect(f.sends()).toBe(1);
  f.confirm(); await page.evaluate(() => document.querySelector<HTMLButtonElement>('.send-confirmation button')?.click());
  await expect(page.locator('.send-confirmation')).toHaveCount(0); expect(f.sends()).toBe(1);
});

for (const source of ['list', 'projects', 'search'] as const) test(`clears only the recovered ${source} error in task navigation`, async ({ page }) => {
  const f = await fixture(page); await page.getByLabel('消息', { exact: true }).fill('列表恢复不能删除草稿');
  f.rejectNavigation(source, true); await page.getByTitle('项目与会话', { exact: true }).click();
  if (source === 'search') await page.getByLabel('搜索会话', { exact: true }).fill('弱网');
  await expect(page.getByRole('alert')).toContainText('列表读取暂时失败');
  await page.getByTitle('关闭项目列表', { exact: true }).click(); await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByTitle('项目与会话', { exact: true }).click(); await expect(page.getByRole('alert')).toContainText('列表读取暂时失败');
  f.rejectNavigation(source, false);
  await page.getByTitle('关闭项目列表', { exact: true }).click(); await page.getByTitle('项目与会话', { exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByTitle('关闭项目列表', { exact: true }).click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('列表恢复不能删除草稿'); expect(f.sends()).toBe(0);
});

test('detects a blackholed socket even when the browser still reports it open', async ({ page }) => {
  await page.clock.install(); const f = await fixture(page); f.silent();
  await page.clock.runFor(81000); await expect.poll(f.connects).toBeGreaterThan(1);
  expect(f.frames.some(f => f.type === 'ping')).toBe(true);
  expect(f.sends()).toBe(0);
});
