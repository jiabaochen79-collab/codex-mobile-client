import { createPrivateKey, sign } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileDigest } from '../src/shared/release-signature.js';
import { releaseManifestSchema, signedReleaseSchema } from '../src/shared/updates.js';

const [version, sequenceText, packagePath, ...noteParts] = process.argv.slice(2);
if (!version || !sequenceText || !packagePath || !noteParts.length) {
  throw new Error('用法：node --import tsx scripts/sign-release.ts <version> <sequence> <installer.exe> <notes>');
}
const sequence = Number(sequenceText);
const file = resolve(packagePath);
const privateKeyPath = resolve(process.env.RELEASE_SIGNING_PRIVATE_KEY || '.runtime/release-signing-private.pem');
if (!existsSync(file)) throw new Error(`安装包不存在：${file}`);
if (!existsSync(privateKeyPath)) throw new Error(`发布私钥不存在：${privateKeyPath}`);
const size = statSync(file).size;
const sha256 = await fileDigest(file);
const manifest = releaseManifestSchema.parse({
  version,
  sequence,
  platform: 'win32-x64',
  size,
  sha256,
  path: '/api/updates/download/' + sha256,
  notes: noteParts.join(' ').trim(),
  issuedAt: Date.now()
});
const payload = Buffer.from(JSON.stringify(manifest));
const envelope = signedReleaseSchema.parse({
  payload: payload.toString('base64'),
  signature: sign(null, payload, createPrivateKey(readFileSync(privateKeyPath))).toString('base64')
});
process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
