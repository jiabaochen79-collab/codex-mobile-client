import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.', testMatch: 'mobile-regressions.spec.ts', workers: 1, timeout: 20000, reporter: 'list',
  outputDir: '../.runtime/regressions-results', use: { serviceWorkers: 'block' },
  projects: ['chromium', 'webkit'].flatMap(browserName => [320, 390].map(width => ({
    name: `${browserName}-${width}`, use: { browserName: browserName as 'chromium' | 'webkit', viewport: { width, height: 844 }, launchOptions: browserName === 'chromium' ? { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : {} }
  }))),
  webServer: {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    command: `"${process.execPath}" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 18980 --strictPort`,
    url: 'http://127.0.0.1:18980', reuseExistingServer: false
  }
});
