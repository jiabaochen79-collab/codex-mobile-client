import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.', testMatch: 'mobile-notifications.spec.ts', workers: 1,
  // Service Workers bypass Playwright's HTTP mocks in WebKit; worker behavior has separate tests.
  timeout: 15000, use: { viewport: { width: 390, height: 844 }, headless: true, serviceWorkers: 'block' },
  webServer: process.env.NOTIFICATION_TEST_ORIGIN ? undefined : {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    command: `"${process.execPath}" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 18920 --strictPort`,
    url: 'http://127.0.0.1:18920', reuseExistingServer: false
  }
});
