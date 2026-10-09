import { expect, test, type Page } from '@playwright/test';
import { mockPairedBrowser } from './paired-browser-fixture';
import { PLANS, TERMS_VERSION } from '../src/shared/subscription';
const origin = process.env.PLAN_WEB_ORIGIN!;
const taskId = '12345678-1234-4234-8234-123456789abc';

async function pairedHome(page: Page) {
  await mockPairedBrowser(page);
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { mode: 'mobile' } }));
  await page.routeWebSocket('**/ws/mobile*', socket => {
    socket.send(JSON.stringify({ type: 'status', online: true, enabled: true, subscription: { access: true }, client: { available: true } }));
    socket.onMessage(raw => { const { id, command } = JSON.parse(String(raw)); socket.send(JSON.stringify({ type: 'result', id, result: command.method === 'list' ? { conversations: [], hasMore: false } : {} })); });
  });
  await page.goto(origin);
}

test('keeps notification list errors retryable and recovers the actual list', async ({ page }, info) => {
  let failed = true;
  await page.route('**/api/notifications', route => route.fulfill(failed ? { status: 503, json: { error: { code: 'NETWORK', message: 'notification-list-fixture' } } } : { json: { items: [], unread: 0 } }));
  await page.route('**/api/notifications/settings', route => route.fulfill({ json: { settings: { enabled: false, completed: true, failed: true }, revision: 'fixture', pushConfigured: false } }));
  await pairedHome(page);
  await page.getByTitle('更多操作', { exact: true }).click(); await page.getByRole('button', { name: '任务完成提醒', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '任务完成提醒', exact: true });
  await expect(dialog.getByRole('button', { name: '重试读取', exact: true })).toBeVisible();
  await expect(dialog.getByText('暂无任务完成提醒', { exact: true })).toHaveCount(0);
  failed = false; await dialog.getByRole('button', { name: '重试读取', exact: true }).click();
  await expect(dialog.getByText('暂无任务完成提醒', { exact: true })).toBeVisible(); await expect(dialog.getByRole('alert')).toHaveCount(0);
  for (const width of [320, 390]) { await page.setViewportSize({ width, height: 640 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: info.outputPath('notifications-recovered-' + width + '.png') }); }
});

test('shows the distribution plan and source without displaying a fictitious payment', async ({ page }, info) => {
  const now = Date.now();
  await page.route('**/api/notifications', route => route.fulfill({ json: { items: [], unread: 0 } }));
  await page.route('**/api/subscription', route => route.fulfill({ json: { subscription: { access: true, serverTime: now }, catalog: { salesOpen: false, termsVersion: TERMS_VERSION, plans: PLANS } } }));
  await page.route('**/api/orders', route => route.fulfill({ json: { deviceId: '123456789', ownerRevision: 'fixture', historyRevision: 'fixture', readiness: { ready: false, channels: [] }, orders: [], refunds: [], licenses: [{ id: 'fixture-license', sku: 'quarter', source: 'license', price_fen: 0, starts: now, ends: now + 90 * 86400000 }], hasMore: false } }));
  await pairedHome(page); await page.getByRole('button', { name: '订阅与权益', exact: true }).click();
  await page.getByRole('button', { name: '查看订单与续费', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '订单与续费', exact: true });
  await expect(dialog).toContainText('分销授权码兑换'); await expect(dialog).toContainText(PLANS.find(plan => plan.id === 'quarter')!.name); await expect(dialog).not.toContainText('¥0.00');
  for (const width of [320, 390]) { await page.setViewportSize({ width, height: 640 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: info.outputPath('distribution-record-' + width + '.png') }); }
});

test('keeps a subscription dialog closable during a stalled background read at mobile widths', async ({ page }, info) => {
  await page.clock.install(); let reads = 0; let release!: () => void;
  const waiting = new Promise<void>(resolve => release = resolve);
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { mode: 'mobile' } }));
  await page.route('**/api/session*', route => route.fulfill({ status: 401, json: { error: { code: 'AUTH' } } }));
  await page.route('**/api/plans', async route => {
    reads++; if (reads > 1) await waiting;
    await route.fulfill({ json: { salesOpen: false, termsVersion: TERMS_VERSION, plans: PLANS.map(plan => ({ ...plan, available: false })) } }).catch(() => {});
  });
  try {
    await page.goto(origin); await page.getByRole('button', { name: '订阅与权益', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '订阅与权益', exact: true });
    await expect(dialog).toContainText('¥6');
    await expect.poll(() => reads).toBe(1);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 640 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath('subscription-' + width + '.png') });
    }
    await page.clock.runFor(15001); await expect.poll(() => reads).toBe(2);
    await expect(page.getByTitle('关闭订阅', { exact: true })).toBeEnabled();
    await page.getByTitle('关闭订阅', { exact: true }).click(); await expect(dialog).toHaveCount(0);
  } finally { release(); }
});

test('removes desktop-undone tail messages and retains a recovered unconfirmed draft', async ({ page }) => {
  await mockPairedBrowser(page);
  await page.addInitScript(({ taskId }) => {
    localStorage.setItem('pending-send:123456789:' + taskId, JSON.stringify({ requestId: '12345678-1234-4234-8234-123456789abd', text: 'recovered requirement', attachments: [] }));
  }, { taskId });
  const conversation = { id: taskId, title: 'Undo fixture', cwd: 'C:/fixture', updatedAt: 1 };
  const snapshot: any = { ...conversation, epoch: 'fixture', busy: false, turnId: null, hasMore: true, historyCursor: 'old', requests: [], messages: [
    { id: 'old', role: 'user', text: 'older retained requirement' }, { id: 'overlap', role: 'user', text: 'retained anchor' }, { id: 'removed', role: 'user', text: 'undone requirement' }
  ] };
  let changed!: () => void;
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { mode: 'mobile' } }));
  await page.route('**/api/notifications*', route => route.fulfill({ json: { items: [], unread: 0 } }));
  await page.routeWebSocket('**/ws/mobile*', socket => {
    socket.send(JSON.stringify({ type: 'status', online: true, enabled: true, subscription: { access: true }, client: { available: true, capabilities: ['history-pages'] } }));
    changed = () => socket.send(JSON.stringify({ type: 'changed', conversationIds: [taskId] }));
    socket.onMessage(raw => {
      const { id, command } = JSON.parse(String(raw));
      socket.send(JSON.stringify({ type: 'result', id, result: command.method === 'list' ? { conversations: [conversation], hasMore: false } : command.method === 'read' ? snapshot : {} }));
    });
  });
  await page.goto(origin); await page.getByRole('button', { name: conversation.title, exact: true }).click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('recovered requirement');
  await expect(page.getByText('undone requirement', { exact: true })).toBeVisible();
  snapshot.messages.splice(2); snapshot.historyCursor = 'overlap'; changed();
  await expect(page.getByText('undone requirement', { exact: true })).toHaveCount(0);
  await expect(page.getByText('older retained requirement', { exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '已核对，保留为草稿', exact: true }).click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('recovered requirement');
  await expect(page.getByRole('button', { name: '已核对，保留为草稿', exact: true })).toHaveCount(0);
});
