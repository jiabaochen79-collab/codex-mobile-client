import { expect, test, type Page } from '@playwright/test';
import { mockPairedBrowser } from './paired-browser-fixture';
test.use({ viewport: { width: 390, height: 844 }, launchOptions: process.env.TEST_BROWSER === 'webkit' ? {} : { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } });
const origin = 'http://127.0.0.1:18890';
async function fixture(page: Page, viewer = false, home = false) {
  const task = { id: '12345678-1234-4234-8234-123456789abc', title: '恢复验收任务', cwd: 'C:/fixture', updatedAt: 1 };
  const status: any = { type: 'status', online: true, enabled: true, subscription: { access: true }, control: { role: viewer ? 'viewer' : 'controller', epoch: '12345678-1234-4234-8234-123456789abd', terminals: [] }, client: { available: true, version: 'fixture', reason: null, capabilities: ['desktop-recovery', 'task-mode', 'multi-terminal', 'attachments', 'queued-send'], recovery: { autoEnabled: true, phase: 'watching', attempts: 0, reason: '异常退出时将自动恢复' } } };
  const snapshot = { ...task, epoch: 'fixture', turnId: null, busy: false, messages: [{ id: 'fixture', role: 'assistant', phase: 'final', text: '原任务结果仍在' }], requests: [], hasMore: false, settings: { model: 'fixture', effort: 'high', mode: 'default', revision: 'fixture' } };
  const commands: any[] = []; let update!: () => void, disconnect!: () => void, settle!: () => void; let delay = false, reject = false;
  await mockPairedBrowser(page); await page.route('**/api/bootstrap', route => route.fulfill({ json: { mode: 'mobile' } })); await page.route('**/api/notifications', route => route.fulfill({ json: { items: [], unread: 0 } }));
  await page.routeWebSocket('**/ws/mobile*', socket => {
    update = () => socket.send(JSON.stringify(status)); disconnect = () => socket.close(); update();
    socket.onMessage(raw => {
      const { id, command } = JSON.parse(String(raw)); if (!command) return; commands.push(command);
      const reply = () => {
        if (command.method === 'client.recover') {
          if (reject) { socket.send(JSON.stringify({ type: 'result', id, error: { code: 'AUTH', message: '授权已变化' } })); return; }
          status.client.recovery = { ...status.client.recovery, autoEnabled: command.params.action === 'pause' ? false : true, phase: command.params.action === 'launch' ? 'connecting' : command.params.action === 'pause' ? 'paused' : 'watching', reason: command.params.action === 'launch' ? '正在等待客户端连接' : '自动恢复设置已同步' };
        }
        if (command.method === 'control.claim') { status.control.role = 'controller'; update(); }
        const result = command.method === 'list' ? { conversations: [task], hasMore: false } : command.method === 'read' ? snapshot : command.method === 'client.recover' ? status.client.recovery : { accepted: true };
        socket.send(JSON.stringify({ type: 'result', id, result }));
      };
      if (command.method === 'client.recover' && delay) settle = reply; else reply();
    });
  });
  await page.goto(origin); if (!home) await page.getByRole('button', { name: task.title, exact: true }).click();
  return { status, commands, update: () => update(), disconnect: () => disconnect(), settle: () => settle(), delay: () => delay = true, reject: () => reject = true };
}
async function open(page: Page) { await page.getByTitle('更多操作', { exact: true }).click(); await page.locator('.chat-menu').getByRole('button', { name: '客户端恢复', exact: true }).click(); }
test('recovers an unavailable client once, keeping task and draft without send or stop', async ({ page }) => {
  const f = await fixture(page); await page.getByLabel('消息', { exact: true }).fill('恢复后核对的草稿');
  f.status.client.available = false; f.update(); await open(page); f.delay();
  const launch = page.getByRole('button', { name: '恢复电脑客户端', exact: true }); await launch.click(); await expect(launch).toBeDisabled();
  expect(f.commands.filter(c => c.method === 'client.recover')).toHaveLength(1); f.settle(); await expect(page.getByRole('dialog', { name: '客户端恢复' })).toContainText('正在等待客户端连接');
  f.status.client.available = true; f.status.client.recovery.phase = 'recovered'; f.status.client.recovery.reason = '客户端连接已恢复'; f.update(); await page.getByTitle('关闭客户端恢复').click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('恢复后核对的草稿'); await expect(page.locator('.chat-heading h1')).toHaveText('恢复验收任务');
  expect(f.commands.some(c => ['send', 'stop', 'queue.resume'].includes(c.method))).toBe(false);
});
test('can claim control while Codex is unavailable, before recovering', async ({ page }) => {
  const f = await fixture(page, true); f.status.client.available = false; f.update(); await open(page);
  await expect(page.getByRole('button', { name: '恢复电脑客户端' })).toBeDisabled(); await page.getByRole('button', { name: '接管控制权', exact: true }).click();
  await page.getByRole('button', { name: '确认接管', exact: true }).click(); await open(page); await expect(page.getByRole('button', { name: '恢复电脑客户端' })).toBeEnabled();
  expect(f.commands.filter(c => c.method === 'control.claim')).toHaveLength(1);
});
for (const variant of ['legacy', 'offline', 'expired', 'disabled'] as const) test('keeps entry and explains ' + variant, async ({ page }) => {
  const f = await fixture(page); if (variant === 'legacy') { f.status.client.capabilities = []; delete f.status.client.recovery; } if (variant === 'offline') f.status.online = false; if (variant === 'expired') f.status.subscription.access = false; if (variant === 'disabled') f.status.enabled = false;
  f.update(); await open(page); await expect(page.getByRole('button', { name: '恢复电脑客户端' })).toBeDisabled();
  await expect(page.getByRole('dialog', { name: '客户端恢复' })).toContainText({ legacy: '升级电脑助手', offline: '未连接', expired: '已到期', disabled: '关闭远程控制' }[variant]); expect(f.commands.some(c => c.method === 'client.recover')).toBe(false);
});
test('treats disconnect as uncertain, follows new status and never replays the recovery command', async ({ page }) => {
  const f = await fixture(page); f.delay(); await open(page); await page.getByRole('button', { name: '恢复电脑客户端' }).click(); f.disconnect();
  f.status.client.recovery = { autoEnabled: true, phase: 'recovered', attempts: 1, reason: '客户端连接已恢复' };
  await expect(page.getByRole('dialog', { name: '客户端恢复' })).toContainText('客户端连接已恢复', { timeout: 10000 }); expect(f.commands.filter(c => c.method === 'client.recover')).toHaveLength(1);
});
test('clears an uncertain timeout only when the desktop confirms the recovery outcome', async ({ page }) => {
  await page.clock.install(); const f = await fixture(page); f.delay(); await open(page); await page.getByRole('button', { name: '恢复电脑客户端' }).click();
  await page.clock.fastForward(26000); const dialog = page.getByRole('dialog', { name: '客户端恢复' }); await expect(dialog).toContainText('恢复操作结果待核对');
  f.update(); await expect(dialog).toContainText('恢复操作结果待核对');
  f.status.client.recovery = { autoEnabled: true, phase: 'recovered', attempts: 1, recoveredAt: Date.now(), reason: '客户端连接已恢复' }; f.update();
  await expect(dialog.getByRole('alert')).toHaveCount(0); expect(f.commands.filter(c => c.method === 'client.recover')).toHaveLength(1);
});
test('fits at 320/390 pixels and keyboard height, and does not dismiss on backdrop', async ({ page }, info) => {
  await fixture(page); await open(page);
  for (const [width, height] of [[320, 568], [390, 844], [390, 360]]) {
    await page.setViewportSize({ width, height }); const dialog = page.getByRole('dialog', { name: '客户端恢复' }); await expect(dialog).toBeVisible();
    await expect.poll(async () => { const box = (await dialog.boundingBox())!; return box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= height; }).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: info.outputPath(`recovery-${width}-${height}.png`) });
  }
  await page.locator('.modal-backdrop').click({ position: { x: 2, y: 2 } }); await expect(page.getByRole('dialog', { name: '客户端恢复' })).toBeVisible();
});
test('offers recovery on the home menu and handles rejection without automatic retry', async ({ page }) => {
  const f = await fixture(page, false, true); f.reject(); await open(page); await page.getByRole('button', { name: '恢复电脑客户端' }).click();
  await expect(page.getByRole('dialog', { name: '客户端恢复' })).toContainText('授权已变化'); expect(f.commands.filter(c => c.method === 'client.recover')).toHaveLength(1);
});
test('uses the Windows local recovery panel without replacing its device state', async ({ page }) => {
  let count = 0; const state: any = { deviceId: '123456789', code: 'ABCDEFGH', enabled: true, connection: 'online', client: { available: false, version: 'fixture', recovery: { autoEnabled: true, phase: 'idle', attempts: 0, reason: '电脑客户端未运行，可手动恢复' } }, url: 'https://example.invalid' };
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { mode: 'desktop' } })); await page.route('**/local/state', route => route.fulfill({ json: state }));
  await page.route('**/local/client/recovery', route => { count++; state.client.recovery = { ...state.client.recovery, phase: 'connecting', reason: '正在重新连接' }; return route.fulfill({ json: state.client.recovery }); });
  await page.goto(origin + '/?panel=recovery'); await page.getByRole('button', { name: '恢复电脑客户端' }).click();
  await expect(page.getByRole('dialog', { name: '客户端恢复' })).toContainText('正在重新连接'); await expect(page.locator('.credential-value').first()).toContainText('123 456 789'); expect(count).toBe(1);
});
