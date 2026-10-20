import { defineConfig } from 'vitest/config';
import { mkdirSync } from 'node:fs';
mkdirSync(new URL('.runtime/', import.meta.url), { recursive: true });
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], testTimeout: 15000, hookTimeout: 20000, fileParallelism: false } });
