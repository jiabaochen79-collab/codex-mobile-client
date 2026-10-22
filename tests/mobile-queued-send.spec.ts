import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { mockPairedBrowser } from './paired-browser-fixture';
import type { Command, QueuedMessage, Snapshot } from '../src/shared/protocol';

test.use({ viewport: { width: 390, height: 844 }, launchOptions: process.env.TEST_BROWSER === 'webkit' ? {} : { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } });
const origin = 'http://127.0.0.1:18890';
const task = { id: '12345678-1234-4234-8234-123456789abc', title: 'Queue acceptance', cwd: 'C:/fixture', updatedAt: 1, projectId: 'project-a' };
const other = { ...task, id: '23456789-1234-4234-8234-123456789abc', title: 'Other task' };

// Only browser fixtures are controlled here; no command reaches a real Codex task.
async function fixture(page: Page) {
  const commands: Command[] = []; let socket: WebSocketRoute;
  const status = { type: 'status', online: true, enabled: true, client: { available: true, capabilities: ['queued-send', 'steering-text', 'multi-terminal', 'attachments', 'project-navigation', 'safety-status'] }, control: { role: 'controller', epoch: 'fixture-control' }, subscription: { access: true } };
  const snapshot: Snapshot = { ...task, epoch: 'fixture', busy: true, turnId: 'active-turn', lastTurnId: 'active-turn', lastTurnStatus: 'inProgress', requests: [], hasMore: false, queued: [], messages: Array.from({ length: 24 }, (_, i) => ({ id: `history-${i}`, role: i % 2 ? 'assistant' : 'user', text: `Record ${i + 1}\n` + 'History for scroll verification. '.repeat(12) })) };
  const queued = (id: string, text: string): QueuedMessage => ({ id, text, attachments: [], state: 'pending', created: Date.now(), reason: null });
  let file: any;
  const steering = { error: null as { code: string; message: string } | null };
  await mockPairedBrowser(page);
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { mode: 'mobile' } }));
  await page.route('**/api/notifications', route => route.fulfill({ json: { items: [], unread: 0 } }));
  await page.route('**/api/uploads/*/*', route => { file.offset = file.size; return route.fulfill({ json: file }); });
  await page.routeWebSocket('**/ws/mobile*', ws => {
    socket = ws; ws.send(JSON.stringify(status));
    ws.onMessage(raw => {
      const { id, command } = JSON.parse(String(raw)); commands.push(command); let result: any = { accepted: true };
      if (command.method === 'projects') result = { projects: [{ id: 'project-a', name: 'Fixture project', path: 'C:/fixture', count: 2 }, { id: 'project-b', name: 'Second project', path: 'C:/other', count: 0 }] };
      if (command.method === 'list') result = { conversations: command.params.projectId === 'project-a' ? [task, other] : [], hasMore: false };
      if (command.method === 'read' || command.method === 'queue.list') {
        if (!status.subscription.access) { ws.send(JSON.stringify({ type: 'result', id, error: { code: 'SUBSCRIPTION_REQUIRED', message: 'Subscription expired' } })); return; }
        result = { ...snapshot, id: command.params.id, queued: command.params.id === task.id ? snapshot.queued : [] };
      }
      if (command.method === 'safety.status') result = { id: task.id, epoch: snapshot.epoch, busy: snapshot.busy, turnId: snapshot.turnId };
      if (command.method === 'send') {
        if (command.params.mode === 'steer' && steering.error) { ws.send(JSON.stringify({ type: 'result', id, error: steering.error })); steering.error = null; return; }
        if (command.params.mode === 'queue') { const item = queued(id, command.params.text); if (command.params.attachmentIds?.length) item.attachments = [{ id: file.id, name: file.name }]; snapshot.queued!.push(item); result = { accepted: true, queued: true, messageId: id }; }
        else snapshot.messages.push({ id, role: 'user', text: command.params.text });
      }
      if (command.method === 'queue.remove') snapshot.queued = snapshot.queued!.filter(item => item.id !== command.params.queuedId);
      if (command.method === 'queue.resume') { const item = snapshot.queued!.find(item => item.id === command.params.queuedId)!; item.state = 'pending'; item.reason = null; }
      if (command.method === 'stop') { snapshot.busy = false; snapshot.turnId = null; for (const item of snapshot.queued!) { item.state = 'paused'; item.reason = 'Stopped'; } }
      if (command.method === 'upload.begin') result = file = { ...command.params, id, offset: 0, ready: false };
      if (command.method === 'upload.complete') result = file = { ...file, ready: true };
      ws.send(JSON.stringify({ type: 'result', id, result }));
    });
  });
  await page.goto(origin); await page.locator('.project-toggle').filter({ hasText: 'Fixture project' }).click(); await page.getByRole('button', { name: task.title, exact: true }).click();
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
  return { commands, snapshot, status, queued, steering, changed: () => socket.send(JSON.stringify({ type: 'changed', conversationIds: [task.id] })), updateStatus: () => socket.send(JSON.stringify(status)) };
}

test('changes stop to queue send with input, preserves stop, and supports pause, resume and cancel', async ({ page }) => {
  const f = await fixture(page); const input = page.getByLabel('消息', { exact: true });
  await expect(page.locator('.composer-field').getByTitle('停止当前生成', { exact: true })).toBeVisible();
  await input.fill('After this task, verify the output.');
  await expect(page.getByTitle('排队发送', { exact: true })).toBeEnabled();
  await expect(page.locator('.chat-toolbar').getByTitle('停止当前生成', { exact: true })).toBeEnabled();
  await page.getByTitle('排队发送', { exact: true }).click();
  await expect(input).toHaveValue(''); await expect(page.getByRole('region', { name: '待发送消息' })).toContainText('After this task');
  expect(f.commands.filter(c => c.method === 'send')).toEqual([expect.objectContaining({ params: expect.objectContaining({ mode: 'queue' }) })]);
  await page.locator('.composer-field').getByTitle('停止当前生成', { exact: true }).click();
  await expect(page.getByTitle('继续发送此消息')).toBeEnabled(); await page.getByTitle('继续发送此消息').click();
  await expect(page.getByTitle('继续发送此消息')).toHaveCount(0);
  await page.getByTitle('取消排队消息').click(); await expect(page.getByRole('region', { name: '待发送消息' })).toHaveCount(0);
});

test('steers the same active turn without stopping and closes the mode menu safely', async ({ page }, info) => {
  const f = await fixture(page); await page.getByLabel('消息', { exact: true }).fill('Focus on the mobile layout first.');
  await page.getByTitle('发送方式', { exact: true }).click(); await expect(page.getByRole('menuitem', { name: '调整方向', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('steering-menu-390.png') });
  await page.getByRole('menuitem', { name: '调整方向', exact: true }).click();
  await expect(page.getByRole('menu')).toHaveCount(0); await expect(page.getByLabel('消息', { exact: true })).toHaveValue('');
  expect(f.commands.filter(c => c.method === 'send')).toEqual([expect.objectContaining({ params: expect.objectContaining({ mode: 'steer', turnId: 'active-turn' }) })]);
  expect(f.commands.some(c => c.method === 'stop')).toBe(false); expect(f.snapshot.busy).toBe(true);
  await page.getByLabel('消息', { exact: true }).fill('Draft retained when stopping');
  await page.getByTitle('发送方式').click(); await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0);
  await page.getByTitle('发送方式').click(); await page.locator('.send-mode-scrim').click({ position: { x: 10, y: 90 } }); await expect(page.getByRole('menu')).toHaveCount(0);
  await page.getByTitle('发送方式').click(); await page.getByRole('menuitem', { name: '停止当前生成', exact: true }).click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('Draft retained when stopping');
});

test('queues attachments without silently including them in text-only steering', async ({ page }) => {
  const f = await fixture(page);
  await page.locator('input[data-attachment-source=files]').setInputFiles({ name: 'pending.txt', mimeType: 'text/plain', buffer: Buffer.from('Attachment fixture') });
  await expect(page.getByText('已上传', { exact: true })).toBeVisible();
  await page.getByLabel('消息', { exact: true }).fill('Include this file'); await page.getByTitle('发送方式').click();
  await expect(page.getByRole('menuitem', { name: '调整方向', exact: true })).toBeDisabled();
  await page.getByRole('menuitem', { name: '排队发送', exact: true }).click();
  await expect(page.getByRole('region', { name: '待发送消息' })).toContainText('pending.txt'); await expect(page.locator('.pending-attachment')).toHaveCount(0);
  expect(f.commands.filter(c => c.method === 'send')).toEqual([expect.objectContaining({ params: expect.objectContaining({ mode: 'queue', attachmentIds: [expect.any(String)] }) })]);
});

test('preserves a rejected steering draft and sends again only after an explicit retry', async ({ page }) => {
  const f = await fixture(page); const input = page.getByLabel('消息', { exact: true });
  const text = 'Keep this direction draft after a connection change.';
  f.steering.error = { code: 'CLIENT_UNAVAILABLE', message: '电脑端任务连接暂不可用，请稍后重试。' };
  await input.fill(text); await page.getByTitle('发送方式', { exact: true }).click();
  await page.getByRole('menuitem', { name: '调整方向', exact: true }).click();
  await expect(page.getByText('电脑端任务连接暂不可用，请稍后重试。', { exact: true })).toBeVisible();
  await expect(input).toHaveValue(text); await expect(page.getByRole('menu')).toHaveCount(0);
  expect(f.commands.filter(command => command.method === 'send')).toHaveLength(1);
  expect(f.snapshot.messages.filter(message => message.text === text)).toHaveLength(0);
  await page.getByTitle('发送方式', { exact: true }).click();
  await page.getByRole('menuitem', { name: '调整方向', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(page.getByText('电脑端任务连接暂不可用，请稍后重试。', { exact: true })).toHaveCount(0);
  expect(f.commands.filter(command => command.method === 'send')).toHaveLength(2);
  expect(f.snapshot.messages.filter(message => message.text === text)).toHaveLength(1);
  expect(f.commands.some(command => command.method === 'stop' || command.method === 'create')).toBe(false);
  expect(f.snapshot.busy).toBe(true);
});

test('restricts viewers and removes expired queue entries without reading the transcript', async ({ page }) => {
  const f = await fixture(page); f.snapshot.queued!.push(f.queued('queued-one', 'Queued before expiry')); f.changed();
  await expect(page.getByTitle('取消排队消息')).toBeEnabled(); f.status.control.role = 'viewer'; f.updateStatus();
  await expect(page.getByTitle('取消排队消息')).toBeDisabled(); await page.getByLabel('消息', { exact: true }).fill('Viewer draft');
  await expect(page.getByTitle('接管控制权', { exact: true })).toBeVisible(); await expect(page.getByTitle('发送方式')).toBeDisabled();
  f.status.control.role = 'controller'; f.status.subscription.access = false; f.updateStatus();
  await expect(page.getByTitle('取消排队消息')).toBeEnabled(); await page.getByTitle('取消排队消息').click();
  await expect(page.getByRole('region', { name: '待发送消息' })).toHaveCount(0);
});

test('keeps chat and queue usable at narrow widths without moving the history anchor', async ({ page }, info) => {
  const f = await fixture(page); f.snapshot.queued = Array.from({ length: 10 }, (_, i) => f.queued(`queued-${i}`, 'LongQueuedMessage'.repeat(18))); f.changed();
  await expect(page.getByRole('button', { name: '待发送 10', exact: true })).toBeVisible();
  for (const size of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(size); await page.getByLabel('消息', { exact: true }).fill('Queue layout draft');
    await page.getByTitle('发送方式').click();
    const box = await page.getByRole('menu').boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(size.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await page.locator('.transcript-area').boundingBox())!.height).toBeGreaterThan(180);
    await page.screenshot({ path: info.outputPath(`queue-${size.width}.png`) }); await page.keyboard.press('Escape');
  }
  await page.locator('.messages').evaluate(element => { element.scrollTop = 600; element.dispatchEvent(new Event('scroll')); });
  await expect(page.getByTitle('回到最新消息')).toBeVisible(); const top = await page.locator('.messages').evaluate(element => element.scrollTop);
  await page.getByRole('button', { name: '待发送 10', exact: true }).click();
  expect(Math.abs(await page.locator('.messages').evaluate(element => element.scrollTop) - top)).toBeLessThan(3);
  await page.getByTitle('回到最新消息').click(); await expect(page.getByTitle('回到最新消息')).toHaveCount(0);
});

test('retains task drafts and uses project identifiers when creating a task', async ({ page }) => {
  await fixture(page); await page.getByLabel('消息', { exact: true }).fill('Original draft');
  await page.getByTitle('项目与会话', { exact: true }).click(); await page.getByRole('button', { name: other.title, exact: true }).click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue(''); await page.getByLabel('消息', { exact: true }).fill('Other draft');
  await page.getByTitle('项目与会话', { exact: true }).click(); await page.getByRole('button', { name: task.title, exact: true }).click();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('Original draft');
  await page.getByTitle('项目与会话', { exact: true }).click(); await page.getByTitle('在Fixture project新建任务').click();
  await expect(page.getByLabel('现有项目')).toHaveValue('project-a'); await page.getByLabel('现有项目').selectOption('project-b'); await expect(page.getByLabel('现有项目')).toHaveValue('project-b');
});
