import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const webkit = process.env.TEST_BROWSER === 'webkit';
process.env.PLAN_WEB_ORIGIN = 'http://127.0.0.1:19975';
export default defineConfig({
  testDir: '.', testMatch: ['audit-races.spec.ts', 'mobile-plan.spec.ts', 'mobile-network.spec.ts', 'mobile-feedback-recovery.spec.ts', 'recovery-races.spec.ts', 'review-regressions.spec.ts', 'maintenance-regressions.spec.ts', 'desktop-ui.spec.ts', 'maintenance-035.spec.ts', 'maintenance-036.spec.ts', 'maintenance-037.spec.ts', 'maintenance-038.spec.ts', 'maintenance-039.spec.ts', 'maintenance-040.spec.ts'],
  workers: 1, timeout: 20000, reporter: 'line', outputDir: '../.runtime/audit-fixes-0.4.31-results/' + (webkit ? 'webkit' : 'chromium'),
  use: { headless: true, serviceWorkers: 'block', browserName: webkit ? 'webkit' : 'chromium', viewport: { width: 390, height: 844 }, launchOptions: webkit ? {} : { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } },
  webServer: {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    command: `"${process.execPath}" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 19975 --strictPort`,
    url: 'http://127.0.0.1:19975', reuseExistingServer: false
  }
});
