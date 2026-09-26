import { z } from 'zod';
import { MAX_UPLOAD_CHUNK, uid } from './protocol.js';
const headerSchema = z.object({ type: z.literal('upload-chunk'), id: uid, sessionId: uid, clientId: uid, controlEpoch: uid, attachmentId: uid, offset: z.number().int().min(0).max(25 * 1024 * 1024) }).strict();
export type UploadHeader = z.infer<typeof headerSchema>;
export function uploadFrame(header: UploadHeader, bytes: Buffer) {
  const json = Buffer.from(JSON.stringify(headerSchema.parse(header))); const size = Buffer.alloc(4); size.writeUInt32LE(json.length);
  return Buffer.concat([size, json, bytes]);
}
export function parseUploadFrame(frame: Buffer) {
  if (frame.length < 5) throw new Error('Invalid upload frame');
  const size = frame.readUInt32LE();
  if (size > 2048 || size + 4 >= frame.length || frame.length - size - 4 > MAX_UPLOAD_CHUNK) throw new Error('Invalid upload size');
  return { header: headerSchema.parse(JSON.parse(frame.subarray(4,4+size).toString('utf8'))), bytes: frame.subarray(4+size) };
}
