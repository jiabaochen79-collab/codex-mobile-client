import { expect, test, type Page } from '@playwright/test';

const origin = process.env.NOTIFICATION_TEST_ORIGIN ?? 'http://127.0.0.1:18920';
const deviceId = '123456789';
const otherDeviceId = '987654321';
const tasks = [
  { id: '11111111-1111-4111-8111-111111111111', title: 'Quarterly financial review', cwd: 'C:/test', updatedAt: 1, projectId: 'project-a' },
  { id: '22222222-2222-4222-8222-222222222222', title: 'Customer support improvements', cwd: 'C:/test', updatedAt: 2, projectId: 'project-a' }
];
const notifications = tasks.map((task, index) => ({ id: `33333333-3333-4333-8333-33333333333${index}`, deviceId, taskId: task.id, turnId: `turn-${index}`, status: 'completed', occurredAt: Date.now(), createdAt: Date.now(), readAt: null, delivery: 'accepted' }));
const link = (index = 0, device = deviceId) => `${origin}/?notification=${notifications[index].id}&notificationDevice=${device}`;

async function fixture(page: Page, initiallyReady = true, missing = false) {
  const commands: { device: string; command: any }[] = []; const reads: string[] = []; const statuses = new Map<string, (ready: boolean) => void>();
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { mode: 'mobile' } }));
  const devices = [deviceId, otherDeviceId].map((device, index) => ({ deviceId: device, name: index ? 'Office computer' : 'Home computer', lastUsed: 2 - index, remembered: true, authorized: true, online: true, enabled: true }));
  await page.route('**/api/paired-devices**', route => route.fulfill({ json: { devices } }));
  await page.route('**/api/web-version', route => route.fulfill({ json: { entry: '/web/main.ts' } }));
  await page.route('**/api/notifications**', async route => {
    const path = new URL(route.request().url()).pathname; const device = route.request().headers()['x-remote-device'];
    if (path.endsWith('/settings')) return route.fulfill({ json: { settings: { enabled: true, completed: true, failed: true }, pushConfigured: false } });
    if (path.endsWith('/read')) { reads.push(device); return route.fulfill({ json: { ok: true } }); }
    const item = notifications.find(row => path.endsWith('/' + row.id));
    return route.fulfill({ json: item ? { item: { ...item, deviceId: device } } : { items: notifications.map(row => ({ ...row, deviceId: device })), unread: 2 } });
  });
  await page.routeWebSocket('**/ws/mobile*', ws => {
    const device = new URL(ws.url()).searchParams.get('remoteDevice')!;
    const status = (ready: boolean) => ws.send(JSON.stringify({ type: 'status', online: ready, enabled: true, client: { available: ready, capabilities: ['project-navigation', 'multi-terminal'] }, control: { role: 'viewer', epoch: null, terminals: [] } }));
    statuses.set(device, status); status(initiallyReady);
    ws.onMessage(data => {
      const { id, command } = JSON.parse(String(data)); commands.push({ device, command }); let result: any;
      if (command.method === 'projects') result = { projects: [{ id: 'project-a', name: 'Operations', path: 'C:/test' }] };
      if (command.method === 'list') result = command.params.projectId === null ? { conversations: [], hasMore: false }
        : command.params.projectId ? { conversations: tasks, hasMore: false }
        : { conversations: tasks.slice(command.params.offset, command.params.offset + 1), hasMore: command.params.offset === 0 };
      if (command.method === 'read') {
        if (missing) { ws.send(JSON.stringify({ type: 'result', id, error: { code: 'NOT_FOUND', message: 'Task no longer exists' } })); return; }
        const task = tasks.find(row => row.id === command.params.id)!;
        result = { id: task.id, title: task.title, epoch: 'fixture', busy: false, turnId: null, messages: [{ id: 'final', role: 'assistant', text: 'Result: ' + task.title }], requests: [], hasMore: false };
      }
      ws.send(JSON.stringify({ type: 'result', id, result }));
    });
  });
  return { commands, reads, statuses };
}

async function pushClick(page: Page, url: string) {
  await page.evaluate(value => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'notification.open', url: value } })), url);
}
async function history(page: Page) {
  await page.getByTitle('更多操作', { exact: true }).click(); await page.getByRole('button', { name: /^任务完成提醒/ }).click();
}

test('keeps a cold-start notification pending until the computer is ready', async ({ page }) => {
  const state = await fixture(page, false); await page.goto(link());
  await expect(page.getByRole('heading', { name: '项目与会话' })).toBeVisible();
  await page.waitForTimeout(300);
  expect(state.reads).toEqual([]); expect(new URL(page.url()).searchParams.has('notification')).toBe(true);
  state.statuses.get(deviceId)!(true);
  await expect(page.getByText('Result: ' + tasks[0].title, { exact: true })).toBeVisible();
  await expect(page.locator('.chat-heading h1')).toHaveText(tasks[0].title);
  await expect.poll(() => new URL(page.url()).searchParams.has('notification')).toBe(false);
  expect(state.reads).toEqual([deviceId]);
  expect(state.commands.filter(row => !['list', 'projects', 'read', 'activity', 'seen'].includes(row.command.method))).toEqual([]);
  expect(state.commands.filter(row => row.command.method === 'read').every(row => row.command.params.activate === false)).toBe(true);
});

for (const width of [320, 390]) test(`shows task names and projects in reminder history at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); await fixture(page); await page.goto(origin);
  await history(page);
  for (const task of tasks) await expect(page.locator('.notification-item').filter({ hasText: task.title })).toContainText('Operations');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `.runtime/notification-verification/list-${width}.png` });
});

test('history clicks open the named task before marking it read, without activating it', async ({ page }) => {
  const state = await fixture(page); await page.goto(origin); await history(page);
  await page.locator('.notification-item').filter({ hasText: tasks[1].title }).click();
  await expect(page.getByRole('dialog', { name: '任务完成提醒', exact: true })).toBeHidden();
  await expect(page.locator('.chat-heading h1')).toHaveText(tasks[1].title);
  expect(state.reads).toEqual([deviceId]);
  expect(state.commands.filter(row => row.command.method === 'read').every(row => row.command.params.activate === false)).toBe(true);
});

test('offline history has distinct task numbers, keeps unread items, and resolves names after reconnection', async ({ page }) => {
  const state = await fixture(page, false); await page.goto(origin); await history(page);
  for (const task of tasks) await expect(page.locator('.notification-item').filter({ hasText: task.id.slice(0, 8) })).toBeVisible();
  await page.locator('.notification-item').first().click();
  await expect(page.getByRole('alert')).toContainText('电脑离线');
  expect(state.reads).toEqual([]); expect(state.commands).toEqual([]);
  state.statuses.get(deviceId)!(true);
  for (const task of tasks) await expect(page.locator('.notification-item').filter({ hasText: task.title })).toContainText('Operations');
});

test('notification navigation preserves drafts on the previous task', async ({ page }) => {
  await fixture(page); await page.goto(link());
  await expect(page.locator('.chat-heading h1')).toHaveText(tasks[0].title);
  await expect.poll(() => new URL(page.url()).searchParams.has('notification')).toBe(false);
  await page.getByLabel('消息', { exact: true }).fill('Keep this unsent draft');
  await pushClick(page, link(1)); await expect(page.locator('.chat-heading h1')).toHaveText(tasks[1].title);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('');
  await expect.poll(() => new URL(page.url()).searchParams.has('notification')).toBe(false);
  await pushClick(page, link()); await expect(page.getByLabel('消息', { exact: true })).toHaveValue('Keep this unsent draft');
});

test('ignores forged cross-origin links and requires pairing for an unknown computer', async ({ page }) => {
  const state = await fixture(page); await page.goto(origin);
  await expect(page.getByRole('heading', { name: '项目与会话' })).toBeVisible();
  await pushClick(page, link().replace(origin, 'https://untrusted.example'));
  expect(new URL(page.url()).searchParams.has('notification')).toBe(false); expect(state.reads).toEqual([]);
  await pushClick(page, link(0, '456789123'));
  await expect(page.getByRole('heading', { name: '添加电脑', exact: true })).toBeVisible();
  await expect(page.getByLabel('设备 ID', { exact: true })).toHaveValue('456789123');
  expect(state.commands.filter(row => row.command.method === 'read')).toEqual([]); expect(state.reads).toEqual([]);
});

test('does not consume a newer notification when an earlier request finishes late', async ({ page }) => {
  const state = await fixture(page); let release!: () => void; let requested = false;
  const gate = new Promise<void>(resolve => release = resolve);
  await page.route(`**/api/notifications/${notifications[0].id}`, async route => { requested = true; await gate; await route.fulfill({ json: { item: notifications[0] } }); });
  await page.goto(link()); await expect.poll(() => requested).toBe(true);
  try {
    await pushClick(page, link(1)); release();
    await expect(page.locator('.chat-heading h1')).toHaveText(tasks[1].title);
    await expect.poll(() => new URL(page.url()).searchParams.has('notification')).toBe(false);
    expect(state.reads).toEqual([deviceId]);
    expect(state.commands.filter(row => row.command.method === 'read').map(row => row.command.params.id)).toEqual([tasks[1].id]);
  } finally { release(); }
});

test('honors the latest computer notification while an earlier device switch is pending', async ({ page }) => {
  const state = await fixture(page); let release!: () => void; let selecting = false;
  const gate = new Promise<void>(resolve => release = resolve);
  await page.route(`**/api/paired-devices/${otherDeviceId}/select`, async route => { selecting = true; await gate; await route.fallback(); });
  await page.goto(origin); await expect(page.getByRole('heading', { name: '项目与会话' })).toBeVisible();
  try {
    await pushClick(page, link(1, otherDeviceId)); await expect.poll(() => selecting).toBe(true);
    await pushClick(page, link()); release();
    await expect(page.locator('.chat-heading h1')).toHaveText(tasks[0].title);
    await expect.poll(() => new URL(page.url()).searchParams.has('notification')).toBe(false);
    expect(state.commands.filter(row => row.command.method === 'read').map(row => row.device)).toEqual([deviceId]);
    expect(state.reads).toEqual([deviceId]);
  } finally { release(); }
});

test('keeps history open and unread when its task cannot be loaded', async ({ page }) => {
  const state = await fixture(page, true, true); await page.goto(origin); await history(page);
  await page.locator('.notification-item').filter({ hasText: tasks[0].title }).click();
  await expect(page.getByRole('dialog', { name: '任务完成提醒', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Task no longer exists');
  expect(state.reads).toEqual([]); await expect(page.locator('.notification-item.unread')).toHaveCount(2);
});

test.describe('native Service Worker bridge', () => {
  test.use({ serviceWorkers: 'allow' });
  test('acknowledges the task link delivered by an actual worker without reloading the app', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'WebKit HTTP mocks bypass the service worker network path.');
    const state = await fixture(page); await page.goto(origin);
    await expect(page.getByRole('heading', { name: '项目与会话' })).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    const worker = context.serviceWorkers()[0];
    const acknowledgement = await worker.evaluate(async url => {
      const scope = self as unknown as { clients: { matchAll: (options: unknown) => Promise<{ postMessage: (message: unknown, ports: MessagePort[]) => void }[]> } };
      const pages = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const channel = new MessageChannel();
      return new Promise<string>(resolve => {
        channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data); };
        pages[0].postMessage({ type: 'notification.open', url }, [channel.port2]);
      });
    }, link(1));
    expect(acknowledgement).toBe('notification.received');
    await expect(page.locator('.chat-heading h1')).toHaveText(tasks[1].title);
    expect(state.reads).toEqual([deviceId]);
  });
});

test('opens a notification in the already-open web app and switches only to its authorized computer', async ({ page }) => {
  const state = await fixture(page); await page.goto(origin);
  await expect(page.getByRole('heading', { name: '项目与会话' })).toBeVisible();
  await pushClick(page, link(1, otherDeviceId));
  await expect(page.getByText('Result: ' + tasks[1].title, { exact: true })).toBeVisible();
  expect(state.commands.filter(row => row.command.method === 'read').map(row => row.device)).toEqual([otherDeviceId]);
  expect(state.reads).toEqual([otherDeviceId]);
});

test('does not mark a missing task as read or discard its notification link', async ({ page }) => {
  const state = await fixture(page, true, true); await page.goto(link());
  await expect(page.getByRole('alert')).toBeVisible();
  expect(state.reads).toEqual([]); expect(new URL(page.url()).searchParams.has('notification')).toBe(true);
});
