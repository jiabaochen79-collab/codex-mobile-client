const { spawnSync } = require('node:child_process');
const node = process.env.npm_node_execpath || process.execPath;
const version = spawnSync(node, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout?.trim();
if (!version || Number(version.slice(1).split('.')[0]) < 22) { console.error('Node.js 22.13+ is required. Run npm using that Node installation.'); process.exit(1); }
const ts = (file) => ['--import', 'tsx', file];
const check = [['node_modules/vue-tsc/bin/vue-tsc.js', '--noEmit'], ['node_modules/typescript/bin/tsc', '--noEmit']];
const tasks = {
  check,
  build: [...check, ts('scripts/assets.ts'), ['node_modules/vite/bin/vite.js', 'build'], ts('scripts/build.ts')],
  native: [ts('scripts/native.ts')],
  installer: [ts('scripts/installer-windows.ts')],
  test: [['node_modules/vitest/vitest.mjs', 'run'], ['node_modules/vitest/vitest.mjs', 'run', '--config', 'tests/mobile-panel.vitest.config.ts', '--passWithNoTests']],
  agent: [ts('src/agent/main.ts')],
  package: [ts('scripts/package-windows.ts')], probe: [ts('scripts/probe-desktop.ts')]
};
const commands = tasks[process.argv[2]];
if (!commands) throw new Error('Unknown task');
for (const command of commands) { const result = spawnSync(node, [...command, ...process.argv.slice(3)], { stdio: 'inherit', windowsHide: true }); if (result.status !== 0) process.exit(result.status || 1); }
