import { expect, test } from '@playwright/test';
import { mockPairedBrowser } from './paired-browser-fixture';

const webkit = process.env.TEST_BROWSER === 'webkit';
test.use({ browserName: webkit ? 'webkit' : 'chromium', viewport: { width: 390, height: 844 }, launchOptions: webkit ? {} : { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } });
test('disables unconfirmed send, create and approval features without hiding supported stop', async ({ page }) => {
  const task = { id: '12345678-1234-4234-8234-123456789abc', title: '兼容性验收任务', cwd: 'C:/fixture', updatedAt: 1 };
  const writes: string[] = []; let busy = true;
  await mockPairedBrowser(page);
  await page.routeWebSocket('**/ws/mobile*', socket => {
    socket.send(JSON.stringify({ type: 'status', online: true, enabled: true, client: { available: true, version: 'future', reason: '发送消息和审批接口需适配', capabilities: ['compatibility-checked', 'stop-generation', 'queued-send'] } }));
    socket.onMessage(raw => {
      const { id, command } = JSON.parse(String(raw)); let result: any;
      if (command.method === 'list') result = { conversations: [task], hasMore: false };
      else if (command.method === 'read') result = { ...task, epoch: 'fixture', busy, turnId: busy ? 'turn' : null, messages: [], hasMore: false, requests: [{ id: 'approval', kind: 'command', title: '测试审批' }] };
      else { writes.push(command.method); if (command.method === 'stop') busy = false; result = { accepted: true }; }
      socket.send(JSON.stringify({ type: 'result', id, result }));
    });
  });
  await page.goto('http://127.0.0.1:18890'); await expect(page.getByTitle('新建任务', { exact: true })).toBeDisabled(); await page.getByRole('button', { name: task.title, exact: true }).click();
  await expect(page.getByRole('button', { name: '允许本次', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: '拒绝', exact: true })).toBeDisabled(); await expect(page.getByTitle('停止当前生成', { exact: true })).toBeEnabled();
  await page.getByLabel('消息', { exact: true }).fill('保留草稿但不发送'); await expect(page.getByTitle('排队发送', { exact: true })).toBeDisabled(); await page.locator('.chat-toolbar').getByTitle('停止当前生成', { exact: true }).click();
  expect(writes).toEqual(['stop']); await expect(page.getByLabel('消息', { exact: true })).toHaveValue('保留草稿但不发送'); await expect(page.getByTitle('发送消息', { exact: true })).toBeDisabled();
});
