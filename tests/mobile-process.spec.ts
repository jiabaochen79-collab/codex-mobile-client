import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { Message, Snapshot } from '../src/shared/protocol';
import { mockPairedBrowser } from './paired-browser-fixture';

const webkit = process.env.TEST_BROWSER === 'webkit';
test.use({ browserName: webkit ? 'webkit' : 'chromium', viewport: { width: 390, height: 844 }, launchOptions: webkit ? {} : { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } });
const origin = 'http://127.0.0.1:18890';
const task = { id: '12345678-1234-4234-8234-123456789abc', title: '执行过程验收', cwd: 'C:/fixture', updatedAt: 1 };
const message = (id: string, role: Message['role'], text: string, rest: Partial<Message> = {}): Message => ({ id, role, text, turnId: 'turn-1', turnStatus: 'inProgress', ...rest });
const script = 'node scripts/check-layout.mjs\n' + 'Verify a deliberately long script without changing any files.\n'.repeat(12);

async function fixture(page: Page, options: { completed?: boolean; legacy?: boolean } = {}) {
  const snapshot: Snapshot = { ...task, epoch: 'fixture', busy: true, turnId: 'turn-1', hasMore: false, requests: [], settings: { model: 'fixture', effort: 'high', mode: 'default', permission: 'ask', revision: 'settings' }, messages: [
    message('u1', 'user', '请检查布局并给出结论。'),
    message('r0', 'assistant', 'Previous reasoning summary must not occupy the transcript.', { phase: 'reasoning' }),
    message('c1', 'assistant', '先检查当前布局。', { phase: 'commentary' }),
    message('t1', 'tool', script, { status: 'completed' }),
    message('t2', 'tool', 'git status', { status: 'completed' }),
    message('c2', 'assistant', '接着验证手机宽度。', { phase: 'commentary' }),
    message('r1', 'assistant', 'Another finished thinking summary.', { phase: 'reasoning' }),
    message('t3', 'tool', 'node scripts/build.mjs', { status: 'completed' }),
    message('t4', 'tool', 'node scripts/test-mobile-viewport.mjs ' + '--synthetic-only '.repeat(20), { status: 'inProgress' })
  ] };
  if (options.completed) finish(snapshot);
  if (options.legacy) for (const row of snapshot.messages) { delete row.turnId; delete row.turnStatus; if (row.phase === 'final' || row.phase === 'commentary') delete row.phase; }
  const commands: any[] = []; let update!: () => void;
  await mockPairedBrowser(page);
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { mode: 'mobile' } }));
  await page.route('**/api/notifications', route => route.fulfill({ json: { items: [], unread: 0 } }));
  const image = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#278f70' } }).png().toBuffer();
  await page.route('**/api/images/**', route => route.fulfill({ contentType: 'image/png', body: image }));
  await page.routeWebSocket('**/ws/mobile*', socket => {
    update = () => socket.send(JSON.stringify({ type: 'changed', conversationIds: [task.id] }));
    socket.send(JSON.stringify({ type: 'status', online: true, enabled: true, subscription: { access: true }, client: { available: true, capabilities: [] } }));
    socket.onMessage(raw => {
      const { id, command } = JSON.parse(String(raw)); commands.push(command);
      socket.send(JSON.stringify({ type: 'result', id, result: command.method === 'list' ? { conversations: [task], hasMore: false } : command.method === 'read' ? snapshot : {} }));
    });
  });
  await page.goto(origin); await page.getByRole('button', { name: task.title, exact: true }).click();
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible(); await expect(page.locator('.turn-process')).toBeVisible();
  return { snapshot, commands, update: () => update() };
}

function finish(snapshot: Snapshot) {
  snapshot.busy = false; snapshot.turnId = null;
  for (const row of snapshot.messages) { row.turnStatus = 'completed'; if (row.status === 'inProgress') row.status = 'completed'; }
  snapshot.messages.push(message('final', 'assistant', '结论：布局检查已完成，原有数据未改动。', { phase: 'final', turnStatus: 'completed' }));
}

test('folds command batches and shows only the current command while preserving independent details', async ({ page }, info) => {
  const f = await fixture(page); const process = page.locator('details.turn-process');
  await expect(process).toHaveAttribute('open', ''); await expect(process.locator('details.tool-batch')).toHaveCount(2);
  await expect(process.locator('.current-command')).toHaveCount(1); await expect(process.locator('.current-command')).toContainText('正在运行：node scripts/test-mobile-viewport.mjs');
  await expect(process.locator('.tool-step')).toHaveCount(1); await expect(process.locator('pre')).toBeHidden();
  await expect(process.getByText('Previous reasoning summary', { exact: false })).toHaveCount(0);
  await page.getByLabel('消息', { exact: true }).fill('保留未发送的草稿');
  for (const [width, height] of [[320, 568], [390, 844], [1280, 800], [390, 400]]) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(process.locator('.current-command .tool-summary')).toHaveCSS('white-space', 'nowrap');
    await page.screenshot({ path: info.outputPath(`running-${width}-${height}.png`) });
  }
  const first = process.locator('.tool-batch').first();
  await first.locator(':scope > summary').click(); await expect(first).toHaveAttribute('open', ''); await expect(first.locator('.tool-step')).toHaveCount(2);
  await first.locator('.tool-step').first().locator('summary').click(); await expect(first.locator('pre').first()).toHaveText(script);
  await first.locator('.tool-step').last().locator('summary').click(); await expect(first.locator('pre').last()).toHaveText('git status');
  f.update(); await expect(first).toHaveAttribute('open', '');
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('保留未发送的草稿');
  expect(f.commands.some(command => ['send', 'stop', 'respond'].includes(command.method))).toBe(false);
});

test('replaces the active command without exposing completed commands and collapses the whole round on completion', async ({ page }, info) => {
  const f = await fixture(page); const process = page.locator('details.turn-process');
  f.snapshot.messages.at(-1)!.status = 'completed';
  f.snapshot.messages.push(message('t5', 'tool', 'node scripts/next-check.mjs', { status: 'inProgress' })); f.update();
  await expect(process.locator('.current-command')).toHaveCount(1); await expect(process.locator('.current-command')).toContainText('正在运行：node scripts/next-check.mjs');
  await expect(process.locator('.tool-step')).toHaveCount(1);
  finish(f.snapshot); f.update();
  await expect(process).not.toHaveAttribute('open', ''); await expect(process.locator('.process-content')).toHaveCount(0);
  await expect(page.getByText('结论：布局检查已完成，原有数据未改动。', { exact: true })).toBeVisible();
  await expect(page.getByText('先检查当前布局。', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('completed-round.png') });
  await process.locator(':scope > summary').click(); await expect(process).toHaveAttribute('open', '');
  await expect(process.locator('.tool-batch')).toHaveCount(2); await expect(process.locator('.current-command')).toHaveCount(0);
  await expect(process.getByText('先检查当前布局。', { exact: true })).toBeVisible();
  await expect(process.locator('.thinking-row')).toHaveCount(0);
  f.update(); await expect(process).toHaveAttribute('open', '');
  await process.locator('.tool-batch').last().locator(':scope > summary').click(); await expect(process.locator('.tool-batch').last().locator('.tool-step')).toHaveCount(3);
});

test('shows thinking as a single temporary line and removes it when the next activity starts', async ({ page }, info) => {
  const f = await fixture(page); f.snapshot.messages = f.snapshot.messages.slice(0, 6);
  f.snapshot.messages.push(message('thinking', 'assistant', '正在核对手机布局。\n' + 'Only the public summary is displayed on one line. '.repeat(20), { phase: 'reasoning' })); f.update();
  const thinking = page.locator('.thinking-row'); await expect(thinking).toHaveCount(1); await expect(thinking.locator('span')).toHaveCSS('white-space', 'nowrap');
  await expect(page.locator('.reasoning-label')).toHaveCount(0); await page.screenshot({ path: info.outputPath('thinking-single-line.png') });
  f.snapshot.messages.push(message('c3', 'assistant', '核对完成，开始下一步。', { phase: 'commentary' })); f.update();
  await expect(thinking).toHaveCount(0); await expect(page.getByText('Only the public summary', { exact: false })).toHaveCount(0);
  finish(f.snapshot); f.update(); await page.locator('.turn-process > summary').click();
  await expect(thinking).toHaveCount(0); await expect(page.getByText('Only the public summary', { exact: false })).toHaveCount(0);
});

test('keeps failure reasons and approval requests visible outside collapsed process details', async ({ page }) => {
  const f = await fixture(page);
  f.snapshot.requests = [{ id: 'approval', kind: 'command', title: '执行命令', detail: '需要允许后才能执行。' }]; f.update();
  await expect(page.locator('.approval')).toContainText('需要允许后才能执行');
  await expect(page.locator('.turn-process > summary')).toContainText('等待确认');
  f.snapshot.busy = false; f.snapshot.turnId = null;
  for (const row of f.snapshot.messages) { row.turnStatus = 'failed'; row.turnReason = '模型服务暂时不可用'; }
  f.snapshot.messages.at(-1)!.status = 'failed'; f.update();
  await expect(page.locator('.turn-process')).not.toHaveAttribute('open', '');
  await expect(page.locator('.turn-outcome')).toHaveText('任务未完成：模型服务暂时不可用');
  await expect(page.locator('.turn-process > summary')).toContainText('失败'); await expect(page.locator('.approval')).toBeVisible();
  expect(f.commands.some(command => ['send', 'stop', 'respond'].includes(command.method))).toBe(false);
});

test('keeps user and result photos outside the folded process and exposes tool images only on demand', async ({ page }) => {
  const f = await fixture(page, { completed: true });
  f.snapshot.messages[0].images = [{ id: 'user-photo', alt: '用户照片' }];
  f.snapshot.messages.splice(-1, 0, message('view', 'tool', '查看图片', { turnStatus: 'completed', images: [{ id: 'tool-photo', alt: '过程照片' }] }));
  f.snapshot.messages.at(-1)!.images = [{ id: 'result-photo', alt: '结果照片' }]; f.update();
  await expect(page.getByRole('img', { name: '用户照片', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: '结果照片', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: '过程照片', exact: true })).toHaveCount(0);
  await page.locator('.turn-process > summary').click();
  const images = page.locator('.tool-batch').filter({ hasText: '已查看 1 张图像' }); await expect(images).toBeVisible();
  await images.locator(':scope > summary').click(); await expect(page.getByRole('img', { name: '过程照片', exact: true })).toBeVisible();
  await page.getByTitle('查看大图：过程照片', { exact: true }).click(); await expect(page.getByRole('dialog', { name: '图片预览', exact: true })).toBeVisible();
  await page.getByTitle('关闭图片', { exact: true }).click();
});

test('supports completed legacy history and keeps final answers visible with the process collapsed', async ({ page }) => {
  await fixture(page, { completed: true, legacy: true });
  await expect(page.locator('.turn-process')).not.toHaveAttribute('open', '');
  await expect(page.getByText('结论：布局检查已完成，原有数据未改动。', { exact: true })).toBeVisible();
  await page.locator('.turn-process > summary').click(); await expect(page.locator('.tool-batch')).toHaveCount(2);
});

test('folds the process when the final answer starts streaming without marking the task completed early', async ({ page }) => {
  const f = await fixture(page);
  f.snapshot.messages.push(message('stream', 'assistant', '正在输出结论', { phase: 'final' })); f.update();
  await expect(page.locator('.turn-process')).not.toHaveAttribute('open', '');
  await expect(page.locator('.turn-process > summary')).toContainText('正在整理答复');
  await expect(page.getByText('正在输出结论', { exact: true })).toBeVisible();
  await expect(page.getByTitle('停止当前生成', { exact: true })).toBeVisible();
  f.snapshot.messages.at(-1)!.text += '，验证通过。'; f.update();
  await expect(page.getByText('正在输出结论，验证通过。', { exact: true })).toBeVisible();
  await expect(page.locator('.turn-process')).not.toHaveAttribute('open', '');
});

test('keeps command batches independent across rounds and preserves a reading anchor during updates', async ({ page }) => {
  const f = await fixture(page, { completed: true });
  const history: Message[] = Array.from({ length: 12 }, (_, index) => [
    message(`user-${index}`, 'user', `较早的请求 ${index}`, { turnId: `history-${index}`, turnStatus: 'completed' }),
    message(`command-${index}`, 'tool', script, { turnId: `history-${index}`, turnStatus: 'completed', status: 'completed' }),
    message(`result-${index}`, 'assistant', `较早的结论 ${index}\n` + '这是用于验证阅读位置的独立测试记录。\n'.repeat(6), { turnId: `history-${index}`, turnStatus: 'completed', phase: 'final' })
  ]).flat();
  f.snapshot.messages.unshift(...history); f.update(); await expect(page.locator('.conversation-turn')).toHaveCount(13);
  await page.getByLabel('消息', { exact: true }).fill('跨轮次保留草稿');
  await page.locator('[data-scroll-key="message:result-3"]').scrollIntoViewIfNeeded();
  const before = await page.locator('[data-scroll-key="message:result-3"]').evaluate(element => element.getBoundingClientRect().top);
  f.snapshot.messages.at(-1)!.text += '\n后续结果。'; f.update();
  await expect(page.getByText('后续结果。', { exact: false })).toBeAttached();
  await expect.poll(() => page.locator('[data-scroll-key="message:result-3"]').evaluate((element, top) => Math.abs(element.getBoundingClientRect().top - top), before)).toBeLessThan(3);
  const round = page.locator('.conversation-turn').filter({ hasText: '较早的请求 3' });
  await round.locator('.turn-process > summary').focus(); await page.keyboard.press('Enter');
  await expect(round.locator('.turn-process')).toHaveAttribute('open', '');
  await round.locator('.tool-batch > summary').click(); await expect(round.locator('.tool-step')).toHaveCount(1);
  await expect(page.locator('.tool-step')).toHaveCount(1);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('跨轮次保留草稿');
  expect(f.commands.some(command => ['send', 'stop', 'respond'].includes(command.method))).toBe(false);
});

test('bounds the mounted command details for a large finished batch and tolerates rapid completion', async ({ page }) => {
  const f = await fixture(page);
  f.snapshot.messages = [f.snapshot.messages[0], ...Array.from({ length: 200 }, (_, index) => message(`large-${index}`, 'tool', `${script}\nCheck ${index}`, { status: index === 199 ? 'inProgress' : 'completed' }))]; f.update();
  await expect(page.locator('.tool-batch')).toHaveCount(1); await expect(page.locator('.tool-step')).toHaveCount(1);
  await expect(page.locator('.tool-batch > summary')).toContainText('199 项');
  finish(f.snapshot); f.update();
  await expect(page.locator('.turn-process')).not.toHaveAttribute('open', ''); await expect(page.locator('.tool-step')).toHaveCount(0);
  await expect(page.locator('.turn-process > summary')).toContainText('200 项操作');
  await page.locator('.turn-process > summary').click(); await page.locator('.tool-batch > summary').click();
  await expect(page.locator('.tool-step')).toHaveCount(200);
  await page.locator('.tool-batch > summary').click(); await expect(page.locator('.tool-step')).toHaveCount(0);
});
