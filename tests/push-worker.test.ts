import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const origin = 'https://remote.example.test';
const target = origin + '/?notification=11111111-1111-4111-8111-111111111111&notificationDevice=123456789';
function worker(pages: any[]) {
  const handlers: Record<string, (event: any) => void> = {};
  const openWindow = vi.fn(async () => null);
  const showNotification = vi.fn(async () => {});
  runInNewContext(readFileSync('web/public/sw.js', 'utf8'), {
    URL, Date, Number, setTimeout, clearTimeout, MessageChannel: class {
      port1 = { onmessage: null as any, close() {} };
      port2 = { postMessage: (data: any) => this.port1.onmessage?.({ data }) };
    },
    self: { location: { origin }, addEventListener: (name: string, handler: any) => { handlers[name] = handler; }, clients: { matchAll: async () => pages, openWindow }, registration: { showNotification } }
  });
  async function click(url = target) {
    let work: Promise<void> | undefined;
    handlers.notificationclick({ notification: { close() {}, data: { url } }, waitUntil: (value: Promise<void>) => { work = value; } });
    await work;
  }
  return { click, openWindow, showNotification, handlers };
}

it('delivers the task link to an existing web app before focusing it, without reloading drafts', async () => {
  const calls: string[] = [];
  const page = { url: origin + '/', postMessage: vi.fn((_data, ports) => { calls.push('message'); ports[0].postMessage('notification.received'); }), focus: vi.fn(async () => { calls.push('focus'); }), navigate: vi.fn() };
  const fixture = worker([page]); await fixture.click();
  expect(page.postMessage.mock.calls[0][0]).toEqual({ type: 'notification.open', url: target });
  expect(page.postMessage.mock.calls[0][1]).toHaveLength(1);
  expect(calls).toEqual(['message', 'focus']);
  expect(page.navigate).not.toHaveBeenCalled();
  expect(fixture.openWindow).not.toHaveBeenCalled();
});

it('opens the task link when no mobile web app is open, without replacing payment or admin pages', async () => {
  const page = { url: origin + '/admin/', focus: vi.fn(), navigate: vi.fn(), postMessage: vi.fn() };
  const fixture = worker([page]); await fixture.click();
  expect(fixture.openWindow).toHaveBeenCalledWith(target);
  expect(page.focus).not.toHaveBeenCalled();
});

it('falls back to opening the task link if an existing app cannot be focused', async () => {
  const fixture = worker([{ url: origin + '/', postMessage(_data: any, ports: any[]) { ports[0].postMessage('notification.received'); }, focus: async () => { throw new Error('Closed window'); } }]);
  await fixture.click(); expect(fixture.openWindow).toHaveBeenCalledWith(target);
});

it('navigates an older app before focusing it when there is no message acknowledgement', async () => {
  const calls: string[] = [];
  const page = { url: origin + '/', postMessage() {}, navigate: vi.fn(async () => { calls.push('navigate'); return page; }), focus: vi.fn(async () => { calls.push('focus'); }) };
  const fixture = worker([page]); await fixture.click();
  expect(page.navigate).toHaveBeenCalledWith(target);
  expect(calls).toEqual(['navigate', 'focus']); expect(fixture.openWindow).not.toHaveBeenCalled();
});

it('does not follow a notification link to another origin', async () => {
  const fixture = worker([]); await fixture.click('https://untrusted.example/');
  expect(fixture.openWindow).toHaveBeenCalledWith(origin + '/');
});
