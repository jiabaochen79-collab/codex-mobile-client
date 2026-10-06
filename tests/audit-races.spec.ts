import { expect, test, type Page, type Route } from '@playwright/test';
import { mockPairedBrowser } from './paired-browser-fixture';

const origin = process.env.PLAN_WEB_ORIGIN ?? 'http://127.0.0.1:18890';
const task = { id: '11111111-1111-4111-8111-111111111111', title: 'Isolated recovery task', cwd: 'C:/fixture', updatedAt: 1 };
async function mobile(page: Page, firstClose = 0) {
  let sockets = 0; let notify!: (item: any) => void;
  await mockPairedBrowser(page);
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { mode: 'mobile' } }));
  await page.routeWebSocket('**/ws/mobile*', ws => {
    sockets++; notify = item => ws.send(JSON.stringify({ type: 'notification', notification: item }));
    if (firstClose && sockets === 1) { setTimeout(() => ws.close({ code: firstClose }), 100); return; }
    ws.send(JSON.stringify({ type: 'status', online: true, enabled: true, subscription: { access: true }, control: { role: 'controller', epoch: 'fixture', terminals: [] }, client: { available: true, capabilities: ['task-mode', 'multi-terminal'] } }));
    ws.onMessage(raw => {
      const { id, command } = JSON.parse(String(raw));
      const result = command.method === 'list' ? { conversations: [task], hasMore: false } : command.method === 'read' ? { ...task, epoch: 'fixture', busy: false, turnId: null, messages: [], requests: [], hasMore: false, settings: { mode: 'default', revision: 'fixture' } } : { accepted: true };
      ws.send(JSON.stringify({ type: 'result', id, result }));
    });
  });
  await page.goto(origin);
  return { notify: (item: any) => notify(item), sockets: () => sockets };
}
for (const width of [320, 390]) test(`retains notification badge during a stale initial count at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); let held: Route | undefined;
  await page.route('**/api/notifications', route => { held = route; }); const f = await mobile(page);
  await expect.poll(() => !!held).toBe(true); await page.getByTitle('更多操作', { exact: true }).click();
  f.notify({ id: 'new', deviceId: '123456789', taskId: task.id, turnId: 'turn-new', sequence: 1, readAt: null });
  await expect(page.locator('.notification-unread-dot')).toHaveCount(1);
  await held!.fulfill({ json: { items: [], unread: 0, throughSequence: 0 } }); await page.waitForTimeout(100);
  await expect(page.locator('.notification-unread-dot')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('retries terminal-limit rejection and clears only the recovered connection error', async ({ page }) => {
  await page.route('**/api/notifications', route => route.fulfill({ json: { items: [], unread: 0 } })); const f = await mobile(page, 4004);
  await expect(page.getByRole('alert')).toContainText('已达到 3 个在线终端');
  await expect.poll(f.sockets, { timeout: 10000 }).toBe(2); await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: task.title, exact: true })).toBeVisible();
});
for (const code of [4001, 4005]) test(`does not reconnect a revoked or banned terminal (${code})`, async ({ page }) => {
  await page.clock.install(); const f = await mobile(page, code);
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeVisible(); await page.clock.runFor(20000); expect(f.sockets()).toBe(1);
});
test('does not discard pairing credentials on a backdrop tap', async ({ page }) => {
  await page.route('**/api/notifications', route => route.fulfill({ json: { items: [], unread: 0 } })); await mobile(page);
  await page.getByTitle('切换电脑', { exact: true }).click(); await page.getByTitle('添加电脑', { exact: true }).click();
  await page.getByLabel('设备 ID', { exact: true }).fill('234567891'); await page.getByLabel('验证码或自定义密码', { exact: true }).fill('fixture-password');
  await page.locator('.pairing-backdrop').click({ position: { x: 2, y: 2 } });
  await expect(page.getByRole('heading', { name: '添加电脑', exact: true })).toBeVisible(); await expect(page.getByLabel('验证码或自定义密码', { exact: true })).toHaveValue('fixture-password');
});
