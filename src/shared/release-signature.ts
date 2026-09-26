import { verify, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { releaseManifestSchema, signedReleaseSchema } from './updates.js';
import { RELEASE_PUBLIC_KEY } from './release-public-key.js';

export function verifyRelease(value: unknown, publicKey = RELEASE_PUBLIC_KEY) {
  const envelope = signedReleaseSchema.parse(value);
  if (!publicKey || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload) || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature)) throw new Error('Invalid release signature');
  const payload = Buffer.from(envelope.payload, 'base64');
  if (!verify(null, payload, publicKey, Buffer.from(envelope.signature, 'base64'))) throw new Error('Invalid release signature');
  const manifest = releaseManifestSchema.parse(JSON.parse(payload.toString('utf8')));
  if (manifest.path !== '/api/updates/download/' + manifest.sha256) throw new Error('Invalid release path');
  return { manifest, envelope };
}
export async function fileDigest(path: string) { const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest('hex'); }
