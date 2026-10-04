import { test, expect, type Page } from '@playwright/test';
import { mockPairedBrowser } from './paired-browser-fixture';

const webkit = process.env.TEST_BROWSER === 'webkit';
test.use({ browserName: webkit ? 'webkit' : 'chromium', viewport: { width: 390, height: 844 }, launchOptions: webkit ? {} : { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } });
const origin = 'http://127.0.0.1:18890';
const first = { id: 'project-a', name: '第一个项目', path: 'C:/first', count: 40 };
const working = { id: 'project-b', name: '执行中的项目', path: 'C:/working', count: 1 };
const another = { id: 'project-c', name: '另一个执行项目', path: 'C:/another', count: 1 };
const task = (i: number, projectId: string, running = false) => ({ id: `${i.toString(16).padStart(8, '0')}-1234-4234-8234-123456789abc`, title: `任务 ${i}`, cwd: 'C:/fixture', projectId, updatedAt: i, running });

async function fixture(page: Page, active = true, holdNextPage = false, liveActivity = true) {
  let rows = [...Array.from({ length: 40 }, (_, i) => task(i, first.id)), task(40, working.id, active), task(41, another.id, active)];
  const calls: any[] = [];
  let releasePage: (() => void) | undefined;
  await page.addInitScript(() => {
    let visible = true; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' });
    (window as any).focusFixture = { visible(value: boolean) { visible = value; document.dispatchEvent(new Event('visibilitychange')); } };
  });
  await mockPairedBrowser(page);
  await page.routeWebSocket('**/ws/mobile*', socket => {
    socket.send(JSON.stringify({ type: 'status', online: true, enabled: true, client: { available: true, capabilities: ['project-navigation','activity', ...(liveActivity ? ['live-activity'] : [])] } }));
    socket.onMessage(raw => {
      const { id, command } = JSON.parse(String(raw)); calls.push(command); let result: any = {};
      if (command.method === 'projects') result = { projects: [first, working, another] };
      if (command.method === 'list') { const filtered = rows.filter(r => command.params.projectId === undefined || r.projectId === command.params.projectId); result = { conversations: filtered.slice(command.params.offset, command.params.offset + 30), hasMore: filtered.length > command.params.offset + 30 }; }
      if (command.method === 'activity') result = { activities: rows.filter(r => command.params.ids.includes(r.id)).map(r => ({ id: r.id, running: r.running, unread: false, completionId: '' })) };
      if (holdNextPage && command.method === 'list' && command.params.projectId === undefined && command.params.offset === 30) { holdNextPage = false; releasePage = () => socket.send(JSON.stringify({ type: 'result', id, result })); }
      else socket.send(JSON.stringify({ type: 'result', id, result }));
    });
  });
  await page.goto(origin); await expect(page.locator('.project-toggle').filter({ hasText: first.name })).toBeVisible();
  return { calls, release: () => releasePage?.(), changeRunning: (projectId: string) => { rows = rows.map(r => ({ ...r, running: r.projectId === projectId })); } };
}
const project = (page: Page, name: string) => page.locator('.project-toggle').filter({ hasText: name });
async function returnToPage(page: Page) { await page.evaluate(() => (window as any).focusFixture.visible(false)); await page.evaluate(() => (window as any).focusFixture.visible(true)); }

test('initial navigation opens all running projects beyond the first global page', async ({ page }, info) => {
  const f = await fixture(page);
  await expect(project(page, working.name)).toHaveAttribute('aria-expanded', 'true');
  await expect(project(page, another.name)).toHaveAttribute('aria-expanded', 'true');
  await expect(project(page, first.name)).toHaveAttribute('aria-expanded', 'false');
  expect(f.calls.some(c => c.method === 'list' && c.params.projectId === undefined && c.params.offset === 30)).toBe(true);
  expect(f.calls.some(c => c.method === 'read')).toBe(false);
  for (const width of [320,390,1280]) { await page.setViewportSize({ width, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: info.outputPath(`running-projects-${width}.png`) }); }
});

test('ordinary activity polling respects manually collapsed projects', async ({ page }) => {
  await page.clock.install();
  const f = await fixture(page); await expect(project(page, working.name)).toHaveAttribute('aria-expanded', 'true');
  await project(page, working.name).click(); const scans = f.calls.filter(c => c.method === 'list' && c.params.projectId === undefined).length;
  await expect(page.getByTitle('刷新列表', { exact: true })).toHaveCount(0); await page.clock.fastForward(5000);
  await expect(project(page, working.name)).toHaveAttribute('aria-expanded', 'false');
  expect(f.calls.filter(c => c.method === 'list' && c.params.projectId === undefined).length).toBe(scans);
});

test('returning to the page discovers newly running projects and reopens them', async ({ page }) => {
  const f = await fixture(page); await expect(project(page, working.name)).toHaveAttribute('aria-expanded', 'true');
  await project(page, working.name).click(); await returnToPage(page); await expect(project(page, working.name)).toHaveAttribute('aria-expanded', 'true');
  f.changeRunning(first.id); await returnToPage(page); await expect(project(page, first.name)).toHaveAttribute('aria-expanded', 'true');
  await expect(project(page, working.name)).toHaveAttribute('aria-expanded', 'false'); await expect(project(page, another.name)).toHaveAttribute('aria-expanded', 'false');
});

test('manual interaction during a pending scan wins over automatic expansion', async ({ page }) => {
  const f = await fixture(page, true, true);
  await expect.poll(() => f.calls.some(c => c.method === 'list' && c.params.projectId === undefined && c.params.offset === 30)).toBe(true);
  await project(page, working.name).click(); await project(page, working.name).click(); f.release();
  await expect(page.getByTitle('刷新列表', { exact: true })).toHaveCount(0);
  await expect(project(page, working.name)).toHaveAttribute('aria-expanded', 'false');
});

test('a scan started before suspension cannot overwrite the new foreground state', async ({ page }) => {
  const f = await fixture(page, true, true);
  await expect.poll(() => f.calls.some(c => c.method === 'list' && c.params.projectId === undefined && c.params.offset === 30)).toBe(true);
  f.changeRunning(first.id); await returnToPage(page); f.release();
  await expect(project(page, first.name)).toHaveAttribute('aria-expanded', 'true');
  await expect(project(page, working.name)).toHaveAttribute('aria-expanded', 'false'); await expect(project(page, another.name)).toHaveAttribute('aria-expanded', 'false');
});

test('without running tasks, projects stay collapsed unless the user opens them', async ({ page }) => {
  await fixture(page, false); await expect(page.getByTitle('刷新列表', { exact: true })).toHaveCount(0);
  await expect(project(page, first.name)).toHaveAttribute('aria-expanded', 'false');
  await project(page, first.name).click();
  await expect(project(page, first.name)).toHaveAttribute('aria-expanded', 'true'); await returnToPage(page); await expect(page.getByTitle('刷新列表', { exact: true })).toHaveCount(0);
  await expect(project(page, first.name)).toHaveAttribute('aria-expanded', 'true'); await project(page, first.name).click();
  await expect(project(page, first.name)).toHaveAttribute('aria-expanded', 'false'); await returnToPage(page);
  await expect(page.getByTitle('刷新列表', { exact: true })).toHaveCount(0); await expect(project(page, first.name)).toHaveAttribute('aria-expanded', 'false');
});

test('returning after all tasks stop closes only automatically opened projects', async ({ page }) => {
  const f = await fixture(page); await expect(project(page, working.name)).toHaveAttribute('aria-expanded', 'true');
  await project(page, first.name).click(); f.changeRunning('none'); await returnToPage(page);
  await expect(project(page, working.name)).toHaveAttribute('aria-expanded', 'false'); await expect(project(page, another.name)).toHaveAttribute('aria-expanded', 'false');
  await expect(project(page, first.name)).toHaveAttribute('aria-expanded', 'true');
});

test('legacy history-derived running flags do not trigger expansion or spinners', async ({ page }) => {
  const f = await fixture(page, true, false, false); await expect(page.getByTitle('刷新列表', { exact: true })).toHaveCount(0);
  await expect(project(page, working.name)).toHaveAttribute('aria-expanded', 'false');
  expect(f.calls.some(c => c.method === 'list' && c.params.projectId === undefined)).toBe(false);
  await expect(page.getByText('电脑助手需要更新', { exact: true })).toBeVisible(); await project(page, working.name).click();
  await expect(page.getByLabel('正在执行', { exact: true })).toHaveCount(0);
});
