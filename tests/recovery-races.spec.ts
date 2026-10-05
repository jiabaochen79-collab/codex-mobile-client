import { expect, test, type Route } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const origin = 'http://127.0.0.1:18890';
const mount = (kind: string) => origin + '/@fs/' + fileURLToPath(new URL('./component-harness.html', import.meta.url)).replaceAll('\\', '/') + '?component=' + kind;
const device = { deviceId: '123456789', name: 'Saved computer', authorized: true, remembered: true, online: true, enabled: true, expires: Date.now() + 3600000, lastUsed: 1 };
const row = (id: string, readAt: number | null = null) => ({ id, deviceId: device.deviceId, taskId: id, turnId: id, status: 'completed', occurredAt: Date.now(), createdAt: Date.now(), readAt, delivery: 'accepted' });

for (const recovery of ['online', 'timer']) test(`restores remembered computers after foreground network recovery by ${recovery}`, async ({ page }) => {
  await page.clock.install(); let healthy = false; let calls = 0;
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { mode: 'mobile' } }));
  await page.route('**/api/paired-devices**', route => { calls++; return healthy ? route.fulfill({ json: { devices: [device] } }) : route.fulfill({ status: 503, json: { error: { message: 'fixture restore offline' } } }); });
  await page.routeWebSocket('**/ws/mobile*', socket => socket.send(JSON.stringify({ type: 'status', online: true, enabled: true, client: { available: true, capabilities: [] }, subscription: { access: true } })));
  await page.goto(origin); await expect(page.getByRole('alert')).toContainText('fixture restore offline');
  const initial = calls; healthy = true;
  if (recovery === 'online') await page.evaluate(() => window.dispatchEvent(new Event('online')));
  else await page.clock.runFor(1100);
  await expect.poll(() => calls).toBeGreaterThan(initial);
  await expect(page.getByRole('heading', { name: '连接电脑', exact: true })).toHaveCount(0);
  await expect(page.getByText('fixture restore offline', { exact: true })).toHaveCount(0);
});

test('bounds restore retries and leaves a deliberately entered password intact', async ({ page }) => {
  await page.clock.install(); let healthy = false; let calls = 0;
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { mode: 'mobile' } }));
  await page.route('**/api/paired-devices**', route => { calls++; return healthy ? route.fulfill({ json: { devices: [device] } }) : route.fulfill({ status: 503, json: { error: { message: 'fixture offline ' + calls } } }); });
  await page.goto(origin); await expect(page.getByRole('alert')).toContainText('fixture offline 1');
  for (const [index, ms] of [1100, 3100, 10100].entries()) { await page.clock.runFor(ms); await expect(page.getByRole('alert')).toContainText('fixture offline ' + (index + 2)); }
  expect(calls).toBe(4); await page.clock.runFor(60000); expect(calls).toBe(4);
  await page.getByLabel('设备 ID', { exact: true }).fill('234567891');
  await page.getByLabel('验证码或自定义密码', { exact: true }).fill('unsent-password');
  healthy = true; await page.evaluate(() => window.dispatchEvent(new Event('online'))); await expect.poll(() => calls).toBe(5);
  await expect(page.getByLabel('设备 ID', { exact: true })).toHaveValue('234567891');
  await expect(page.getByLabel('验证码或自定义密码', { exact: true })).toHaveValue('unsent-password');
});

test('discards a stale notification page after read-all and allows refetching the same cursor', async ({ page }) => {
  let held: Route | undefined; let pages = 0;
  await page.route('**/api/notifications/settings', route => route.fulfill({ json: { settings: { enabled: true, completed: true, failed: true }, pushConfigured: false } }));
  await page.route('**/api/notifications', route => route.fulfill({ json: { items: [row('a')], unread: 2, nextCursor: 'next' } }));
  await page.route('**/api/notifications?cursor=*', route => { if (++pages === 1) { held = route; return; } return route.fulfill({ json: { items: [row('b', Date.now())], unread: 0, nextCursor: null } }); });
  await page.route('**/api/notifications/read-all', route => route.fulfill({ json: { ok: true } }));
  await page.goto(mount('notifications')); await expect(page.locator('#unread')).toHaveText('2');
  await page.getByRole('button', { name: '加载更多提醒', exact: true }).click(); await expect.poll(() => !!held).toBe(true);
  await page.getByRole('button', { name: '全部标为已读', exact: true }).click(); await expect(page.locator('#unread')).toHaveText('0');
  await held!.fulfill({ json: { items: [row('b')], unread: 2, nextCursor: null } });
  await expect(page.getByRole('button', { name: '加载更多提醒', exact: true })).toBeEnabled();
  await expect(page.locator('#unread')).toHaveText('0'); await expect(page.locator('.notification-item.unread')).toHaveCount(0);
  await page.getByRole('button', { name: '加载更多提醒', exact: true }).click();
  await expect(page.locator('.notification-item')).toHaveCount(2); await expect(page.locator('#unread')).toHaveText('0');
});

test('serializes background order polls and never regresses a paid response to pending', async ({ page }) => {
  await page.clock.install(); let count = 0; let held: Route | undefined;
  const data = (status: string, marker = '') => ({ orders: [{ id: 'order-a', deviceId: device.deviceId, planName: 'Month', priceFen: 600, created: Date.now(), status, serviceStatus: status === 'paid' ? '已开通' : '未开通' + marker }], licenses: [], refunds: [], readiness: { ready: true, channels: ['alipay'] } });
  await page.route('**/api/orders', route => { count++; if (count === 2) { held = route; return; } return route.fulfill({ json: data(count === 1 ? 'pending' : 'paid') }); });
  await page.route('**/api/subscription', route => route.fulfill({ json: { catalog: { plans: [] }, subscription: { access: true } } }));
  await page.goto(mount('orders')); await expect(page.locator('.purchase-order')).toContainText('未开通');
  await page.clock.runFor(5001); await expect.poll(() => !!held).toBe(true);
  await page.clock.runFor(10001); expect(count).toBe(2);
  await held!.fulfill({ json: data('pending', '（第二次读取）') }); await expect(page.locator('.purchase-order')).toContainText('第二次读取');
  await page.clock.runFor(5001); await expect(page.locator('.purchase-order')).toContainText('已开通');
  await expect(page.getByTitle('打开付款', { exact: true })).toHaveCount(0);
});

test('does not let a poll started before an order mutation overwrite its refreshed result', async ({ page }) => {
  await page.clock.install(); let calls = 0; let held: Route | undefined;
  const data = (status: string) => ({ orders: [{ id: 'order-a', deviceId: device.deviceId, planName: 'Month', priceFen: 600, created: Date.now(), status, serviceStatus: status === 'paid' ? '已开通' : '未开通' }], licenses: [], refunds: [], readiness: { ready: true, channels: ['alipay'] } });
  await page.route('**/api/orders', route => { if (++calls === 2) { held = route; return; } return route.fulfill({ json: data(calls === 1 ? 'pending' : 'paid') }); });
  await page.route('**/api/subscription', route => route.fulfill({ json: { catalog: { plans: [] }, subscription: { access: true } } }));
  await page.route('**/api/orders/order-a/close', route => route.fulfill({ json: { ok: true } }));
  await page.goto(mount('orders')); await expect(page.locator('.purchase-order')).toContainText('未开通');
  await page.clock.runFor(5001); await expect.poll(() => !!held).toBe(true);
  await page.getByTitle('关闭待支付订单', { exact: true }).click(); await expect(page.locator('.purchase-order')).toContainText('已开通');
  await held!.fulfill({ json: data('pending') });
  await expect(page.locator('.purchase-order')).toContainText('已开通'); await expect(page.getByTitle('打开付款', { exact: true })).toHaveCount(0);
});
