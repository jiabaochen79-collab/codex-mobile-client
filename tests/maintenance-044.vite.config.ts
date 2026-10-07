import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({ plugins: [vue()], root: 'web', define: { 'import.meta.env.PROD': 'true' } });
