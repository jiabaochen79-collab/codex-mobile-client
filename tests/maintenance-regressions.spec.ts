import { expect, test, type Route } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const mount = (kind: string) => 'http://127.0.0.1:18890/@fs/' + fileURLToPath(new URL('./component-harness.html', import.meta.url)).replaceAll('\\', '/') + '?component=' + kind;
const notification = (id: string) => ({ id, deviceId: '123456789', taskId: id, turnId: id, status: 'completed', occurredAt: Date.now(), createdAt: Date.now(), readAt: null, delivery: 'accepted' });
const update = (phase: string) => ({ phase, progress: 100, version: '0.4.28', autoDownload: true });

for (const included of [false, true]) test(`keeps a notification received during initial load without double counting (${included})`, async ({ page }) => {
  let held: Route | undefined;
  await page.route('**/api/notifications/settings', route => route.fulfill({ json: { settings: { enabled: false }, pushConfigured: false } }));
  await page.route('**/api/notifications', route => { held = route; });
  await page.goto(mount('notifications')); await expect.poll(() => !!held).toBe(true);
  await page.evaluate(item => { for (let n = 0; n < 2; n++) window.dispatchEvent(new CustomEvent('remote-notification', { detail: item })); }, notification('new'));
  await held!.fulfill({ json: { items: included ? [notification('new')] : [], unread: included ? 1 : 0 } });
  await expect(page.locator('.notification-item')).toHaveCount(1); await expect(page.locator('#unread')).toHaveText('1');
});

test('serializes update polls and ignores stale readiness after installation', async ({ page }) => {
  await page.clock.install(); let calls = 0; let installs = 0; let held: Route | undefined;
  await page.route('**/local/update/state', route => { if (++calls === 2) { held = route; return; } return route.fulfill({ json: update('ready') }); });
  await page.route('**/local/state', route => route.fulfill({ json: { authorizedCount: 0 } }));
  await page.route('**/local/update/install', route => { installs++; return route.fulfill({ json: { accepted: true } }); });
  await page.goto(mount('update')); await expect(page.getByRole('button', { name: '安装更新', exact: true })).toBeVisible();
  await page.clock.runFor(2001); await expect.poll(() => !!held).toBe(true); await page.clock.runFor(6000); expect(calls).toBe(2);
  await page.getByRole('button', { name: '安装更新', exact: true }).click(); await page.getByRole('button', { name: '安装并重启助手', exact: true }).click();
  await expect(page.locator('.update-panel')).toContainText('正在安装并重启助手');
  await held!.fulfill({ json: update('ready') }); await page.clock.runFor(4001);
  await expect(page.getByRole('button', { name: '安装更新', exact: true })).toHaveCount(0); expect(installs).toBe(1); expect(calls).toBe(2);
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
