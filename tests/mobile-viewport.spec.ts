import { test, expect, type Page } from '@playwright/test';
import { mockPairedBrowser } from './paired-browser-fixture';

const webkit = process.env.TEST_BROWSER === 'webkit';
test.use({ browserName: webkit ? 'webkit' : 'chromium', viewport: { width: 390, height: 844 }, launchOptions: webkit ? {} : { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } });
const origin = process.env.VIEWPORT_WEB_ORIGIN ?? 'http://127.0.0.1:18890';
const conversation = { id: '12345678-1234-4234-8234-123456789abc', title: '视口恢复验收', cwd: 'C:/fixture', updatedAt: 1 };

async function fixture(page: Page, openConversation = true) {
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { height: innerHeight, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    let visible = true;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => !visible });
    (window as any).viewportFixture = {
      metrics(value: object, event?: string) { Object.assign(viewport, value); if (event) viewport.dispatchEvent(new Event(event)); },
      visible(value: boolean) { visible = value; document.dispatchEvent(new Event('visibilitychange')); }
    };
  });
  await mockPairedBrowser(page);
  await page.routeWebSocket('**/ws/mobile*', socket => {
    socket.send(JSON.stringify({ type: 'status', online: true, enabled: true, client: { available: true } }));
    socket.onMessage(raw => {
      const { id, command } = JSON.parse(String(raw));
      const rows = openConversation ? [conversation] : [conversation, ...Array.from({ length: 29 }, (_, i) => ({ ...conversation, id: `${i.toString(16).padStart(8, '0')}-1234-4234-8234-123456789abc`, title: `导航记录 ${i + 1}` }))];
      const result = command.method === 'list' ? { conversations: rows, hasMore: false } : { ...conversation, epoch: 'fixture', busy: false, turnId: null, hasMore: false, requests: [], messages: Array.from({ length: 35 }, (_, i) => ({ id: `message-${i}`, role: i % 2 ? 'assistant' : 'user', text: `第 ${i + 1} 条记录\n` + '用于检查恢复视口后的阅读位置。'.repeat(8) })) };
      socket.send(JSON.stringify({ type: 'result', id, result }));
    });
  });
  await page.goto(origin);
  if (openConversation) { await page.getByRole('button', { name: conversation.title, exact: true }).click(); await expect(page.getByLabel('消息', { exact: true })).toBeVisible(); }
  else await expect(page.getByRole('button', { name: conversation.title, exact: true })).toBeVisible();
}
async function metrics(page: Page, value: object, event?: string) { await page.evaluate(({ value, event }) => (window as any).viewportFixture.metrics(value, event), { value, event }); }
async function visible(page: Page, value: boolean) { await page.evaluate(value => (window as any).viewportFixture.visible(value), value); }
const bounds = (page: Page) => page.locator('.mobile-shell').evaluate(element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height }; });

async function strandFixedLayer(page: Page, offset = 96) {
  // Model WebKit's displaced fixed-position origin separately from viewport heights.
  await page.addStyleTag({ content: `.mobile-shell.authenticated { translate: 0 -${offset}px; }` });
  await metrics(page, { height: 548, offsetTop: offset });
}

test('repairs a stranded horizontal origin on the project home page', async ({ page }) => {
  await fixture(page, false);
  await page.addStyleTag({ content: '.mobile-shell.authenticated { translate: -96px 0; }' });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await expect.poll(async () => (await bounds(page)).left).toBe(0);
  await expect.poll(async () => (await bounds(page)).right).toBe(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await page.locator('.navigation-footer').boundingBox())!.x).toBe(0);
});

test('keeps a restored shell at the dynamic viewport floor when a cached pixel height is short', async ({ page }) => {
  await fixture(page, false);
  await page.locator('.mobile-shell.authenticated').evaluate(element => element.style.setProperty('--chat-viewport', '548px'));
  await expect.poll(async () => (await bounds(page)).bottom).toBe(844);
  await expect.poll(async () => (await bounds(page)).height).toBe(844);
});

test('drops a stale keyboard viewport after a page is backgrounded and keeps the draft', async ({ page }) => {
  await fixture(page); await page.getByLabel('消息', { exact: true }).fill('后台恢复草稿');
  await page.getByLabel('消息', { exact: true }).focus(); await metrics(page, { height: 500, offsetTop: 24 }, 'resize');
  await expect(page.locator('.mobile-shell')).toHaveClass(/keyboard-open/);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await metrics(page, { height: 500, offsetTop: 24 }); await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect.poll(async () => (await bounds(page)).bottom).toBe(844);
  await expect(page.locator('.mobile-shell')).not.toHaveClass(/keyboard-open/);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('后台恢复草稿');
});

test('contains long markdown content inside the mobile transcript', async ({ page }) => {
  await fixture(page);
  await page.locator('.prose').first().evaluate(element => {
    element.innerHTML = [
      '<p>相关文件： <a href="#">conversation-model.ts</a>、 <a href="#">MobilePanel.vue</a></p>',
      '<p>https://remote.chatgptvip.asia/very-long-path-without-breaks-abcdefghijklmnopqrstuvwxyz-0123456789</p>',
      '<p><code>conversation-model.ts______________________________long-file-name________________________________</code></p>',
      '<pre><code>const longFileName = "conversation-model.ts______________________________long-file-name________________________________";</code></pre>',
      '<table><tbody><tr><th>文件</th><th>说明</th></tr><tr><td>conversation-model.ts______________________________long-file-name________________________________</td><td>https://remote.chatgptvip.asia/very-long-path-without-breaks-abcdefghijklmnopqrstuvwxyz-0123456789</td></tr></tbody></table>'
    ].join('');
  });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = await page.locator('.prose').first().evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, viewport: innerWidth };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
  }
  expect(await page.evaluate(() => ({ html: getComputedStyle(document.documentElement).overflowX, body: getComputedStyle(document.body).overflowX, app: getComputedStyle(document.querySelector('#app')!).overflowX }))).toMatchObject({ html: expect.stringMatching(/hidden|clip/), body: expect.stringMatching(/hidden|clip/), app: expect.stringMatching(/hidden|clip/) });
});

test('repairs a stranded fixed layer even when window scroll and viewport height remain correct', async ({ page }, info) => {
  await fixture(page, false); await page.locator('.navigation-scroll').evaluate(element => { element.scrollTop = 120; });
  await visible(page, false); await strandFixedLayer(page); await visible(page, true);
  await page.screenshot({ path: info.outputPath('fixed-origin-before-check.png') });
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await expect.poll(async () => (await bounds(page)).top).toBe(0);
  await expect.poll(async () => (await bounds(page)).bottom).toBe(844);
  await expect(page.getByRole('heading', { name: '项目与会话', exact: true })).toBeInViewport();
  expect(await page.locator('.navigation-scroll').evaluate(element => element.scrollTop)).toBe(120);
  const footer = page.locator('.navigation-footer');
  expect(await footer.evaluate(element => { const r = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(r.x + 5, r.bottom - 3)); })).toBe(true);
  await page.waitForTimeout(2200); expect((await bounds(page)).top).toBe(0);
  await page.screenshot({ path: info.outputPath('fixed-origin-recovered.png') });
});

test('corrects and releases a silent fixed-origin displacement without losing a reading anchor or draft', async ({ page }) => {
  await fixture(page); await page.getByLabel('消息', { exact: true }).fill('origin recovery draft'); await page.getByLabel('消息', { exact: true }).blur();
  await page.locator('.messages').evaluate(element => { element.scrollTop = 600; element.dispatchEvent(new Event('scroll')); });
  const before = await page.locator('.messages').evaluate(element => element.scrollTop);
  await visible(page, false); await visible(page, true); await page.waitForTimeout(1000);
  await strandFixedLayer(page); await expect.poll(async () => (await bounds(page)).bottom).toBe(844);
  expect(Math.abs(await page.locator('.messages').evaluate(element => element.scrollTop) - before)).toBeLessThan(3);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('origin recovery draft');
  await page.addStyleTag({ content: '.mobile-shell.authenticated { translate: none; }' }); await metrics(page, { height: 844, offsetTop: 0 });
  await expect.poll(async () => (await bounds(page)).top).toBe(0);
  await expect.poll(async () => (await bounds(page)).bottom).toBe(844);
});

test('corrects a fixed-origin displacement on cold reload after remembered authentication', async ({ page }) => {
  await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style'); style.textContent = '.mobile-shell.authenticated { translate: 0 -96px; }'; document.head.append(style);
  }));
  await fixture(page, false); await page.reload();
  await expect.poll(async () => (await bounds(page)).top).toBe(0);
  await expect.poll(async () => (await bounds(page)).bottom).toBe(844);
  expect(await page.evaluate(() => getComputedStyle(document.body).position)).not.toBe('fixed');
});

test('disables scroll restoration before the application bundle has loaded', async ({ page }) => {
  await page.addInitScript(() => { history.scrollRestoration = 'auto'; });
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  await page.route('**/assets/index-*.js', async route => { await gate; await route.continue(); });
  try {
    await page.goto(origin, { waitUntil: 'commit' });
    await expect.poll(() => page.evaluate(() => history.scrollRestoration)).toBe('manual');
    expect(await page.locator('#app').textContent()).toBe('');
  } finally { release(); }
});

test('does not carry a recovery correction into keyboard panning or pinch zoom', async ({ page }) => {
  await fixture(page); await strandFixedLayer(page); await expect.poll(async () => (await bounds(page)).top).toBe(0);
  await page.addStyleTag({ content: '.mobile-shell.authenticated { translate: none; }' });
  await page.getByLabel('消息', { exact: true }).focus(); await metrics(page, { height: 500, offsetTop: 24 }, 'resize');
  await expect.poll(async () => (await bounds(page)).bottom).toBe(524);
  expect(await page.locator('.mobile-shell').evaluate(element => element.style.getPropertyValue('--chat-origin-correction'))).toBe('0px');
  await metrics(page, { height: 422, offsetTop: 60, scale: 2 }, 'resize');
  await expect.poll(async () => (await bounds(page)).height).toBe(844);
  await expect(page.locator('.mobile-shell')).not.toHaveClass(/keyboard-open/);
  await metrics(page, { height: 844, offsetTop: 0, scale: 1 }, 'resize');
  await expect.poll(async () => (await bounds(page)).bottom).toBe(844);
});

async function staleDynamicHeight(page: Page, height: number) {
  // Model a browser retaining the old dvh length, not a native iPhone reproduction.
  await page.addStyleTag({ content: `.mobile-shell.authenticated[style*="100dvh"], [data-viewport-probe] { height: ${height}px !important; }` });
}

test('expands a restored layout when visualViewport recovers before window height and CSS', async ({ page }) => {
  await fixture(page, false); await staleDynamicHeight(page, 548);
  await page.evaluate(() => { Object.defineProperty(window, 'innerHeight', { configurable: true, value: 548 }); });
  await visible(page, false); await visible(page, true);
  await expect.poll(async () => (await bounds(page)).bottom).toBe(844);
});

test('fills the measured viewport when CSS dvh stays at its pre-reload height', async ({ page }, info) => {
  await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style'); style.textContent = '.mobile-shell.authenticated[style*="100dvh"], [data-viewport-probe] { height: 548px !important; }'; document.head.append(style);
  }));
  await fixture(page, false); await page.reload();
  await expect(page.getByRole('heading', { name: '项目与会话', exact: true })).toBeVisible();
  await expect.poll(async () => (await bounds(page)).height).toBe(844);
  expect((await page.locator('.navigation-footer').boundingBox())!.y + (await page.locator('.navigation-footer').boundingBox())!.height).toBe(844);
  await page.screenshot({ path: info.outputPath('stale-dvh-recovered.png') });
});

test('keeps viewport recovery internal without exposing layout diagnostics', async ({ page }, info) => {
  await fixture(page); await staleDynamicHeight(page, 548); await page.evaluate(() => { for (let i = 0; i < 65; i++) window.dispatchEvent(new Event('resize')); });
  await expect.poll(async () => (await bounds(page)).bottom).toBe(844);
  await page.getByTitle('切换电脑', { exact: true }).click();
  await expect(page.getByTitle('页面布局诊断', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '页面布局诊断', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('device-directory-without-diagnostics.png') });
});

test('recovers a late silent viewport correction after the restore timers and preserves the draft', async ({ page }) => {
  await fixture(page); await page.getByLabel('消息', { exact: true }).fill('迟到的视口恢复仍保留草稿');
  await page.getByLabel('消息', { exact: true }).blur(); await staleDynamicHeight(page, 548);
  await page.evaluate(() => { Object.defineProperty(window, 'innerHeight', { configurable: true, value: 548 }); (window as any).viewportFixture.metrics({ height: 548, offsetTop: 0 }); });
  await visible(page, false); await visible(page, true); await page.waitForTimeout(2200);
  await page.evaluate(() => { Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 }); (window as any).viewportFixture.metrics({ height: 844, offsetTop: 0 }); });
  await expect.poll(async () => (await bounds(page)).bottom, { timeout: 2500 }).toBe(844);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('迟到的视口恢复仍保留草稿');
});

test('aligns with an agreed visual viewport offset even when the keyboard is not focused', async ({ page }) => {
  await fixture(page, false);
  await page.evaluate(() => { Object.defineProperty(window, 'innerHeight', { configurable: true, value: 748 }); (window as any).viewportFixture.metrics({ height: 748, offsetTop: 96 }, 'resize'); });
  await expect.poll(async () => (await bounds(page)).top).toBe(96);
  await expect.poll(async () => (await bounds(page)).height).toBe(748);
  expect((await page.locator('.navigation-footer').boundingBox())!.y + (await page.locator('.navigation-footer').boundingBox())!.height).toBe(844);
});

test('does not measure a suspended page and resumes sampling on return', async ({ page }) => {
  await fixture(page, false); await visible(page, false);
  await page.evaluate(() => { const viewport = window.visualViewport!; const height = viewport.height; (window as any).viewportReads = 0; Object.defineProperty(viewport, 'height', { configurable: true, get() { (window as any).viewportReads++; return height; } }); });
  await page.waitForTimeout(1250); expect(await page.evaluate(() => (window as any).viewportReads)).toBe(0);
  await visible(page, true); await expect.poll(() => page.evaluate(() => (window as any).viewportReads)).toBeGreaterThan(0);
});

test('project navigation stays pinned when the browser retains a document scroll offset', async ({ page }) => {
  await fixture(page, false);
  // Simulate the extra root scroll range left behind by an iOS keyboard/browser transition.
  await page.evaluate(() => { document.documentElement.style.minHeight = `${innerHeight + 240}px`; window.scrollTo(0, 90); });
  expect((await bounds(page)).top).toBe(0); expect((await bounds(page)).bottom).toBe(844);
  expect((await page.locator('.navigation-footer').boundingBox())!.y + (await page.locator('.navigation-footer').boundingBox())!.height).toBe(844);
});

test('clears a late document scroll after the initial viewport recovery timers have finished', async ({ page }, info) => {
  await fixture(page, false);
  await page.locator('.navigation-scroll').evaluate(element => { element.scrollTop = 240; });
  const position = await page.locator('.navigation-scroll').evaluate(element => element.scrollTop);
  await page.waitForTimeout(1000);
  await page.evaluate(() => { document.documentElement.style.minHeight = `${innerHeight + 240}px`; window.scrollTo(0, 96); });
  await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 2000 }).toBe(0);
  await expect(page.getByRole('heading', { name: '项目与会话', exact: true })).toBeInViewport();
  expect(await page.locator('.navigation-scroll').evaluate(element => element.scrollTop)).toBe(position);
  expect((await page.locator('.navigation-footer').boundingBox())!.y + (await page.locator('.navigation-footer').boundingBox())!.height).toBe(844);
  await page.screenshot({ path: info.outputPath('late-root-scroll-recovered.png') });
});

test('disables native document scroll restoration before delayed authentication on a cold reload', async ({ page }) => {
  await fixture(page, false);
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  await page.route('**/api/paired-devices/restore', async route => {
    await gate;
    await route.fulfill({ json: { devices: [{ deviceId: '123456789', name: '', lastUsed: 1, expires: Date.now() + 86400000, remembered: true, authorized: true, online: true, enabled: true }] } });
  });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText('正在恢复连接', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => history.scrollRestoration)).toBe('manual');
    release(); await expect(page.getByRole('heading', { name: '项目与会话', exact: true })).toBeVisible();
    expect(await page.evaluate(() => ({ position: getComputedStyle(document.body).position, overflow: getComputedStyle(document.documentElement).overflowY }))).toEqual({ position: 'static', overflow: 'hidden' });
    expect((await bounds(page)).top).toBe(0); expect((await bounds(page)).bottom).toBe(844);
  } finally { release(); }
});

test('keeps the unauthenticated login page scrollable on a short phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 }); await page.goto(origin);
  await expect(page.getByLabel('设备 ID', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).position)).not.toBe('fixed');
  await page.getByRole('button', { name: '订阅与权益', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '订阅与权益', exact: true })).toBeInViewport();
});

test('project navigation clears stale page scrolling on resume without losing list position', async ({ page }, info) => {
  await fixture(page, false);
  await page.locator('.navigation-scroll').evaluate(element => { element.scrollTop = 240; });
  const position = await page.locator('.navigation-scroll').evaluate(element => element.scrollTop);
  await visible(page, false);
  await page.evaluate(() => { document.documentElement.style.minHeight = `${innerHeight + 240}px`; window.scrollTo(0, 90); });
  await metrics(page, { height: 740, offsetTop: 0 }); await visible(page, true);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect.poll(async () => (await bounds(page)).bottom).toBe(844);
  await expect(page.getByRole('heading', { name: '项目与会话', exact: true })).toBeInViewport();
  expect(await page.locator('.navigation-scroll').evaluate(element => element.scrollTop)).toBe(position);
  await page.screenshot({ path: info.outputPath('navigation-resumed-390.png') });
});

test('project search retains its draft and follows keyboard and bfcache viewport recovery', async ({ page }) => {
  await fixture(page, false); await page.getByLabel('搜索会话', { exact: true }).fill('导航');
  await metrics(page, { height: 500, offsetTop: 24 }, 'resize');
  await expect.poll(async () => (await bounds(page)).bottom).toBe(524);
  await visible(page, false); await metrics(page, { height: 844, offsetTop: 0 }); await visible(page, true);
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await expect.poll(async () => (await bounds(page)).bottom).toBe(844);
  await expect(page.getByLabel('搜索会话', { exact: true })).toHaveValue('导航');
  for (const width of [320,390,1280]) { await page.setViewportSize({ width, height: 844 }); await expect.poll(async () => (await bounds(page)).bottom).toBe(844); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
});

test('resumes from a cached keyboard height without a resize event and preserves the draft', async ({ page }, info) => {
  await fixture(page); await page.getByLabel('消息', { exact: true }).fill('切回后保留的草稿');
  await metrics(page, { height: 500, offsetTop: 36 }, 'resize'); await expect.poll(async () => (await bounds(page)).height).toBe(500);
  await visible(page, false); await metrics(page, { height: 844, offsetTop: 0 }); await visible(page, true);
  await expect.poll(async () => (await bounds(page)).bottom).toBe(844); await expect.poll(async () => (await bounds(page)).top).toBe(0);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('切回后保留的草稿');
  await expect(page.locator('.mobile-shell')).not.toHaveClass(/keyboard-open/);
  await page.screenshot({ path: info.outputPath('foreground-restored.png') });
});
test('remeasures after delayed browser viewport recovery even without a second event', async ({ page }) => {
  await fixture(page); await page.getByLabel('消息', { exact: true }).focus();
  await metrics(page, { height: 500, offsetTop: 20 }, 'resize'); await visible(page, false); await visible(page, true);
  await page.evaluate(() => { setTimeout(() => (window as any).viewportFixture.metrics({ height: innerHeight, offsetTop: 0 }), 180); });
  await expect.poll(async () => (await bounds(page)).bottom).toBe(844); await expect(page.locator('.mobile-shell')).not.toHaveClass(/keyboard-open/);
});
test('pageshow and window focus restore layout without jumping away from older messages', async ({ page }) => {
  await fixture(page); await page.locator('.messages').evaluate(element => { element.scrollTop = 600; element.dispatchEvent(new Event('scroll')); });
  await expect(page.getByTitle('回到最新消息', { exact: true })).toBeVisible();
  const before = await page.locator('.messages').evaluate(element => element.scrollTop);
  await metrics(page, { height: 680, offsetTop: 0 }, 'resize');
  await metrics(page, { height: 844, offsetTop: 0 }); await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect.poll(async () => (await bounds(page)).bottom).toBe(844);
  await metrics(page, { height: 844, offsetTop: 0 }); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByTitle('回到最新消息', { exact: true })).toBeVisible();
  expect(Math.abs(await page.locator('.messages').evaluate(element => element.scrollTop) - before)).toBeLessThan(3);
});
test('ignores stale visual viewport gaps without an editable focus and does not mistake zoom for the keyboard', async ({ page }) => {
  await fixture(page); await metrics(page, { height: 720, offsetTop: 34 }, 'resize');
  await expect.poll(async () => (await bounds(page)).bottom).toBe(844); await expect.poll(async () => (await bounds(page)).top).toBe(0);
  await page.getByLabel('消息', { exact: true }).focus(); await metrics(page, { height: 422, offsetTop: 60, scale: 2 }, 'resize');
  await expect.poll(async () => (await bounds(page)).height).toBe(844); await expect(page.locator('.mobile-shell')).not.toHaveClass(/keyboard-open/);
});
test('keeps the composer above a real keyboard after resuming and restores full height when it closes', async ({ page }, info) => {
  await fixture(page); await page.getByLabel('消息', { exact: true }).focus(); await metrics(page, { height: 500, offsetTop: 24 }, 'resize');
  await visible(page, false); await visible(page, true);
  await expect.poll(async () => (await bounds(page)).bottom).toBe(524); await expect(page.locator('.mobile-shell')).toHaveClass(/keyboard-open/);
  const composer = await page.locator('.compact-composer').boundingBox(); expect(composer!.y + composer!.height).toBeLessThanOrEqual(525);
  await metrics(page, { height: 844, offsetTop: 0 }, 'resize'); await expect.poll(async () => (await bounds(page)).bottom).toBe(844);
  for (const [width, height] of [[320,568],[390,844],[1280,900]]) { await page.setViewportSize({ width, height }); await metrics(page, { height, offsetTop: 0 }, 'resize'); await expect.poll(async () => Math.round((await bounds(page)).bottom)).toBe(height); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: info.outputPath(`restored-${width}.png`) }); }
});
