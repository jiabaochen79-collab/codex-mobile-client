import { expect, test, type Page } from '@playwright/test';
import { mockPairedBrowser } from './paired-browser-fixture';
import { writeFile } from 'node:fs/promises';

const webkit = process.env.TEST_BROWSER === 'webkit';
test.use({ browserName: webkit ? 'webkit' : 'chromium', viewport: { width: 390, height: 844 }, launchOptions: webkit ? {} : { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } });
const origin = 'http://127.0.0.1:18890';

async function fixture(page: Page, count = 500) {
  const task = { id: '12345678-1234-4234-8234-123456789abc', title: 'Performance fixture', cwd: 'C:/fixture', updatedAt: 1 };
  const snapshot = { ...task, epoch: 'fixture', busy: false, turnId: null, hasMore: false, requests: [], settings: { mode: 'default', revision: 'settings', permission: 'ask' }, messages: Array.from({ length: count }, (_, i) => ({ id: `m-${i}`, role: i % 2 ? 'assistant' : 'user', text: i % 2 ? `### Result ${i}\n\n` + '- **Verified** synthetic record.\n'.repeat(8) : `Request ${i}`, turnId: `turn-${Math.floor(i / 2)}`, turnStatus: 'completed' })) };
  const frames: any[] = []; let update!: () => void, updates = 0;
  await mockPairedBrowser(page);
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { mode: 'mobile' } }));
  await page.route('**/api/notifications', route => route.fulfill({ json: { items: [], unread: 0 } }));
  await page.routeWebSocket('**/ws/mobile*', socket => {
    socket.send(JSON.stringify({ type: 'status', online: true, enabled: true, subscription: { access: true }, control: { role: 'controller', epoch: '12345678-1234-4234-8234-123456789abd', terminals: [] }, client: { available: true, capabilities: ['multi-terminal', 'send-messages', 'task-mode'] } }));
    update = () => { snapshot.messages.at(-1)!.text += `\nNew output ${++updates}`; socket.send(JSON.stringify({ type: 'changed', conversationIds: [task.id] })); };
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw)); frames.push(frame);
      const command = frame.command;
      if (command.method === 'mode.update') snapshot.settings = { ...snapshot.settings, mode: command.params.mode, revision: 'plan-settings' };
      const result = command.method === 'list' ? { conversations: [task], hasMore: false } : command.method === 'read' ? snapshot : command.method === 'mode.update' ? { settings: snapshot.settings } : {};
      socket.send(JSON.stringify({ type: 'result', id: frame.id, result }));
    });
  });
  await page.goto(origin); await page.getByRole('button', { name: task.title, exact: true }).click();
  await expect(page.locator('.message')).toHaveCount(count);
  return { frames, update: () => update() };
}

test('long-history scrolling has bounded layout reads and preserves the reading anchor on updates', async ({ page }, info) => {
  const f = await fixture(page);
  const metrics = await page.locator('.messages').evaluate(async box => {
    const original = Element.prototype.getBoundingClientRect; let reads = 0;
    Element.prototype.getBoundingClientRect = function () { if (this.hasAttribute('data-scroll-key')) reads++; return original.call(this); };
    try {
      const samples: number[] = [];
      for (let i = 0; i < 20; i++) {
        box.scrollTop = box.scrollHeight * (.65 + i / 1000);
        const start = performance.now(); box.dispatchEvent(new Event('scroll')); samples.push(performance.now() - start);
        await new Promise(requestAnimationFrame);
      }
      const top = original.call(box).top;
      const anchor = Array.from(box.querySelectorAll<HTMLElement>('[data-scroll-key]')).find(item => original.call(item).bottom > top + 1)!;
      return { readsPerScroll: reads / 20, maxHandlerMs: Math.max(...samples), key: anchor.dataset.scrollKey!, offset: original.call(anchor).top - top };
    } finally { Element.prototype.getBoundingClientRect = original; }
  });
  await info.attach('scroll-metrics', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
  await writeFile(info.outputPath('scroll-metrics.json'), JSON.stringify(metrics, null, 2));
  expect(metrics.readsPerScroll).toBeLessThan(25);
  f.update(); await expect(page.getByText('New output', { exact: false })).toBeAttached();
  await expect.poll(() => page.locator('.messages').evaluate((box, saved) => {
    const item = Array.from(box.querySelectorAll<HTMLElement>('[data-scroll-key]')).find(item => item.dataset.scrollKey === saved.key)!;
    return Math.abs(item.getBoundingClientRect().top - box.getBoundingClientRect().top - saved.offset);
  }, metrics)).toBeLessThan(3);
  await page.screenshot({ path: info.outputPath('long-history.png') });
});

test('composer refits wrapped drafts after width changes without losing text or the latest result', async ({ page }, info) => {
  await fixture(page, 30);
  const input = page.getByLabel('消息', { exact: true });
  const draft = 'Review this task and preserve the original request';
  await input.fill(draft);
  for (const [width, height] of [[320, 400], [390, 844], [320, 568]]) {
    await page.setViewportSize({ width, height });
    await expect.poll(() => input.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    await expect(input).toHaveValue(draft);
    await expect.poll(() => page.locator('.messages').evaluate(box => box.scrollHeight - box.clientHeight - box.scrollTop)).toBeLessThan(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`draft-${width}-${height}.png`) });
  }
});

test('enabling plan mode refits the narrower input and growing drafts keep the latest result visible', async ({ page }) => {
  const f = await fixture(page, 30);
  const input = page.getByLabel('消息', { exact: true });
  await input.fill('A request that wraps when plan mode reduces the input width');
  await page.getByTitle('添加照片、文件或计划模式', { exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: '计划模式', exact: true }).click();
  await expect(page.getByLabel('关闭计划模式', { exact: true })).toBeVisible();
  await expect.poll(() => input.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  await input.fill('First line\nSecond line\nThird line\nFourth line\nFifth line');
  await expect.poll(() => page.locator('.messages').evaluate(box => box.scrollHeight - box.clientHeight - box.scrollTop)).toBeLessThan(3);
  expect(f.frames.some(frame => ['send', 'stop'].includes(frame.command?.method))).toBe(false);
});

test('resizing the composer preserves older-message reading position and caps long drafts', async ({ page }) => {
  await fixture(page, 30);
  await page.locator('.messages').evaluate(box => { box.scrollTop = 600; box.dispatchEvent(new Event('scroll')); });
  const before = await page.locator('.messages').evaluate(box => box.scrollTop);
  const input = page.getByLabel('消息', { exact: true });
  await input.fill('Draft line\n'.repeat(20));
  await expect.poll(() => input.evaluate(element => element.clientHeight)).toBeLessThanOrEqual(160);
  await expect.poll(() => page.locator('.messages').evaluate(box => box.scrollTop)).toBe(before);
  await expect(page.getByTitle('回到最新消息', { exact: true })).toBeVisible();
  await input.fill('');
  await expect(input).toHaveCSS('height', '44px');
  await expect.poll(() => page.locator('.messages').evaluate(box => box.scrollTop)).toBe(before);
});

test('long-history updates and draft typing remain responsive without growing the message DOM', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const started = Date.now(); const f = await fixture(page);
  const initialMs = Date.now() - started, updates: number[] = [];
  for (let i = 1; i <= 12; i++) {
    const start = Date.now(); f.update();
    await expect(page.locator('.message.assistant').last()).toContainText(`New output ${i}`);
    updates.push(Date.now() - start);
  }
  const inputMs = await page.getByLabel('消息', { exact: true }).evaluate(async element => {
    const textarea = element as HTMLTextAreaElement, samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now(); textarea.value += 'Draft text '; textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      samples.push(performance.now() - start);
    }
    return samples;
  });
  updates.sort((a, b) => a - b); inputMs.sort((a, b) => a - b);
  const metrics = { messages: 500, initialMs, updates: updates.length, updateP95Ms: updates[Math.floor(updates.length * .95)], inputP95Ms: inputMs[Math.floor(inputMs.length * .95)], messageNodes: await page.locator('.message').count() };
  await writeFile(info.outputPath('render-metrics.json'), JSON.stringify(metrics, null, 2));
  await info.attach('render-metrics', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
  expect(metrics.updateP95Ms).toBeLessThan(1500); expect(metrics.inputP95Ms).toBeLessThan(1000);
  expect(metrics.messageNodes).toBe(500); expect(errors).toEqual([]);
});
