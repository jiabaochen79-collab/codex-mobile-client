import { expect, test, type Page } from '@playwright/test';
import { mockPairedBrowser } from './paired-browser-fixture';

const webkit = process.env.TEST_BROWSER === 'webkit';
test.use({ browserName: webkit ? 'webkit' : 'chromium', viewport: { width: 390, height: 844 }, launchOptions: webkit ? {} : { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } });
const origin = process.env.PLAN_WEB_ORIGIN ?? 'http://127.0.0.1:18890';
const add = (page: Page) => page.getByTitle('添加照片、文件或计划模式', { exact: true });
const planOption = (page: Page) => page.getByRole('menuitemcheckbox', { name: /计划模式/ });
const closePlan = (page: Page) => page.getByRole('button', { name: '关闭计划模式', exact: true });
const permissionTrigger = (page: Page) => page.locator('.permission-status');
const permissionOption = (page: Page, name: string) => page.getByRole('radio').filter({ has: page.getByText(name, { exact: true }) });
async function fixture(page: Page, options: { viewer?: boolean; legacy?: boolean; busy?: boolean; reject?: boolean; delayed?: boolean; mode?: 'plan'|'default'; unsynced?: boolean; permission?: 'ask'|'approve'|'full'|'custom'; permissionUnsynced?: boolean; secondTask?: boolean; inputRequest?: boolean; failedReason?: string | null } = {}) {
  const conversation = { id: '12345678-1234-4234-8234-123456789abc', title: '计划模式验收', cwd: 'C:/fixture', updatedAt: 1 };
  const plan = { id: 'implement-plan:turn-plan', kind: 'plan', title: '实施此计划？', detail: '# 更新计划\n\n1. 保留已有数据。\n2. 验证结果。\n\n<script>alert(1)</script>', plan: { turnId: 'turn-plan', revision: 'a'.repeat(64) } };
  const inputRequest = { id: 'input-request', kind: 'input', title: '需要你的回复', detail: '', questions: [
    { id: 'scope', question: '修改范围', options: [{ label: '仅界面' }, { label: '界面和文档' }] },
    { id: 'approach', question: '处理方式', options: [{ label: '保守调整' }, { label: '完整重做' }] },
    { id: 'note', question: '补充要求', options: [] }
  ] };
  const snapshot: any = { ...conversation, epoch: 'fixture', busy: !!options.busy, turnId: options.busy ? 'running' : null, hasMore: false, requests: options.busy || options.failedReason !== undefined ? [] : options.inputRequest ? [inputRequest] : [plan], nativeQueuedCount: 0,
    messages: options.failedReason !== undefined ? [{ id: 'failed-message', role: 'user', text: '继续', turnId: 'turn-failed', turnStatus: 'failed', ...(options.failedReason ? { turnReason: options.failedReason } : {}) }] : [{ id: 'plan-message', role: 'assistant', phase: 'final', text: plan.detail, turnId: 'turn-plan', turnStatus: 'completed' }],
    settings: { model: 'fixture-model', effort: 'high', mode: options.unsynced ? undefined : options.mode ?? 'plan', revision: 'settings-1', ...(options.permissionUnsynced ? {} : { permission: options.permission ?? 'ask' }) } };
  const second = { ...conversation, id: '12345678-1234-4234-8234-123456789abe', title: '另一任务' };
  const secondSnapshot = { ...snapshot, ...second, requests: [], settings: { ...snapshot.settings, mode: 'default', permission: 'full', revision: 'other-settings' } };
  const status: any = { type: 'status', online: true, enabled: true, helperVersion: options.legacy ? undefined : '0.4.4', subscription: { access: true },
    control: { role: options.viewer ? 'viewer' : 'controller', epoch: '12345678-1234-4234-8234-123456789abd', terminals: [] },
    client: { available: true, version: '26.903.61454', capabilities: options.legacy ? [] : ['task-mode', 'plan-implementation', 'model-settings', 'permission-settings', 'safety-status', 'queued-send', 'attachments'] } };
  const commands: any[] = []; let update!: () => void; let statusUpdate!: () => void; let disconnect!: () => void; let settle!: () => void;
  const reads: (() => void)[] = []; let holdReads = false; let readFailure = '';
  await mockPairedBrowser(page);
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { mode: 'mobile' } }));
  await page.route('**/api/notifications', route => route.fulfill({ json: { items: [], unread: 0 } }));
  await page.routeWebSocket('**/ws/mobile*', socket => {
    update = () => socket.send(JSON.stringify({ type: 'changed', conversationIds: [conversation.id] }));
    statusUpdate = () => socket.send(JSON.stringify(status));
    disconnect = () => socket.close();
    statusUpdate();
    socket.onMessage(raw => {
      const { id, command } = JSON.parse(String(raw)); commands.push(command);
      const reply = () => {
        if (command.method === 'read' && readFailure) { socket.send(JSON.stringify({ type: 'result', id, error: { code: 'CLIENT_UNAVAILABLE', message: readFailure } })); return; }
        if (command.method === 'mode.update' && !options.reject) { snapshot.settings.mode = command.params.mode; snapshot.settings.revision = 'settings-2'; }
        if (command.method === 'permissions.update' && !options.reject) { snapshot.settings.permission = command.params.permission; snapshot.settings.revision = 'permission-settings-2'; }
        if (command.method === 'plan.respond' && !options.reject) { snapshot.requests = []; snapshot.busy = true; snapshot.turnId = 'next-turn'; snapshot.settings.mode = command.params.action === 'implement' ? 'default' : 'plan'; }
        if (command.method === 'respond' && !options.reject) snapshot.requests = [];
        if (command.method === 'settings.update' && !options.reject) { snapshot.settings.model = command.params.model; snapshot.settings.revision = 'model-settings-2'; }
        const result = command.method === 'list' ? { conversations: options.secondTask ? [conversation, second] : [conversation], hasMore: false } : command.method === 'read' || command.method === 'safety.status' ? command.params.id === second.id ? secondSnapshot : snapshot : command.method === 'models' ? { models: [{ id: 'fixture-model', name: 'Fixture', efforts: ['high'], defaultEffort: 'high' }, { id: 'other-model', name: 'Other', efforts: ['high'], defaultEffort: 'high' }] } : command.method === 'settings.update' ? { settings: snapshot.settings } : { accepted: true };
        if (options.reject && ['respond', 'plan.respond', 'mode.update', 'permissions.update', 'settings.update'].includes(command.method)) socket.send(JSON.stringify({ type: 'result', id, error: { code: 'STALE', message: '计划或设置已变化，请刷新后核对。' } }));
        else socket.send(JSON.stringify({ type: 'result', id, result }));
      };
      if (options.delayed && ['mode.update', 'settings.update'].includes(command.method)) settle = reply;
      else if (command.method === 'read' && holdReads) reads.push(reply);
      else reply();
    });
  });
  await page.goto(origin);
  await page.getByRole('button', { name: conversation.title, exact: true }).click(); await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
  await expect.poll(() => commands.filter(c => c.method === 'read').length).toBeGreaterThan(0);
  return { snapshot, status, commands, update: () => update(), statusUpdate: () => statusUpdate(), disconnect: () => disconnect(), settle: () => settle(),
    failReads: (message: string) => { readFailure = message; },
    holdReads: () => { holdReads = true; }, releaseReads: () => { holdReads = false; reads.splice(0).forEach(reply => reply()); } };
}

test('clears a recovered read error without losing the draft or allowing stale sends', async ({ page }) => {
  const f = await fixture(page, { mode: 'default' });
  await page.getByLabel('消息', { exact: true }).fill('弱网草稿');
  f.failReads('请先在电脑端打开此任务。'); f.update();
  await expect(page.locator('.chat-status')).toContainText('正在同步会话');
  await expect(page.getByTitle('发送消息', { exact: true })).toBeDisabled();
  f.failReads(''); f.update();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTitle('发送消息', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('弱网草稿');
});
test('isolates answers and field IDs between requests with the same question ID', async ({ page }) => {
  const f = await fixture(page, { inputRequest: true });
  f.snapshot.requests = ['first', 'second'].map(id => ({ id, kind: 'input', title: id, detail: '', questions: [{ id: 'choice', question: id + ' question', options: [{ label: id + ' answer' }] }] })); f.update();
  await expect(page.locator('.questions')).toHaveCount(2);
  await page.getByLabel('first question', { exact: true }).selectOption('0');
  await expect(page.locator('.questions').nth(0).getByRole('button', { name: '提交', exact: true })).toBeEnabled();
  await expect(page.locator('.questions').nth(1).getByRole('button', { name: '提交', exact: true })).toBeDisabled();
  const ids = await page.locator('.questions select').evaluateAll(fields => fields.map(field => field.id)); expect(new Set(ids).size).toBe(2);
  await page.getByLabel('second question', { exact: true }).selectOption('custom'); await page.getByLabel('second question：其他', { exact: true }).fill('second custom');
  await page.locator('.questions').nth(1).getByRole('button', { name: '提交', exact: true }).click();
  await expect.poll(() => f.commands.filter(command => command.method === 'respond').length).toBe(1);
  expect(f.commands.find(command => command.method === 'respond').params).toMatchObject({ requestId: 'second', answers: { choice: ['second custom'] } });
});
test('closes task-bound model and permission dialogs when a notification opens another task', async ({ page }) => {
  const f = await fixture(page, { mode: 'default', secondTask: true });
  const notification = '12345678-1234-4234-8234-123456789abf'; const second = '12345678-1234-4234-8234-123456789abe';
  await page.route('**/api/notifications/' + notification, route => route.fulfill({ json: { item: { id: notification, taskId: second, readAt: 1 } } }));
  await page.locator('.model-trigger').click(); await page.getByLabel('模型', { exact: true }).selectOption('other-model');
  await page.evaluate(url => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'notification.open', url } })), origin + '/?notification=' + notification + '&notificationDevice=123456789');
  await expect(page.getByRole('heading', { name: '另一任务', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '模型与思考深度', exact: true })).toHaveCount(0);
  expect(f.commands.filter(c => c.method === 'settings.update')).toEqual([]);
  await permissionTrigger(page).click(); await expect(page.getByRole('dialog', { name: '任务权限', exact: true })).toBeVisible();
  await page.route('**/api/notifications/' + notification, route => route.fulfill({ json: { item: { id: notification, taskId: f.snapshot.id, readAt: 1 } } }));
  await page.evaluate(url => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'notification.open', url } })), origin + '/?notification=' + notification + '&notificationDevice=123456789');
  await expect(page.getByRole('heading', { name: f.snapshot.title, exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '任务权限', exact: true })).toHaveCount(0);
});

test('does not erase a rejected operation when reading and reconnecting succeed', async ({ page }) => {
  const f = await fixture(page, { reject: true, mode: 'default' });
  await add(page).click(); await planOption(page).click();
  await expect(page.getByRole('alert')).toContainText('计划或设置已变化');
  f.update(); await page.waitForTimeout(500); await expect(page.getByRole('alert')).toContainText('计划或设置已变化');
  f.disconnect(); await expect(closePlan(page)).toBeHidden();
  await expect(page.getByRole('alert')).toContainText('计划或设置已变化');
  await expect(add(page)).toBeEnabled();
});
test('shows the desktop failure reason and an honest fallback on mobile', async ({ page }) => {
  const f = await fixture(page, { failedReason: '模型服务暂时不可用' });
  await expect(page.locator('.turn-outcome')).toHaveText('任务未完成：模型服务暂时不可用');
  delete f.snapshot.messages[0].turnReason;
  f.update();
  await expect(page.locator('.turn-outcome')).toHaveText('任务未完成：暂未获取到具体原因，请在电脑端查看。');
  f.snapshot.messages[0].turnReason = '<img src=x onerror=alert(1)>';
  f.update();
  await expect(page.locator('.turn-outcome')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('.turn-outcome img')).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 568 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('shows a sanitized complete plan and implements only after an explicit click', async ({ page }) => {
  const { commands } = await fixture(page);
  await expect(page.getByText('此请求尚未支持远程处理。', { exact: true })).toBeHidden();
  await page.locator('.plan-request summary').click(); await expect(page.locator('.plan-request').getByRole('heading', { name: '更新计划' })).toBeVisible(); expect(await page.locator('.plan-request script').count()).toBe(0);
  expect(commands.some(c => c.method === 'plan.respond')).toBe(false);
  await page.getByRole('button', { name: '实施计划', exact: true }).click();
  await expect(page.getByRole('button', { name: '实施计划', exact: true })).toBeHidden();
  expect(commands.filter(c => c.method === 'plan.respond')).toEqual([{ method: 'plan.respond', params: { id: '12345678-1234-4234-8234-123456789abc', requestId: 'implement-plan:turn-plan', epoch: 'fixture', revision: 'a'.repeat(64), action: 'implement' } }]);
  await expect(closePlan(page)).toBeHidden();
});
test('submits plan feedback separately and preserves the ordinary message draft', async ({ page }) => {
  const { commands } = await fixture(page); await page.getByLabel('消息', { exact: true }).fill('另一条消息草稿');
  await page.getByRole('button', { name: '提出修改', exact: true }).click(); await expect(page.getByRole('button', { name: '提交修改', exact: true })).toBeDisabled();
  await page.getByLabel('修改意见', { exact: true }).fill('只修改界面，不改数据。'); await page.getByRole('button', { name: '提交修改', exact: true }).click();
  await expect(page.getByLabel('修改意见', { exact: true })).toBeHidden();
  expect(commands.find(c => c.method === 'plan.respond')?.params).toMatchObject({ action: 'revise', feedback: '只修改界面，不改数据。' });
  expect(commands.some(c => c.method === 'send' || c.method === 'stop' || c.method === 'respond')).toBe(false);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('另一条消息草稿'); await expect(closePlan(page)).toBeVisible();
});
test('allows a manual answer when none of the suggested plan options fit', async ({ page }) => {
  const { commands } = await fixture(page, { inputRequest: true }); const submit = page.getByRole('button', { name: '提交', exact: true });
  await expect(submit).toBeDisabled(); await page.getByLabel('修改范围', { exact: true }).selectOption('0');
  await page.getByLabel('处理方式', { exact: true }).selectOption('custom');
  const custom = page.getByLabel('处理方式：其他', { exact: true }); await expect(custom).toBeFocused(); await custom.fill('只调整交互，不改已有数据');
  await page.getByLabel('补充要求', { exact: true }).fill('完成后保留当前草稿'); await expect(submit).toBeEnabled(); await submit.click();
  expect(commands.find(command => command.method === 'respond')?.params.answers).toEqual({ scope: ['仅界面'], approach: ['只调整交互，不改已有数据'], note: ['完成后保留当前草稿'] });
});

test('preserves selected and manual clarification answers after a rejected submission', async ({ page }) => {
  const f = await fixture(page, { inputRequest: true, reject: true });
  await page.getByLabel('修改范围', { exact: true }).selectOption('0');
  await page.getByLabel('处理方式', { exact: true }).selectOption('custom');
  await page.getByLabel('处理方式：其他', { exact: true }).fill('Keep this manual answer');
  await page.getByLabel('补充要求', { exact: true }).fill('Keep this note');
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('计划或设置已变化');
  await expect(page.getByLabel('修改范围', { exact: true })).toHaveValue('0');
  await expect(page.getByLabel('处理方式：其他', { exact: true })).toHaveValue('Keep this manual answer');
  await expect(page.getByLabel('补充要求', { exact: true })).toHaveValue('Keep this note');
  expect(f.commands.filter(command => command.method === 'respond')).toHaveLength(1);
});

test('blocks sends after a model change timeout until a fresh snapshot confirms the actual model', async ({ page }) => {
  await page.clock.install(); const f = await fixture(page, { mode: 'default', delayed: true });
  await page.getByLabel('消息', { exact: true }).fill('Model confirmation draft');
  await page.locator('.model-trigger').click(); await page.getByLabel('模型', { exact: true }).selectOption('other-model');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => f.commands.filter(c => c.method === 'settings.update').length).toBe(1);
  f.snapshot.settings.model = 'other-model'; f.holdReads(); await page.clock.fastForward(26000);
  await expect(page.getByRole('alert')).toContainText('未收到操作确认');
  await expect(page.getByTitle('发送消息', { exact: true })).toBeDisabled();
  f.releaseReads(); await expect(page.locator('.model-trigger')).toContainText('other-model');
  await expect(page.getByTitle('发送消息', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('Model confirmation draft');
  expect(f.commands.filter(c => c.method === 'settings.update')).toHaveLength(1);
  expect(f.commands.some(c => c.method === 'send' || c.method === 'stop')).toBe(false);
});

test('automatically clears a recovered snapshot timeout without a changed event or manual refresh', async ({ page }) => {
  await page.clock.install(); const f = await fixture(page, { mode: 'default' });
  await page.getByLabel('消息', { exact: true }).fill('Recovered connection draft');
  f.failReads('会话暂时不可读取，请稍后重试。'); f.update();
  await expect(page.locator('.chat-status')).toContainText('正在同步会话');
  f.failReads(''); await page.clock.runFor(11000);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTitle('发送消息', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('Recovered connection draft');
  expect(f.commands.some(c => c.method === 'send' || c.method === 'stop')).toBe(false);
});
test('enables from plus in one tap and closes from the chip without interrupting execution', async ({ page }) => {
  const { commands } = await fixture(page, { busy: true, mode: 'default' }); await page.getByLabel('消息', { exact: true }).fill('执行时的草稿');
  await expect(page.locator('.task-mode-trigger')).toHaveCount(0); await expect(closePlan(page)).toBeHidden();
  await add(page).click(); await expect(planOption(page)).toHaveAttribute('aria-checked', 'false'); await planOption(page).click();
  await expect(page.getByRole('dialog', { name: '添加内容', exact: true })).toBeHidden(); await expect(closePlan(page)).toBeEnabled();
  await add(page).click(); await expect(planOption(page)).toHaveAttribute('aria-checked', 'true'); await planOption(page).click();
  expect(commands.filter(c => c.method === 'mode.update')).toHaveLength(1);
  await closePlan(page).click(); await expect(closePlan(page)).toBeHidden();
  expect(commands.filter(c => !['read', 'list'].includes(c.method))).toEqual([
    { method: 'mode.update', params: { id: '12345678-1234-4234-8234-123456789abc', epoch: 'fixture', revision: 'settings-1', mode: 'plan' } },
    { method: 'mode.update', params: { id: '12345678-1234-4234-8234-123456789abc', epoch: 'fixture', revision: 'settings-2', mode: 'default' } }
  ]);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('执行时的草稿');
});
test('switches approval handling for subsequent messages without stopping the active task or losing the draft', async ({ page }) => {
  const f = await fixture(page, { busy: true, mode: 'default', permission: 'ask' }); await page.getByLabel('消息', { exact: true }).fill('运行中的权限草稿');
  await permissionTrigger(page).click(); await expect(permissionOption(page, '请求批准')).toHaveAttribute('aria-checked', 'true');
  await permissionOption(page, '帮我批准').click(); await expect(permissionTrigger(page)).toHaveAttribute('aria-label', '任务权限：帮我批准');
  await expect(permissionTrigger(page)).toHaveClass(/approve/);
  expect(f.commands.filter(c => c.method === 'permissions.update')).toEqual([{ method: 'permissions.update', params: { id: '12345678-1234-4234-8234-123456789abc', epoch: 'fixture', revision: 'settings-1', permission: 'approve' } }]);
  expect(f.commands.some(c => c.method === 'stop')).toBe(false); await expect(page.getByLabel('消息', { exact: true })).toHaveValue('运行中的权限草稿');
});
test('keeps permission out of the composer and exposes a top status and menu entry', async ({ page }) => {
  await fixture(page);
  await expect(page.locator('.composer-field .permission-button')).toHaveCount(0);
  await expect(permissionTrigger(page)).toHaveAttribute('aria-label', '任务权限：请求批准');
  await expect(permissionTrigger(page).locator('svg')).toHaveCount(1);
  await page.getByTitle('更多操作', { exact: true }).click();
  await expect(page.locator('.permission-menu-item')).toContainText('请求批准');
  await page.locator('.permission-menu-item').click();
  await expect(page.getByRole('dialog', { name: '任务权限', exact: true })).toBeVisible();
});
test('requires a separate confirmation before enabling full access', async ({ page }) => {
  const f = await fixture(page, { permission: 'ask' });
  await permissionTrigger(page).click(); await permissionOption(page, '完全访问权限').click();
  await expect(page.getByRole('alertdialog', { name: '启用完全访问权限？', exact: true })).toBeVisible(); expect(f.commands.some(c => c.method === 'permissions.update')).toBe(false);
  await page.getByRole('button', { name: '取消', exact: true }).click(); expect(f.commands.some(c => c.method === 'permissions.update')).toBe(false);
  await permissionTrigger(page).click(); await permissionOption(page, '完全访问权限').click(); await page.getByRole('button', { name: '确认启用', exact: true }).click();
  await expect(permissionTrigger(page)).toHaveAttribute('aria-label', '任务权限：完全访问');
  await expect(permissionTrigger(page)).toHaveClass(/full/);
  expect(f.commands.filter(c => c.method === 'permissions.update')).toHaveLength(1); expect(f.commands.find(c => c.method === 'permissions.update')?.params.permission).toBe('full');
});
test('reconciles a rejected permission update without retrying it', async ({ page }) => {
  const f = await fixture(page, { permission: 'ask', reject: true }); await page.getByLabel('消息', { exact: true }).fill('保留权限草稿');
  await permissionTrigger(page).click(); await permissionOption(page, '帮我批准').click();
  await expect(page.getByRole('alert')).toContainText('计划或设置已变化'); await expect(permissionTrigger(page)).toHaveAttribute('aria-label', '任务权限：请求批准');
  expect(f.commands.filter(c => c.method === 'permissions.update')).toHaveLength(1); await expect(page.getByLabel('消息', { exact: true })).toHaveValue('保留权限草稿');
});
test('refreshes changes made on the desktop and uses the latest settings revision', async ({ page }) => {
  const { snapshot, update, commands } = await fixture(page, { reject: true });
  await add(page).click(); snapshot.settings.mode = 'default'; snapshot.settings.revision = 'new-desktop-setting'; update();
  await expect(planOption(page)).toHaveAttribute('aria-checked', 'false'); await planOption(page).click();
  await expect(page.getByRole('alert')).toContainText('计划或设置已变化'); expect(commands.find(c => c.method === 'mode.update')?.params.revision).toBe('new-desktop-setting');
  await expect(closePlan(page)).toBeHidden(); expect(commands.filter(c => c.method === 'mode.update')).toHaveLength(1);
});
test('blocks repeat toggles and sends until a fresh snapshot confirms the outcome', async ({ page }) => {
  const f = await fixture(page, { delayed: true, mode: 'default' }); await page.getByLabel('消息', { exact: true }).fill('保留草稿');
  await add(page).click(); await planOption(page).click();
  await expect(page.getByTitle('发送消息', { exact: true })).toBeDisabled(); await expect(closePlan(page)).toBeHidden();
  await add(page).click(); await expect(planOption(page)).toBeDisabled(); await expect(planOption(page)).toContainText('正在切换');
  f.holdReads(); f.settle(); await page.getByTitle('关闭添加内容', { exact: true }).click();
  await expect.poll(() => f.commands.filter(c => c.method === 'read').length).toBeGreaterThan(1);
  await expect(page.getByTitle('发送消息', { exact: true })).toBeDisabled(); await expect(closePlan(page)).toBeHidden();
  f.releaseReads(); await expect(closePlan(page)).toBeEnabled(); await expect(page.getByTitle('发送消息', { exact: true })).toBeEnabled();
  expect(f.commands.filter(c => c.method === 'mode.update')).toHaveLength(1); await expect(page.getByLabel('消息', { exact: true })).toHaveValue('保留草稿');
});
test('resynchronizes after timeout without resubmitting or losing the draft', async ({ page }) => {
  await page.clock.install(); const f = await fixture(page, { delayed: true, mode: 'default' });
  await page.getByLabel('消息', { exact: true }).fill('超时草稿'); await add(page).click(); await planOption(page).click();
  f.snapshot.settings.mode = 'plan'; await page.clock.fastForward(26000);
  await expect(page.getByRole('alert')).toContainText('未收到操作确认'); await expect(closePlan(page)).toBeEnabled();
  expect(f.commands.filter(c => c.method === 'mode.update')).toHaveLength(1); await expect(page.getByLabel('消息', { exact: true })).toHaveValue('超时草稿');
});
test('keeps plan implementation disabled until a mode-close snapshot is confirmed', async ({ page }) => {
  const f = await fixture(page, { delayed: true }); await closePlan(page).click(); f.holdReads(); f.settle();
  await expect.poll(() => f.commands.filter(c => c.method === 'read').length).toBeGreaterThan(1);
  await expect(page.getByRole('button', { name: '实施计划', exact: true })).toBeDisabled();
  f.releaseReads(); await expect(closePlan(page)).toBeHidden(); expect(f.commands.some(c => c.method === 'plan.respond')).toBe(false);
});
test('keeps paused queue resume disabled while reconciling the mode outcome', async ({ page }) => {
  const f = await fixture(page, { delayed: true, mode: 'default' });
  f.snapshot.queued = [{ id: '12345678-1234-4234-8234-123456789abf', text: '排队草稿', state: 'paused', reason: null, attachments: [], created: 1 }]; f.update();
  await expect(page.getByTitle('继续发送此消息', { exact: true })).toBeEnabled(); await add(page).click(); await planOption(page).click(); f.holdReads(); f.settle();
  await expect.poll(() => f.commands.filter(c => c.method === 'read').length).toBeGreaterThan(2); await expect(page.getByTitle('继续发送此消息', { exact: true })).toBeDisabled();
  f.releaseReads(); await expect(page.getByTitle('继续发送此消息', { exact: true })).toBeEnabled(); expect(f.commands.some(c => c.method === 'queue.resume')).toBe(false);
});
test('resynchronizes a disconnected pending toggle and reloads the confirmed mode', async ({ page }) => {
  const f = await fixture(page, { delayed: true, mode: 'default' }); await add(page).click(); await planOption(page).click();
  f.snapshot.settings.mode = 'plan'; f.disconnect();
  await expect(closePlan(page)).toBeEnabled({ timeout: 10000 }); expect(f.commands.filter(c => c.method === 'mode.update')).toHaveLength(1);
  await page.reload(); await page.getByRole('button', { name: '计划模式验收', exact: true }).click(); await expect(closePlan(page)).toBeEnabled();
});
test('keeps rejected feedback for review and never automatically retries', async ({ page }) => {
  const { commands } = await fixture(page, { reject: true }); await page.getByRole('button', { name: '提出修改', exact: true }).click(); await page.getByLabel('修改意见', { exact: true }).fill('保留这段修改意见');
  await page.getByRole('button', { name: '提交修改', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('计划或设置已变化');
  await expect(page.getByLabel('修改意见', { exact: true })).toHaveValue('保留这段修改意见'); expect(commands.filter(c => c.method === 'plan.respond')).toHaveLength(1);
});
test('reads each task mode and permission independently without changing either while navigating', async ({ page }) => {
  const f = await fixture(page, { secondTask: true }); await expect(closePlan(page)).toBeEnabled(); await page.getByLabel('消息', { exact: true }).fill('第一个任务草稿');
  await page.getByTitle('项目与会话', { exact: true }).click(); await page.getByRole('button', { name: '另一任务', exact: true }).click();
  await expect(closePlan(page)).toBeHidden(); await add(page).click(); await expect(planOption(page)).toHaveAttribute('aria-checked', 'false'); await expect(planOption(page)).toBeEnabled(); await page.getByTitle('关闭添加内容').click(); await permissionTrigger(page).click(); await expect(permissionOption(page, '完全访问权限')).toHaveAttribute('aria-checked', 'true'); await page.getByTitle('关闭任务权限').click();
  await page.getByTitle('项目与会话', { exact: true }).click(); await page.getByRole('button', { name: '计划模式验收', exact: true }).click();
  await expect(closePlan(page)).toBeEnabled(); await permissionTrigger(page).click(); await expect(permissionOption(page, '请求批准')).toHaveAttribute('aria-checked', 'true'); await page.getByTitle('关闭任务权限').click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('第一个任务草稿'); expect(f.commands.some(c => c.method === 'mode.update' || c.method === 'permissions.update')).toBe(false);
});
for (const variant of ['viewer', 'legacy', 'expired', 'offline', 'incompatible', 'unsynced'] as const) {
  test('keeps the plus menu visible and explains unavailable plan mode: ' + variant, async ({ page }) => {
    const f = await fixture(page, { viewer: variant === 'viewer', legacy: variant === 'legacy', unsynced: variant === 'unsynced' });
    if (variant === 'expired') f.status.subscription.access = false;
    if (variant === 'offline') f.status.online = false;
    if (variant === 'incompatible') f.status.client = { available: false, reason: '客户端接口不兼容', version: 'future', capabilities: [] };
    f.statusUpdate(); await add(page).click(); await expect(planOption(page)).toBeVisible(); await expect(planOption(page)).toBeDisabled();
    const reason = { viewer: '查看模式', legacy: '升级至 0.4.4', expired: '已到期', offline: '未连接', incompatible: '不兼容', unsynced: '尚未同步' }[variant];
    await expect(planOption(page)).toContainText(reason); expect(f.commands.some(c => ['mode.update', 'plan.respond'].includes(c.method))).toBe(false);
  });
}
for (const variant of ['viewer', 'legacy', 'expired', 'offline', 'incompatible', 'unsynced'] as const) {
  test('keeps permission settings visible and explains why changing is unavailable: ' + variant, async ({ page }) => {
    const f = await fixture(page, { viewer: variant === 'viewer', legacy: variant === 'legacy', permissionUnsynced: variant === 'unsynced' });
    if (variant === 'expired') f.status.subscription.access = false;
    if (variant === 'offline') f.status.online = false;
    if (variant === 'incompatible') f.status.client = { available: false, reason: '客户端接口不兼容', version: 'future', capabilities: [] };
    f.statusUpdate(); await permissionTrigger(page).click(); await expect(permissionOption(page, '请求批准')).toBeVisible(); await expect(permissionOption(page, '请求批准')).toBeDisabled();
    const reason = { viewer: '查看模式', legacy: '更新电脑助手', expired: '已到期', offline: '未连接', incompatible: '不兼容', unsynced: '尚未同步' }[variant];
    await expect(page.getByRole('dialog', { name: '任务权限', exact: true })).toContainText(reason); expect(f.commands.some(c => c.method === 'permissions.update')).toBe(false);
  });
}
test('shows the helper version separately from Codex and does not guess legacy versions', async ({ page }) => {
  const f = await fixture(page); await page.getByTitle('更多操作', { exact: true }).click();
  await expect(page.locator('.connection-versions')).toContainText('助手 v0.4.4'); await expect(page.locator('.connection-versions')).toContainText('Codex 26.903.61454');
  delete f.status.helperVersion; f.statusUpdate(); await expect(page.locator('.connection-versions')).toContainText('助手 版本未知');
  f.status.helperVersion = '99.0.0'; f.status.client.capabilities = ['compatibility-checked']; f.statusUpdate(); await page.getByTitle('更多操作', { exact: true }).click(); await add(page).click(); await expect(planOption(page)).toBeDisabled(); await expect(planOption(page)).toContainText('接口暂不兼容');
});
test('fits the composer chip and menu at 320, 390 and 1280 pixels, including a keyboard-sized viewport', async ({ page }, info) => {
  await fixture(page);
  for (const [width, height] of [[320,568], [390,844], [1280,900], [390,360]]) {
    await page.setViewportSize({ width, height }); await page.getByLabel('消息', { exact: true }).fill('布局验收草稿');
    for (const element of [add(page), closePlan(page), permissionTrigger(page), page.getByLabel('消息', { exact: true }), page.locator('.composer-field .send-button')]) {
      const box = await element.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width); expect(box!.y + box!.height).toBeLessThanOrEqual(height);
    }
    if (width === 320) { const inputBox = await page.getByLabel('消息', { exact: true }).boundingBox(); expect(inputBox!.width).toBeGreaterThan(100); }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: info.outputPath('composer-' + width + '-' + height + '.png') });
    await add(page).click(); await planOption(page).scrollIntoViewIfNeeded(); await expect(planOption(page)).toBeVisible(); await page.screenshot({ path: info.outputPath('menu-' + width + '-' + height + '.png') }); await page.getByTitle('关闭添加内容', { exact: true }).click();
    await permissionTrigger(page).click(); await expect(permissionOption(page, '请求批准')).toBeVisible(); await page.screenshot({ path: info.outputPath('permissions-' + width + '-' + height + '.png') }); await page.getByTitle('关闭任务权限', { exact: true }).click();
  }
});
