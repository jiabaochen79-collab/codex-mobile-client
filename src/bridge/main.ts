import { main } from './runtime.js';
main().then(code => { process.exitCode = code; }).catch(error => { process.stderr.write(`Codex Mobile bridge: ${error?.code ?? error?.name ?? 'failure'}\n`); process.exitCode = 1; });
