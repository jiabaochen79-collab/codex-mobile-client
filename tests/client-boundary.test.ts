import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertClientDist } from '../scripts/client-boundary.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function artifact(): string {
  const root = mkdtempSync(join(tmpdir(), 'client-boundary-')); roots.push(root);
  for (const name of ['agent.mjs', 'updater.mjs', 'client-web-manifest.json']) writeFileSync(join(root, name), '');
  mkdirSync(join(root, 'web')); writeFileSync(join(root, 'web', 'index.html'), '');
  return root;
}

describe('public client artifacts', () => {
  it('accepts the client build', () => { expect(() => assertClientDist(artifact())).not.toThrow(); });
  it('rejects residual relay bundles', () => {
    const root = artifact(); writeFileSync(join(root, 'relay.mjs'), '');
    expect(() => assertClientDist(root)).toThrow('Client dist must contain only');
  });
  it('rejects private files nested in web assets', () => {
    const root = artifact(); mkdirSync(join(root, 'web', 'assets')); writeFileSync(join(root, 'web', 'assets', 'merchant.pem'), '');
    expect(() => assertClientDist(root)).toThrow('Private or linked client output');
  });
});
