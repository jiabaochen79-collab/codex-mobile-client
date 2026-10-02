import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const clientOutputs = new Set(['agent.mjs', 'updater.mjs', 'client-web-manifest.json', 'web']);
const privateOutput = /(?:^|\/)(?:relay|billing|admin)(?:[./-]|$)|\.(?:sqlite(?:-.*)?|db|pem|key|p12|pfx)$|(?:^|\/)\.env(?:\.|$)/i;

export function assertClientDist(root: string): void {
  const entries = readdirSync(root);
  if (entries.length !== clientOutputs.size || entries.some(name => !clientOutputs.has(name))) {
    throw new Error('Client dist must contain only agent.mjs, updater.mjs, client-web-manifest.json and web.');
  }
  function inspect(directory: string, prefix = ''): void {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || privateOutput.test(relative)) throw new Error(`Private or linked client output: ${relative}`);
      if (stat.isDirectory()) inspect(path, relative);
      else if (!stat.isFile()) throw new Error(`Unexpected client output: ${relative}`);
    }
  }
  inspect(root);
}
