import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { parse } from '@vue/compiler-sfc';

export default defineConfig({
  plugins: [{
    name: 'mobile-setup-tests', enforce: 'pre',
    transform(source, id) {
      if (!id.endsWith('.vue')) return;
      const { descriptor } = parse(source);
      if (descriptor.scriptSetup) return `<script setup lang="ts">${descriptor.scriptSetup.content}</script>`;
    }
  }, vue()],
  test: { include: ['tests/mobile-panel-races.vue-test.ts'], testTimeout: 15000, fileParallelism: false }
});
