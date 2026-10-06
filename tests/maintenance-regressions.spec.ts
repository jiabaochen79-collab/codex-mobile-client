import { expect, test, type Route } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const origin = process.env.PLAN_WEB_ORIGIN ?? 'http://127.0.0.1:18890';
const mount = (kind: string) => origin + '/@fs/' + fileURLToPath(new URL('./component-harness.html', import.meta.url)).replaceAll('\\', '/') + '?component=' + kind;
const notification = (id: string) => ({ id, deviceId: '123456789', taskId: id, turnId: id, status: 'completed', occurredAt: Date.now(), createdAt: Date.now(), readAt: null, delivery: 'accepted' });
const update = (phase: string) => ({ phase, progress: 100, version: '0.4.28', autoDownload: true });

for (const newer of [false, true]) test(`reconciles arrivals against the persisted read-all watermark (${newer})`, async ({ page }) => {
  let held: Route | undefined;
  await page.route('**/api/notifications/settings', route => route.fulfill({ json: { settings: { enabled: true }, pushConfigured: false } }));
  await page.route('**/api/notifications', route => route.fulfill({ json: { items: [{ ...notification('old'), sequence: 1 }], unread: 1, throughSequence: 1 } }));
  await page.route('**/api/notifications/read-all', route => { held = route; });
  await page.goto(mount('notifications')); await expect(page.locator('#unread')).toHaveText('1');
  await page.getByRole('button', { name: '全部标为已读', exact: true }).click(); await expect.poll(() => !!held).toBe(true);
  await page.evaluate(detail => window.dispatchEvent(new CustomEvent('remote-notification', { detail })), { ...notification('during'), sequence: 2 });
  await held!.fulfill({ json: { ok: true, readAt: Date.now(), throughSequence: newer ? 1 : 2, unread: 0 } });
  await expect(page.locator('#unread')).toHaveText(newer ? '1' : '0'); await expect(page.locator('.notification-item.unread')).toHaveCount(newer ? 1 : 0);
});
test('preserves a payment ticket after exchange failure and removes it only after successful retry', async ({ page }) => {
  let exchanges = 0; let starts = 0; let healthy = false; const order = { id: 'order-fixture', deviceId: '123456789', planName: 'Monthly', priceFen: 600, days: 30, channel: 'alipay', status: 'pending', serviceStatus: '未开通', expires: Date.now() + 900000 };
  await page.route('**/api/payments/session**', route => {
    if (route.request().method() === 'POST') { exchanges++; return route.fulfill(!healthy ? { status: 503, json: { error: { message: 'temporary exchange failure' } } } : { json: { orderId: order.id } }); }
    return route.fulfill({ json: { order, readiness: { ready: true } } });
  });
  await page.route('**/api/payments/start', route => { starts++; return route.fulfill({ json: {} }); });
  await page.goto(mount('pay') + '#ticket=fixture-ticket'); await expect(page.getByRole('alert')).toHaveText('temporary exchange failure');
  expect(new URL(page.url()).hash).toBe('#ticket=fixture-ticket'); expect(exchanges).toBe(1);
  await page.reload(); await expect(page.getByRole('alert')).toHaveText('temporary exchange failure'); expect(new URL(page.url()).hash).toBe('#ticket=fixture-ticket'); healthy = true;
  await page.getByRole('button', { name: '重新读取订单', exact: true }).click(); await expect(page.getByRole('button', { name: '支付宝付款', exact: true })).toBeEnabled();
  expect(new URL(page.url()).hash).toBe(''); expect(new URL(page.url()).searchParams.get('order')).toBe(order.id); expect(starts).toBe(0); expect(exchanges).toBe(3);
  await page.goto(mount('pay') + '&order=' + order.id); await expect(page.getByRole('button', { name: '支付宝付款', exact: true })).toBeEnabled(); expect(exchanges).toBe(3);
});
test('clears desktop read errors on recovery without erasing mutation errors', async ({ page }) => {
  await page.clock.install(); let healthy = false;
  await page.route('**/local/state', route => route.fulfill(healthy ? { json: { deviceId: '123456789', enabled: true, connection: 'online', client: {}, url: 'https://example.invalid' } } : { status: 400, json: { error: { message: 'temporary desktop read failure' } } }));
  await page.route('**/local/enabled', route => route.fulfill({ status: 400, json: { error: { message: 'desktop mutation rejected' } } }));
  await page.goto(mount('desktop')); await expect(page.getByRole('alert')).toHaveText('temporary desktop read failure');
  healthy = true; await page.clock.runFor(3001); await expect(page.getByText('服务器已连接', { exact: true })).toBeVisible(); await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('checkbox', { name: '允许远程连接', exact: true }).uncheck(); await expect(page.getByRole('alert')).toHaveText('desktop mutation rejected');
  await page.clock.runFor(6001); await expect(page.getByRole('alert')).toHaveText('desktop mutation rejected');
});

for (const included of [false, true]) test(`keeps a notification received during initial load without double counting (${included})`, async ({ page }) => {
  let held: Route | undefined;
  await page.route('**/api/notifications/settings', route => route.fulfill({ json: { settings: { enabled: false }, pushConfigured: false } }));
  await page.route('**/api/notifications', route => { held = route; });
  await page.goto(mount('notifications')); await expect.poll(() => !!held).toBe(true);
  await page.evaluate(item => { for (let n = 0; n < 2; n++) window.dispatchEvent(new CustomEvent('remote-notification', { detail: item })); }, notification('new'));
  await held!.fulfill({ json: { items: included ? [notification('new')] : [], unread: included ? 1 : 0 } });
  await expect(page.locator('.notification-item')).toHaveCount(1); await expect(page.locator('#unread')).toHaveText('1');
});
test('does not double count incoming notifications beyond the snapshot first page', async ({ page }) => {
  let held: Route | undefined;
  const incoming = Array.from({ length: 32 }, (_, i) => ({ ...notification('notification-' + i), sequence: i + 1 }));
  await page.route('**/api/notifications/settings', route => route.fulfill({ json: { settings: { enabled: false }, pushConfigured: false } }));
  await page.route('**/api/notifications', route => { held = route; });
  await page.goto(mount('notifications')); await expect.poll(() => !!held).toBe(true);
  await page.evaluate(items => items.forEach(detail => window.dispatchEvent(new CustomEvent('remote-notification', { detail }))), incoming);
  await held!.fulfill({ json: { items: incoming.slice(1, 31), unread: 31, throughSequence: 31, nextCursor: 'fixture' } });
  await expect(page.locator('#unread')).toHaveText('32'); await expect(page.locator('.notification-item')).toHaveCount(32);
});
test('requests a fresh ticket for each payment-button click and permits popup fallback', async ({ page }) => {
  const order = { id: '12345678-1234-4234-8234-123456789abc', deviceId: '123456789', planName: 'Monthly', priceFen: 600, days: 30, channel: 'alipay', status: 'pending', serviceStatus: '未开通', created: Date.now(), expires: Date.now() + 900000 };
  let opened = 0;
  await page.route('**/api/orders', route => route.fulfill({ json: { deviceId: order.deviceId, orders: [order], licenses: [], refunds: [], readiness: { ready: true, channels: ['alipay'] } } }));
  await page.route('**/api/subscription', route => route.fulfill({ json: { catalog: { plans: [] } } }));
  await page.route('**/api/orders/*/open', route => route.fulfill({ json: { order, payUrl: `${origin}/pay/#ticket=fixture-${++opened}` } }));
  await page.goto(mount('orders')); await page.getByTitle('打开付款', { exact: true }).click();
  await page.evaluate(() => { const urls: string[] = []; (window as any).paymentUrls = urls; window.open = () => ({ opener: null, location: { replace: (url: string) => urls.push(url) }, close() {} }) as any; });
  for (let count = 2; count <= 3; count++) { await page.getByRole('link', { name: '去支付宝支付', exact: true }).click(); await expect.poll(() => opened).toBe(count); await expect(page.getByRole('button', { name: '复制付款链接', exact: true })).toBeEnabled(); }
  expect(await page.evaluate(() => (window as any).paymentUrls)).toEqual([origin + '/pay/#ticket=fixture-2', origin + '/pay/#ticket=fixture-3']);
});

test('serializes update polls, ignores stale readiness and observes installation recovery', async ({ page }) => {
  await page.clock.install(); let calls = 0; let installs = 0; let held: Route | undefined;
  let recovered = false;
  await page.route('**/local/update/state', route => { if (++calls === 2) { held = route; return; } return route.fulfill({ json: update(installs && !recovered ? 'installing' : 'ready') }); });
  await page.route('**/local/state', route => route.fulfill({ json: { authorizedCount: 0 } }));
  await page.route('**/local/update/install', route => { installs++; return route.fulfill({ json: { accepted: true } }); });
  await page.goto(mount('update')); await expect(page.getByRole('button', { name: '安装更新', exact: true })).toBeVisible();
  await page.clock.runFor(2001); await expect.poll(() => !!held).toBe(true); await page.clock.runFor(6000); expect(calls).toBe(2);
  await page.getByRole('button', { name: '安装更新', exact: true }).click(); await page.getByRole('button', { name: '安装并重启助手', exact: true }).click();
  await expect(page.locator('.update-panel')).toContainText('正在安装并重启助手');
  await held!.fulfill({ json: update('ready') }); await page.clock.runFor(4001);
  await expect(page.getByRole('button', { name: '安装更新', exact: true })).toHaveCount(0); expect(installs).toBe(1); expect(calls).toBeGreaterThan(2);
  recovered = true; await page.clock.runFor(2001); await expect(page.getByRole('button', { name: '安装更新', exact: true })).toBeEnabled();
});

for (const kind of ['notifications', 'update']) test(`restores ${kind} checkbox after a rejected setting save`, async ({ page }) => {
  await page.route('**/api/notifications/settings', route => route.fulfill(route.request().method() === 'GET' ? { json: { settings: { enabled: true, completed: true, failed: true }, pushConfigured: false } } : { status: 409, json: { error: { message: 'setting rejected' } } }));
  await page.route('**/api/notifications', route => route.fulfill({ json: { items: [], unread: 0 } }));
  await page.route('**/local/update/state', route => route.fulfill({ json: update('idle') }));
  await page.route('**/local/state', route => route.fulfill({ json: { authorizedCount: 0 } }));
  await page.route('**/local/update/settings', route => route.fulfill({ status: 409, json: { error: { message: 'setting rejected' } } }));
  await page.goto(mount(kind)); const checkbox = page.getByRole('checkbox').first(); await expect(checkbox).toBeChecked();
  await checkbox.uncheck(); await expect(page.getByRole('alert')).toHaveText('setting rejected'); await expect(checkbox).toBeChecked();
});

test('clears recovered update read errors but retains installation errors', async ({ page }) => {
  await page.clock.install(); let healthy = false;
  await page.route('**/local/update/state', route => route.fulfill(healthy ? { json: update('ready') } : { status: 400, json: { error: { message: 'temporary read failure' } } }));
  await page.route('**/local/state', route => route.fulfill({ json: { authorizedCount: 0 } }));
  await page.route('**/local/update/install', route => route.fulfill({ status: 400, json: { error: { message: 'installation blocked' } } }));
  await page.goto(mount('update')); await expect(page.getByRole('alert')).toHaveText('temporary read failure');
  healthy = true; await page.clock.runFor(2001); await expect(page.getByRole('button', { name: '安装更新', exact: true })).toBeVisible(); await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '安装更新', exact: true }).click(); await page.getByRole('button', { name: '安装并重启助手', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('installation blocked'); await page.clock.runFor(4001); await expect(page.getByRole('alert')).toHaveText('installation blocked');
});

test('changes the feedback page only on success and disables repeated pagination', async ({ page }) => {
  let held: Route | undefined; let fail = false;
  await page.route('**/api/feedback?page=*', route => {
    const n = Number(new URL(route.request().url()).searchParams.get('page'));
    if (n === 2 && !fail) { held = route; return; }
    return route.fulfill(fail ? { status: 400, json: { error: { message: 'page offline' } } } : { json: { rows: [{ id: 'page-' + n, category: 'connection', state: 'open', updated: 1 }], total: 90 } });
  });
  await page.goto(mount('feedback')); await expect(page.locator('.feedback-list')).toContainText('page-1');
  await page.getByRole('button', { name: '下一页', exact: true }).click(); await expect.poll(() => !!held).toBe(true);
  await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled(); await expect(page.locator('footer span')).toHaveText('1');
  await held!.fulfill({ json: { rows: [{ id: 'page-2', category: 'connection', state: 'open', updated: 1 }], total: 90 } });
  await expect(page.locator('footer span')).toHaveText('2'); await expect(page.locator('.feedback-list')).toContainText('page-2');
  fail = true; await page.getByRole('button', { name: '下一页', exact: true }).click(); await expect(page.getByRole('alert')).toHaveText('page offline');
  await expect(page.locator('footer span')).toHaveText('2'); await expect(page.locator('.feedback-list')).toContainText('page-2');
});

test('formats exact cents and synchronizes trial eligibility after license activation', async ({ page }) => {
  const catalog = { salesOpen: true, termsVersion: 'fixture', plans: [{ id: 'month', name: 'Month', priceFen: 605, days: 30, available: true }] };
  await page.route('**/api/subscription', route => route.fulfill({ json: { catalog, subscription: { access: false }, trial: { available: true, used: false } } }));
  await page.route('**/api/subscription/redeem', route => route.fulfill({ json: { catalog, subscription: { access: true }, trial: { used: true, available: false } } }));
  await page.goto(mount('subscription')); await expect(page.locator('.plan-price')).toHaveText('¥6.05');
  await page.getByLabel('授权码', { exact: true }).fill('CM1_' + 'a'.repeat(32)); await page.locator('.terms-accept input').check();
  await page.getByRole('button', { name: '激活授权', exact: true }).click(); await expect(page.getByText('授权已激活', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '免费试用七天', exact: true })).toHaveCount(0);
});
