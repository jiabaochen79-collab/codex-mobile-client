export async function pushRegistration(): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const existing = await navigator.serviceWorker.getRegistration();
        if (!existing?.active) await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
        return navigator.serviceWorker.ready;
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('系统通知组件尚未就绪，请稍后重试；站内提醒仍可查看。')), 5000); })
    ]);
  } finally { clearTimeout(timer); }
}
