import { test, expect } from '@playwright/test';
import { mockPairedBrowser } from './paired-browser-fixture';

// Run against tests/browser-fixture.ts; all task data below is isolated browser state.
test.use({ viewport: { width: 390, height: 844 }, launchOptions: process.env.TEST_BROWSER === 'webkit' ? {} : { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } });
const origin = 'http://127.0.0.1:18890';
const active = { id: '12345678-1234-4234-8234-123456789abc', title: '正常任务', cwd: 'C:/test', updatedAt: 1, projectId: 'project-a' };
const stale = { ...active, id: '23456789-1234-4234-8234-123456789abc', title: '待移除任务' };

async function navigationFixture(page: any, unavailable = true) {
  let removed = false;
  await mockPairedBrowser(page);
  await page.routeWebSocket('**/ws/mobile*', (ws: any) => {
    ws.send(JSON.stringify({ type: 'status', online: true, enabled: true, client: { available: true, capabilities: ['project-navigation'] } }));
    ws.onMessage((data: string) => {
      const { id, command } = JSON.parse(data); let result: any;
      if (command.method === 'projects') result = { projects: [{ id: 'project-a', name: '测试项目', path: 'C:/test', count: removed ? 1 : 2 }] };
      if (command.method === 'list') result = { conversations: command.params.projectId === null ? [] : removed ? [active] : [active, stale], hasMore: false };
      if (command.method === 'read') {
        if (command.params.id === stale.id && unavailable) { removed = true; ws.send(JSON.stringify({ type: 'result', id, error: { code: 'NOT_FOUND', message: '会话不存在或已归档。' } })); return; }
        result = { id: active.id, title: active.title, epoch: 'fixture', busy: false, turnId: null, messages: [{ id: 'final', role: 'assistant', text: '正常任务的结果。' }], requests: [], hasMore: false };
      }
      ws.send(JSON.stringify({ type: 'result', id, result }));
    });
  });
  await page.goto(origin); await page.locator('.project-toggle').filter({ hasText: '测试项目' }).click();
  return () => { removed = true; };
}

test('unavailable task leaves loading state and disappears from cached navigation', async ({ page }) => {
  await navigationFixture(page);
  await page.getByRole('button', { name: stale.title, exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目与会话' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('已从列表移除');
  await expect(page.getByText('正在读取原会话')).toHaveCount(0);
  await expect(page.getByRole('button', { name: stale.title, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: active.title, exact: true }).click();
  await expect(page.getByText('正常任务的结果。')).toBeVisible();
});

test('opening the drawer refreshes tasks removed on the desktop', async ({ page }) => {
  const remove = await navigationFixture(page, false);
  await page.getByRole('button', { name: active.title, exact: true }).click();
  await expect(page.getByText('正常任务的结果。')).toBeVisible();
  remove(); await page.getByTitle('项目与会话', { exact: true }).click();
  await expect(page.getByRole('button', { name: stale.title, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: active.title, exact: true })).toBeVisible();
});

test('custom password input preserves case and surrounding spaces at narrow widths', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ status: 401, json: { error: { message: '未连接' } } }));
  let submitted: any;
  await page.route('**/api/connect', route => { submitted = route.request().postDataJSON(); return route.fulfill({ status: 400, json: { error: { message: '测试连接响应' } } }); });
  await page.goto(origin); await page.getByLabel('设备 ID', { exact: true }).fill('123 456 789');
  await page.getByLabel('验证码或自定义密码').fill(' MixedCase-pass 42! ');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('测试连接响应');
  expect(submitted).toEqual({ deviceId: '123456789', code: ' MixedCase-pass 42! ', remember: true, multiple: true });
  for (const width of [320,390,768]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('explains why the connection button is disabled for an incomplete device ID', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ status: 401, json: { error: { message: '未连接' } } }));
  await page.goto(origin);
  await page.getByLabel('设备 ID', { exact: true }).fill('52396275');
  await expect(page.getByRole('status')).toHaveText('设备 ID 需要 9 位数字，当前 8 位');
  await page.getByLabel('验证码或自定义密码').fill('aA89746625');
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeDisabled();
  await page.getByLabel('设备 ID', { exact: true }).fill('523962715');
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeEnabled();
});

test('typing a long password is not truncated at eight characters and stops at sixty-four', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ status: 401, json: { error: { message: '未连接' } } }));
  let submitted: any;
  await page.route('**/api/connect', route => { submitted = route.request().postDataJSON(); return route.fulfill({ status: 400, json: { error: { message: '长度验证完成' } } }); });
  await page.goto(origin); await page.getByLabel('设备 ID', { exact: true }).fill('123456789');
  const input = page.getByLabel('验证码或自定义密码');
  const password = 'Ab9!'.repeat(16);
  await input.pressSequentially(password.slice(0, 9)); await expect(input).toHaveValue(password.slice(0, 9));
  await input.pressSequentially(password.slice(9, 32)); await expect(input).toHaveValue(password.slice(0, 32));
  await input.pressSequentially(password.slice(32)); await expect(input).toHaveValue(password);
  await input.pressSequentially('extra'); await expect(input).toHaveValue(password);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('长度验证完成'); expect(submitted.code).toBe(password);
});

test('an old login page offers refresh without discarding entered credentials', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ status: 401, json: { error: { message: '未连接' } } }));
  let old = false;
  await page.route('**/api/web-version', route => old ? route.fulfill({ json: { entry: '/assets/index-new-release.js' } }) : route.continue());
  await page.goto(origin);
  await page.getByLabel('设备 ID', { exact: true }).fill('123456789');
  await page.getByLabel('验证码或自定义密码').pressSequentially('Long-password-42');
  old = true; await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.getByRole('button', { name: '刷新网页', exact: true })).toBeVisible();
  await expect(page.getByLabel('验证码或自定义密码')).toHaveValue('Long-password-42');
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeDisabled();
});

test('desktop settings save a fixed password and can restore automatic mode', async ({ page }) => {
  let state = { deviceId: '123456789', code: 'ABCDEFGH', passwordMode: 'automatic', enabled: true, connection: 'online', client: { available: true, version: 'fixture' }, authorizedCount: 0, url: origin };
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { mode: 'desktop' } }));
  await page.route('**/local/state', route => route.fulfill({ json: state }));
  await page.route('**/local/password', route => { const body = route.request().postDataJSON(); state = { ...state, passwordMode: body.mode, code: body.password ?? 'BCDEFGHJ' }; return route.fulfill({ json: state }); });
  await page.goto(origin); await page.getByTitle('密码设置').click();
  await page.getByRole('radio', { name: '自定义固定密码' }).check();
  await page.getByLabel('密码（8 至 64 位）', { exact: true }).fill('Fixed-password-42');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('自定义固定密码', { exact: true })).toBeVisible();
  expect(state.code).toBe('Fixed-password-42');
  await page.getByTitle('密码设置').click();
  await page.getByRole('radio', { name: '每次成功连接后自动换码（默认）' }).check();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('每次成功连接后自动换码', { exact: true })).toBeVisible();
});

test('reconciles a feedback state change when the write succeeded but its response was lost', async ({ page }) => {
  const ticketId = '287dc996-f01a-4d69-96ee-9f40e0de9127'; let state = 'open';
  const detail = () => ({ ticket: { id: ticketId, category: 'chat', state, updated: Date.now() }, messages: [{ id: 'message-1', seq: 1, actor: 'user', text: '状态按钮测试', created: Date.now(), images: [] }] });
  await mockPairedBrowser(page);
  await page.routeWebSocket('**/ws/mobile*', ws => ws.send(JSON.stringify({ type: 'status', online: true, enabled: true, client: { available: true, capabilities: [] } })));
  await page.route('**/api/feedback/unread', route => route.fulfill({ json: { count: 0 } }));
  await page.route('**/api/feedback?page=*', route => route.fulfill({ json: { rows: [{ ...detail().ticket, unread: false }], total: 1 } }));
  await page.route(`**/api/feedback/${ticketId}/state`, route => { state = route.request().postDataJSON().state; return route.fulfill({ status: 500, json: { error: { message: '请求结果待核对。' } } }); });
  await page.route(`**/api/feedback/${ticketId}/read`, route => route.fulfill({ json: { ok: true } }));
  await page.route(`**/api/feedback/${ticketId}`, route => route.fulfill({ json: detail() }));
  await page.goto(origin); await page.getByTitle('更多操作', { exact: true }).click(); await page.getByTitle('问题反馈', { exact: true }).click(); await page.getByText(ticketId, { exact: true }).click();
  await page.getByRole('button', { name: '确认解决', exact: true }).click();
  await expect(page.getByText(`${ticketId} · 已解决`, { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '重新打开', exact: true })).toBeVisible(); await expect(page.getByRole('alert')).toHaveCount(0);
});
