import type { Page } from '@playwright/test';

export async function mockPairedBrowser(page: Page, deviceId = '123456789') {
  await page.route(/\/api\/paired-devices(?:\/restore)?$/, route => route.fulfill({ json: { devices: [{ deviceId, name: '', lastUsed: 1, expires: Date.now() + 30 * 86400000, remembered: true, authorized: true, online: true, enabled: true }] } }));
}
