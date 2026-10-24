import { expect, test, type Page } from '@playwright/test';
const origin = 'http://127.0.0.1:18980';
const deviceId = '123456789';
const tasks = [
  { id: '11111111-1111-4111-8111-111111111111', title: 'Review task A', cwd: 'C:/fixture', updatedAt: 1 },
  { id: '22222222-2222-4222-8222-222222222222', title: 'Review task B', cwd: 'C:/fixture', updatedAt: 2 },
  { id: '33333333-3333-4333-8333-333333333333', title: 'Review created task', cwd: 'C:/fixture', updatedAt: 3 }
];
async function fixture(page: Page, intercept?: (message: any, reply: (result?: any, error?: any) => void) => boolean) {
  let websocket: any;
  const commands: any[] = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const result = path === '/api/bootstrap' ? { mode: 'mobile' } : path.startsWith('/api/paired-devices') ? { devices: [{ deviceId, name: '', lastUsed: 1, expires: Date.now() + 86400000, remembered: true, authorized: true, online: true, enabled: true }] } : path === '/api/notifications' ? { items: [], unread: 0 } : {};
    return route.fulfill({ json: result });
  });
  await page.routeWebSocket('**/ws/mobile*', socket => {
    websocket = socket;
    socket.send(JSON.stringify({ type: 'status', online: true, enabled: true, subscription: { access: true }, client: { available: true, capabilities: ['queued-send', 'command-status'] } }));
    socket.onMessage(raw => {
      const m = JSON.parse(String(raw)); commands.push(m);
      const reply = (result?: any, error?: any) => socket.send(JSON.stringify({ type: 'result', id: m.id, ...(error ? { error } : { result }) }));
      if (intercept?.(m, reply)) return;
      const c = m.command;
      if (c.method === 'list') reply({ conversations: tasks, hasMore: false });
      else if (c.method === 'projects') reply({ projects: [{ id: 'fixture-project', name: 'Fixture', path: 'C:/fixture' }] });
      else if (c.method === 'read') reply({ ...tasks.find(t => t.id === c.params.id), epoch: 'fixture', busy: false, turnId: null, requests: [], messages: [], hasMore: false, settings: { model: 'fixture', effort: 'high', mode: 'default', permission: 'ask', revision: 'fixture' } });
      else if (c.method === 'command.status') reply({ state: 'unknown' });
      else reply({});
    });
  });
  await page.goto(origin);
  await page.getByRole('button', { name: tasks[0].title, exact: true }).click();
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
  return { commands, send: (frame: any) => websocket.send(JSON.stringify(frame)), close: () => websocket.close({ code: 4001, reason: 'Session expired' }) };
}
async function newTask(page: Page) {
  await page.getByTitle('更多操作', { exact: true }).click();
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.getByLabel('任务', { exact: true }).fill('Review creation');
  await page.getByRole('button', { name: '创建任务', exact: false }).click();
}
async function chooseB(page: Page) {
  await page.getByTitle('项目与会话', { exact: true }).click();
  await page.getByRole('button', { name: tasks[1].title, exact: true }).click();
  await expect(page.locator('.chat-heading h1')).toHaveText(tasks[1].title);
}

test('expiry preserves saved drafts through reauthentication', async ({ page }) => {
  const f = await fixture(page);
  await page.getByLabel('消息', { exact: true }).fill('A draft that must not be lost');
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('chat-drafts:123456789'))).toContain('A draft that must not be lost');
  f.close();
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('chat-drafts:123456789'))).toContain('A draft that must not be lost');
  await page.route('**/api/connect', route => route.fulfill({ json: { devices: [{ deviceId, lastUsed: 1, authorized: true, online: true, enabled: true }] } }));
  await page.getByLabel('验证码或自定义密码').fill('Fixture-Only-Password42');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByRole('button', { name: tasks[0].title, exact: true }).click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('A draft that must not be lost');
});

test('expiry retains an unconfirmed send record instead of silently permitting another send', async ({ page }) => {
  const f = await fixture(page, (m) => m.command.method === 'send');
  await page.getByLabel('消息', { exact: true }).fill('Keep unconfirmed send');
  await page.locator('.send-button').click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('pending-sends:123456789'))).toContain('Keep unconfirmed send');
  f.close();
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('pending-sends:123456789'))).toContain('Keep unconfirmed send');
});

test('expiry and reauthentication keep an unsent attachment', async ({ page }) => {
  const attachment = { id: '88888888-8888-4888-8888-888888888888', name: 'keep.txt', size: 4, offset: 4, ready: true, mediaType: 'text/plain' };
  const f = await fixture(page, (m, reply) => { if (!m.command.method.startsWith('upload.')) return false; reply(attachment); return true; });
  await page.locator('input[data-attachment-source=files]').setInputFiles({ name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('keep') });
  await expect(page.locator('.pending-attachment strong')).toHaveText('keep.txt');
  f.close(); await expect(page.getByRole('button', { name: '连接', exact: true })).toBeVisible();
  await page.route('**/api/connect', route => route.fulfill({ json: { devices: [{ deviceId, lastUsed: 1, authorized: true, online: true, enabled: true }] } }));
  await page.getByLabel('验证码或自定义密码').fill('Fixture-Only-Password42');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByRole('button', { name: tasks[0].title, exact: true }).click();
  await expect(page.locator('.pending-attachment strong')).toHaveText('keep.txt');
});

test('an uncertain create survives reload and failed authorization during reconciliation', async ({ page }) => {
  const command = { method: 'create', params: { projectId: 'fixture-project', text: 'Original creation' } };
  const requestId = '77777777-7777-4777-8777-777777777777';
  await page.addInitScript(({ command, requestId }) => sessionStorage.setItem('pending-create:123456789', JSON.stringify({ command, requestId })), { command, requestId });
  const f = await fixture(page, (m, reply) => { if (m.command.method !== 'create') return false; reply(undefined, { code: 'AUTH', message: 'Previous authorization expired' }); return true; });
  await page.getByTitle('更多操作', { exact: true }).click();
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await expect(page.getByLabel('任务', { exact: true })).toHaveValue('Original creation');
  await page.getByRole('button', { name: '核对创建结果', exact: false }).click();
  await expect(page.getByRole('button', { name: '核对创建结果', exact: false })).toBeEnabled();
  expect(f.commands.find(m => m.command.method === 'create')).toMatchObject({ id: requestId, command });
  expect(await page.evaluate(() => sessionStorage.getItem('pending-create:123456789'))).toContain(requestId);
});

test('unknown create outcome keeps the original command id and frozen payload when explicitly reconciled', async ({ page }) => {
  const f = await fixture(page, (m, reply) => {
    if (m.command.method !== 'create') return false;
    reply(undefined, { code: 'OUTCOME_UNKNOWN', message: 'Creation confirmation lost' }); return true;
  });
  await newTask(page);
  await expect(page.getByRole('button', { name: '核对创建结果', exact: false })).toBeEnabled();
  await expect(page.getByLabel('任务', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '核对创建结果', exact: false }).click();
  await expect.poll(() => f.commands.filter(m => m.command.method === 'create').length).toBe(2);
  const creations = f.commands.filter(m => m.command.method === 'create');
  expect(creations[0].id).toBe(creations[1].id);
  expect(creations[0].command.params).toEqual(creations[1].command.params);
  expect(f.commands.some(m => m.command.method === 'command.status')).toBe(false);
});

test('late create completion never overrides a newer explicit task selection', async ({ page }) => {
  let finish!: (result?: any, error?: any) => void;
  await fixture(page, (m, reply) => { if (m.command.method !== 'create') return false; finish = reply; return true; });
  await newTask(page);
  await expect.poll(() => !!finish).toBe(true);
  await page.getByRole('dialog', { name: '新建任务', exact: true }).getByTitle('关闭', { exact: true }).click();
  await chooseB(page);
  finish({ threadId: tasks[2].id });
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('pending-create:123456789'))).toBeNull();
  await expect(page.locator('.chat-heading h1')).toHaveText(tasks[1].title);
});

test('a send rejection for A does not appear in task B', async ({ page }) => {
  let finish!: (result?: any, error?: any) => void;
  await fixture(page, (m, reply) => { if (m.command.method !== 'send') return false; finish = reply; return true; });
  await page.getByLabel('消息', { exact: true }).fill('Send in A');
  await page.locator('.send-button').click();
  await expect.poll(() => !!finish).toBe(true);
  await chooseB(page);
  finish(undefined, { code: 'CLIENT_REJECTED', message: 'Task A rejected the send' });
  await expect(page.locator('.chat-heading h1')).toHaveText(tasks[1].title);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('pending-sends:123456789'))).toBe('{}');
  await expect(page.locator('.app-alert')).toHaveCount(0);
});

test('a notification arriving during read-all stays unread', async ({ page }) => {
  const now = Date.now();
  const item = (id: string) => ({ id, deviceId, taskId: tasks[0].id, turnId: id, status: 'completed', occurredAt: now, createdAt: now, readAt: null, delivery: 'pending' });
  const f = await fixture(page);
  await page.route('**/api/notifications/settings', route => route.fulfill({ json: { settings: { enabled: false, completed: true, failed: true }, pushConfigured: false } }));
  await page.route('**/api/notifications', route => route.fulfill({ json: { items: [item('44444444-4444-4444-8444-444444444444')], unread: 1 } }));
  let finish!: () => Promise<void>;
  await page.route('**/api/notifications/read-all', route => { finish = () => route.fulfill({ json: { ok: true } }); });
  await page.getByTitle('更多操作', { exact: true }).click();
  await page.getByRole('button', { name: '任务提醒', exact: true }).click();
  await page.getByRole('button', { name: '全部标为已读', exact: true }).click();
  await expect.poll(() => !!finish).toBe(true);
  f.send({ type: 'notification', notification: item('55555555-5555-4555-8555-555555555555') });
  await expect(page.locator('.notification-item.unread')).toHaveCount(2);
  await finish();
  await expect(page.locator('.notification-item.unread')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '全部标为已读', exact: true })).toBeVisible();
});

test('copy payment link issues a fresh ticket for the same order after the first link was consumed', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => { (window as any).copiedPayment = value; } }, configurable: true }); });
  const plan = { id: 'month', name: '月卡', priceFen: 600, days: 30, revision: 1, available: true };
  await page.route('**/api/subscription', route => route.fulfill({ json: { subscription: { access: true, status: 'active' }, catalog: { termsVersion: 'fixture', salesOpen: true, plans: [plan] } } }));
  let created = false, opened = false;
  const payUrl = origin + '/pay/#ticket=' + 'x'.repeat(64);
  const order = { id: '66666666-6666-4666-8666-666666666666', deviceId, planId: 'month', planName: '月卡', priceFen: 600, days: 30, channel: 'alipay', status: 'pending', serviceStatus: '未开通', created: Date.now(), expires: Date.now() + 900000 };
  let openRequests = 0;
  await page.route('**/api/orders**', route => {
    const request = route.request();
    if (request.method() === 'POST') { openRequests++; created = true; return route.fulfill({ json: { order, payUrl: request.url().endsWith('/open') ? payUrl.replace('x'.repeat(64), 'y'.repeat(64)) : payUrl } }); }
    return route.fulfill({ json: { deviceId, orders: created ? [order] : [], licenses: [], refunds: [], readiness: { ready: true, channels: ['alipay'] } } });
  });
  await page.context().route('**/pay/**', route => { opened = true; return route.fulfill({ contentType: 'text/html', body: '<html><body>Fixture payment ticket consumed</body></html>' }); });
  await page.getByTitle('项目与会话', { exact: true }).click();
  await page.getByTitle('订阅与权益', { exact: true }).click();
  await page.getByTitle('购买月卡', { exact: true }).click();
  await page.getByRole('checkbox', { name: '我已确认设备、金额并同意上述条款', exact: true }).check();
  await page.getByRole('button', { name: '创建订单', exact: false }).click();
  const popup = page.waitForEvent('popup');
  await page.getByRole('link', { name: '去支付宝支付', exact: true }).click();
  const paymentPage = await popup; await paymentPage.waitForLoadState();
  expect(opened).toBe(true);
  await page.getByRole('button', { name: '复制付款链接', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).copiedPayment)).toBe(payUrl.replace('x'.repeat(64), 'y'.repeat(64)));
  expect(openRequests).toBe(2);
  await paymentPage.close();
});

test('an empty failed turn still displays its failure reason without a fake command', async ({ page }) => {
  await fixture(page, (m, reply) => {
    if (m.command.method !== 'read') return false;
    reply({ ...tasks[0], epoch: 'fixture', busy: false, turnId: null, lastTurnId: 'failed-empty', lastTurnStatus: 'failed', lastTurnReason: 'Fixture service unavailable', requests: [], messages: [], hasMore: false, settings: { model: 'fixture', effort: 'high', mode: 'default', permission: 'ask', revision: 'fixture' } });
    return true;
  });
  await expect(page.locator('.turn-outcome')).toContainText('Fixture service unavailable');
  await expect(page.locator('.tool-step')).toHaveCount(0);
});

const readRejected = { code: 'CLIENT_REJECTED', message: '原客户端未接受此操作，请检查目标会话。' };
const taskSnapshot = (task: typeof tasks[number], text = 'Recovered task content') => ({
  ...task, epoch: 'fixture', busy: false, turnId: null, requests: [], hasMore: false,
  messages: [{ id: 'fixture-result', role: 'assistant', text }],
  settings: { mode: 'default', permission: 'ask', revision: 'fixture' }
});

test('task-read recovers a transient rejection without presenting an operation failure', async ({ page }, info) => {
  await page.clock.install(); let reads = 0;
  const f = await fixture(page, (m, reply) => {
    if (m.command.method !== 'read') return false;
    reads++; if (reads < 3) reply(undefined, readRejected); else reply(taskSnapshot(tasks[0])); return true;
  });
  await expect(page.getByRole('status')).toContainText('正在同步会话');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.clock.runFor(1000); await expect.poll(() => reads).toBe(2);
  await page.clock.runFor(2000); await expect(page.getByText('Recovered task content', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(f.commands.some(m => ['send', 'stop', 'respond', 'create'].includes(m.command.method))).toBe(false);
  await page.screenshot({ path: info.outputPath('task-read-recovered.png') });
});

test('task-read bounds rapid retries and permits an explicit fresh retry', async ({ page }) => {
  await page.clock.install(); let reads = 0;
  await fixture(page, (m, reply) => { if (m.command.method !== 'read') return false; reads++; reply(undefined, readRejected); return true; });
  await expect(page.getByRole('status')).toContainText('正在同步会话');
  for (const [delay, count] of [[1000, 2], [2000, 3], [4000, 4]]) {
    await page.clock.runFor(delay); await expect.poll(() => reads).toBe(count);
  }
  await expect(page.getByRole('alert')).toContainText('会话暂时读取失败');
  await expect(page.getByText(readRejected.message, { exact: true })).toHaveCount(0);
  await page.clock.runFor(1000); expect(reads).toBe(4);
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await expect.poll(() => reads).toBe(5);
  await expect(page.getByRole('status')).toContainText('正在同步会话');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('task-read retains existing content and drafts during recovery', async ({ page }) => {
  await page.clock.install(); let fail = false;
  const f = await fixture(page, (m, reply) => {
    if (m.command.method !== 'read') return false;
    if (fail) reply(undefined, readRejected); else reply(taskSnapshot(tasks[0])); return true;
  });
  await expect(page.getByText('Recovered task content', { exact: true })).toBeVisible();
  await page.getByLabel('消息', { exact: true }).fill('Keep this draft');
  fail = true; f.send({ type: 'changed', conversationId: tasks[0].id }); await page.clock.runFor(250);
  await expect(page.getByRole('status')).toContainText('正在同步会话');
  await expect(page.getByText('Recovered task content', { exact: true })).toBeVisible();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('Keep this draft');
  await expect(page.getByRole('alert')).toHaveCount(0);
  fail = false; await page.clock.runFor(1000);
  await expect(page.locator('.chat-status')).toHaveCount(0);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('Keep this draft');
});

test('task-read cancels a pending recovery when another task is selected', async ({ page }) => {
  await page.clock.install();
  const f = await fixture(page, (m, reply) => {
    if (m.command.method !== 'read') return false;
    if (m.command.params.id === tasks[0].id) reply(undefined, readRejected); else reply(taskSnapshot(tasks[1], 'Task B content')); return true;
  });
  await expect(page.getByRole('status')).toContainText('正在同步会话');
  await chooseB(page); await expect(page.getByText('Task B content', { exact: true })).toBeVisible();
  const before = f.commands.filter(m => m.command.method === 'read').length;
  await page.clock.runFor(8000);
  expect(f.commands.filter(m => m.command.method === 'read')).toHaveLength(before);
  await expect(page.locator('.chat-heading h1')).toHaveText(tasks[1].title);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('task-read shows an unsupported interface immediately without rapid retries', async ({ page }) => {
  await page.clock.install(); let reads = 0;
  await fixture(page, (m, reply) => {
    if (m.command.method !== 'read') return false;
    reads++; reply(undefined, { code: 'UNSUPPORTED', message: '请更新电脑助手以读取此会话。' }); return true;
  });
  await expect(page.getByRole('alert')).toContainText('请更新电脑助手');
  await page.clock.runFor(8000); expect(reads).toBe(1);
});

test('task-read backoff cannot be bypassed by a burst of task changes', async ({ page }) => {
  await page.clock.install(); let reads = 0;
  const f = await fixture(page, (m, reply) => {
    if (m.command.method !== 'read') return false;
    reads++; if (reads === 1) reply(undefined, readRejected); else reply(taskSnapshot(tasks[0])); return true;
  });
  await expect(page.getByRole('status')).toContainText('正在同步会话');
  for (let i = 0; i < 25; i++) f.send({ type: 'changed', conversationId: tasks[0].id });
  await page.clock.runFor(250); expect(reads).toBe(1);
  await page.clock.runFor(750); await expect(page.getByText('Recovered task content', { exact: true })).toBeVisible();
  expect(reads).toBe(2);
});

test('task-read recovery never clears or repeats a rejected send', async ({ page }) => {
  await page.clock.install();
  const f = await fixture(page, (m, reply) => {
    if (m.command.method === 'read') { reply(taskSnapshot(tasks[0])); return true; }
    if (m.command.method === 'send') { reply(undefined, readRejected); return true; }
    return false;
  });
  await expect(page.getByText('Recovered task content', { exact: true })).toBeVisible();
  await page.getByLabel('消息', { exact: true }).fill('A rejected send'); await page.locator('.send-button').click();
  await expect(page.getByRole('alert')).toContainText(readRejected.message);
  f.send({ type: 'changed', conversationId: tasks[0].id }); await page.clock.runFor(250);
  await expect(page.getByRole('alert')).toContainText(readRejected.message);
  expect(f.commands.filter(m => m.command.method === 'send')).toHaveLength(1);
});
