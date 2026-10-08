import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { releaseManifestSchema } from './updates.js';

export function validateRelease(value: unknown) {
  const manifest = releaseManifestSchema.parse(value);
  if (manifest.path !== '/api/updates/download/' + manifest.sha256) throw new Error('Invalid release path');
  return { manifest };
}
export async function fileDigest(path: string) { const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest('hex'); }
