// Push-only worker. It deliberately has no fetch handler or cache storage.
const PUSH_WORKER_VERSION = 'codex-mobile-push-v4';

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
  const status = payload.status === 'decision_required' ? '任务需要你确认或回复' : payload.status === 'failed' ? '任务执行异常' : payload.status === 'interrupted' ? '任务中断' : '任务已完成';
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
    const current = pages.filter(page => {
      const pageUrl = new URL(page.url);
      return pageUrl.origin === self.location.origin && pageUrl.pathname === '/' && 'focus' in page;
    }).sort((a, b) => Number(b.focused) - Number(a.focused))[0];
    if (current) {
      try {
        // A suspended page may hold attachments; never replace it without an acknowledgement.
        const channel = new MessageChannel();
        const handled = await new Promise(resolve => {
          const timer = setTimeout(() => resolve(false), 1000);
          channel.port1.onmessage = event => { clearTimeout(timer); resolve(event.data === 'notification.received'); };
          current.postMessage({ type: 'notification.open', url }, [channel.port2]);
        });
        channel.port1.close();
        if (!handled) {
          await self.clients.openWindow(url);
          return;
        }
        await current.focus();
        return;
      } catch { /* The page may have closed while the notification was tapped. */ }
    }
    await self.clients.openWindow(url);
  })());
});
