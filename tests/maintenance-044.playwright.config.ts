import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const webkit = process.env.TEST_BROWSER === 'webkit';
export default defineConfig({
  testDir: '.', testMatch: 'maintenance-044.spec.ts', workers: 1, timeout: 20000, reporter: 'line', outputDir: '../.runtime/maintenance-044-browser/' + (webkit ? 'webkit' : 'chromium'),
  use: { headless: true, serviceWorkers: 'block', browserName: webkit ? 'webkit' : 'chromium', viewport: { width: 390, height: 844 }, launchOptions: webkit ? {} : { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } },
  webServer: { cwd: fileURLToPath(new URL('../', import.meta.url)), command: `"${process.execPath}" node_modules/vite/bin/vite.js --config tests/maintenance-044.vite.config.ts --host 127.0.0.1 --port 19976 --strictPort`, url: 'http://127.0.0.1:19976', reuseExistingServer: false }
});
