import { main } from './runtime.js';
if (process.argv.length === 3 && process.argv[2] === '--codex-mobile-runtime-check') console.log('codex-mobile-bridge-v1');
else main().then(code => { process.exitCode = code; }).catch(error => { process.stderr.write(`Codex Mobile bridge: ${error?.code ?? error?.name ?? 'failure'}\n`); process.exitCode = 1; });
