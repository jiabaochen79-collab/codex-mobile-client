import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.', testMatch: 'desktop-ui.spec.ts', workers: 1,
  timeout: 20000, use: { headless: true, serviceWorkers: 'block', browserName: process.env.TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium' },
  webServer: {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    command: `"${process.execPath}" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 18890 --strictPort`,
    url: 'http://127.0.0.1:18890', reuseExistingServer: false
  }
});
