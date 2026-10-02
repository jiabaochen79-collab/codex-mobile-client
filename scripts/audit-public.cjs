const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const allowed = /^(?:\.github\/|doc\/|installer\/|native\/|scripts\/|src\/(?:agent|shared)\/|src\/web-server\.ts$|tests\/|web\/|(?:\.dockerignore|\.gitattributes|\.gitignore|[A-Z][A-Z_\-.a-z]*\.md|LICENSE|NOTICE|contracts-manifest\.json|package(?:-lock)?\.json|tsconfig\.json|(?:vite|vitest)\.config\.ts)$)/;
const privatePath = /(?:^|\/)(?:deploy|secrets|data|relay|admin)(?:\/|$)|(?:^|\/)Admin[^/]*|\.(?:sqlite(?:-.*)?|db(?:-.*)?|pem|key|p12|pfx)$|(?:^|\/)\.env(?:\.|$)/i;
const secret = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/;
const relayImport = /(?:from\s*|import\s*\()\s*['"][^'"\n]*(?:\/relay\/|\/relay\.|\/deploy\/)/;
const git = args => execFileSync('git', args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const inspected = new Set();
function inspect(path, content) {
  if (!allowed.test(path) || privatePath.test(path)) throw new Error(`Private or unexpected repository path: ${path}`);
  if (content.includes(0)) return;
  const text = content.toString('utf8');
  if (secret.test(text)) throw new Error(`Potential credential in ${path}; value withheld.`);
  if (/\.(?:ts|js|cjs|mjs|vue)$/.test(path) && relayImport.test(text)) throw new Error(`Server import in ${path}`);
}
for (const path of git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString('utf8').split('\0').filter(Boolean)) {
  inspect(path, readFileSync(path));
}
const revisions = git(['rev-list', '--all']).toString('utf8').trim().split('\n').filter(Boolean);
for (const revision of revisions) {
  for (const entry of git(['ls-tree', '-rz', revision]).toString('utf8').split('\0').filter(Boolean)) {
    const [, mode, hash, path] = /^(\d+) blob ([a-f0-9]+)\t(.+)$/.exec(entry) ?? [];
    if (!path || !['100644', '100755'].includes(mode)) throw new Error('Linked or unexpected entry in public Git history.');
    if (!allowed.test(path) || privatePath.test(path)) throw new Error(`Private path in Git history: ${path}`);
    if (!inspected.has(hash)) { inspect(path, git(['cat-file', 'blob', hash])); inspected.add(hash); }
  }
}
console.log(`Public audit passed: ${revisions.length} commits, ${inspected.size} unique blobs; no server paths or known credential patterns found.`);
