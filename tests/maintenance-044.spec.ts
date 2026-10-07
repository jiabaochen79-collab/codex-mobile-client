import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const origin = 'http://127.0.0.1:19976', deviceId = '123456789';
const tasks = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
async function mobile(page: Page, index: number, state: { controller: number; sockets: Map<number, any>; sends: number }) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname; let data: any = {};
    if (path === '/api/bootstrap') data = { mode: 'mobile' };
    if (path.startsWith('/api/paired-devices')) data = { devices: [{ deviceId, name: 'Regression', authorized: true, online: true, enabled: true, remembered: true, lastUsed: 1, expires: Date.now() + 86400000 }] };
    if (path === '/api/notifications') data = { items: [], unread: 0 };
    if (path === '/api/web-version') data = { entry: '/assets/new-version.js' };
    await route.fulfill({ json: data });
  });
  await page.routeWebSocket('**/ws/mobile*', socket => {
    state.sockets.set(index, socket); socket.send(status(index, state.controller));
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw)); if (!frame.command) return; const command = frame.command; let result: any = {};
      if (command.method === 'list') result = { conversations: tasks.map((id, n) => ({ id, title: `Task ${n + 1}`, cwd: 'C:/fixture', updatedAt: n + 1 })), hasMore: false };
      if (command.method === 'projects') result = { projects: [{ id: 'first', name: 'First', path: 'C:/first' }, { id: 'second', name: 'Second', path: 'C:/second' }] };
      if (command.method === 'read') result = { id: command.params.id, title: 'Task', epoch: 'fixture', busy: false, turnId: null, messages: [], requests: [], hasMore: false, settings: { model: 'fixture', effort: 'high', mode: 'default', permission: 'ask', revision: 'fixture' } };
      if (command.method === 'command.status') result = { state: 'unknown' };
      if (command.method === 'send') {
        state.sends++;
        if (!index) { socket.send(JSON.stringify({ type: 'result', id: frame.id, error: { code: 'OUTCOME_UNKNOWN', message: 'Lost acknowledgement' } })); return; }
        result = { accepted: true };
      }
      socket.send(JSON.stringify({ type: 'result', id: frame.id, result }));
    });
  });
  await page.goto(origin);
}
function status(index: number, controller: number) { return JSON.stringify({ type: 'status', online: true, enabled: true, control: { role: index === controller ? 'controller' : 'viewer', epoch: 'fixture', terminals: [] }, subscription: { access: true }, client: { available: true, capabilities: ['task-mode', 'command-status'] } }); }

test('an unrelated send in another tab cannot remove an unresolved send after reload', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const state = { controller: 0, sockets: new Map<number, any>(), sends: 0 };
  const a = await context.newPage(), b = await context.newPage();
  try {
    await mobile(a, 0, state); await a.getByRole('button', { name: 'Task 1', exact: true }).click();
    await mobile(b, 1, state); await b.getByRole('button', { name: 'Task 2', exact: true }).click();
    await a.getByLabel('消息', { exact: true }).fill('Unknown send'); await a.getByTitle('发送消息', { exact: true }).click();
    await expect(a.getByText('发送结果待核对，内容已保留，不会自动重发。', { exact: true })).toBeVisible();
    state.controller = 1; for (const [index, socket] of state.sockets) socket.send(status(index, 1));
    await b.getByLabel('消息', { exact: true }).fill('Acknowledged send'); await b.getByTitle('发送消息', { exact: true }).click();
    await expect(b.getByLabel('消息', { exact: true })).toHaveValue('');
    state.controller = 0; for (const [index, socket] of state.sockets) socket.send(status(index, 0));
    await a.reload(); await a.getByRole('button', { name: 'Task 1', exact: true }).click();
    await expect(a.getByText('发送结果待核对，内容已保留，不会自动重发。', { exact: true })).toBeVisible();
    await expect(a.getByTitle('发送消息', { exact: true })).toBeDisabled(); await expect(a.getByLabel('消息', { exact: true })).toHaveValue('Unknown send');
    expect(state.sends).toBe(2);
  } finally { await context.close(); }
});

for (const width of [320, 390]) test(`refresh update preserves a new task's text and project at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); await mobile(page, 0, { controller: 0, sockets: new Map(), sends: 0 });
  await page.getByTitle('新建任务', { exact: true }).click(); await page.getByLabel('任务', { exact: true }).fill('Unsubmitted task'); await page.getByLabel('现有项目').selectOption('second');
  await page.getByRole('dialog', { name: '新建任务' }).getByTitle('关闭', { exact: true }).click();
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: '刷新更新', exact: true }).click()]);
  await page.getByTitle('新建任务', { exact: true }).click();
  await expect(page.getByLabel('任务', { exact: true })).toHaveValue('Unsubmitted task'); await expect(page.getByLabel('现有项目')).toHaveValue('second');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('service validity follows server time despite a phone clock that is two days ahead', async ({ page }) => {
  const day = 86400000, now = Date.now(); await page.addInitScript(skew => { const original = Date.now; Date.now = () => original() + skew; }, 2 * day);
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const data = path === '/api/orders' ? { deviceId, ownerRevision: 'fixture', historyRevision: 'fixture', orders: [], licenses: [{ id: 'license', source: 'online', price_fen: 600, starts: now - day, ends: now + day }], refunds: [], hasMore: false, readiness: { ready: true, channels: ['alipay'] } } : { subscription: { access: true, serverTime: now, expiresAt: now + day }, catalog: { plans: [] } };
    return route.fulfill({ json: data });
  });
  await page.goto(origin + '/@fs/' + fileURLToPath(new URL('./component-harness.html', import.meta.url)).replaceAll('\\', '/') + '?component=orders');
  await expect(page.locator('.purchase-order')).toContainText('有效至'); await expect(page.locator('.purchase-order')).not.toContainText('已到期');
});
