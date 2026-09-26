// Push-only worker. It deliberately has no fetch handler or cache storage.
const PUSH_WORKER_VERSION = 'codex-mobile-push-v1';

function localUrl(value) {
  if (typeof value !== 'string') return `${self.location.origin}/`;
  try { const url = new URL(value, self.location.origin); return url.origin === self.location.origin ? url.href : `${self.location.origin}/`; }
  catch { return `${self.location.origin}/`; }
}

self.addEventListener('install', event => {
  void PUSH_WORKER_VERSION;
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data?.json() ?? {}; } catch { payload = {}; }
  const status = payload.status === 'failed' ? '任务执行异常' : payload.status === 'interrupted' ? '任务中断' : '任务已完成';
  const occurredAt = Number(payload.occurredAt);
  const time = Number.isFinite(occurredAt) ? new Date(occurredAt).toLocaleString('zh-CN', { hour12: false }) : '';
  const url = localUrl(payload.url);
  const notificationId = typeof payload.notificationId === 'string' ? payload.notificationId : 'unknown';
  event.waitUntil(self.registration.showNotification(status, {
    body: time ? `${time} · 点击查看任务` : '点击查看任务',
    tag: `codex-notification-${notificationId}`,
    icon: '/brand.png',
    badge: '/brand.png',
    data: { url, notificationId }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = localUrl(event.notification.data?.url);
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const current = pages.find(page => 'focus' in page);
    if (current) {
      await current.focus();
      if ('navigate' in current && current.url !== url) await current.navigate(url);
      return;
    }
    await self.clients.openWindow(url);
  })());
});
