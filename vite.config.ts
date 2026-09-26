import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({ plugins: [vue()], root: 'web', build: { outDir: '../dist/web', emptyOutDir: true, manifest: true } });
