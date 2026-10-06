import { afterEach, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { NativeIpc } from '../src/agent/ipc.js';
import { UploadStore } from '../src/agent/uploads.js';
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); vi.restoreAllMocks(); });
it('IPC rejection exposes JSON-quoted credentials to the remote client', async () => {
  const ipc = new NativeIpc('fixture', true); cleanups.push(() => ipc.close());
  let request: any; (ipc as any).socket = { destroyed: false, writableLength: 0, write(bytes: Buffer) { request = JSON.parse(bytes.subarray(4).toString()); }, destroy() {} };
  const result = ipc.request('fixture', {}); const response = Buffer.from(JSON.stringify({ id: request.id, error: { message: 'Unable to parse configuration {"token":"fixture-secret","password":"fixture-password"}' } }));
  const header = Buffer.alloc(4); header.writeUInt32LE(response.length); (ipc as any).read(Buffer.concat([header, response]));
  const error = await result.catch(error => error);
  expect(error.message).toContain('[redacted]'); expect(error.message).not.toContain('fixture-secret'); expect(error.message).not.toContain('fixture-password');
});
it('closing IPC during connect leaves a live connection after close', async () => {
  const socket = Object.assign(new EventEmitter(), { destroyed: false, destroy() { socket.destroyed = true; socket.emit('close'); } });
  vi.spyOn(net, 'createConnection').mockReturnValue(socket as any);
  const ipc = new NativeIpc('fixture', true); cleanups.push(() => ipc.close());
  const connecting = ipc.connect(); const rejected = expect(connecting).rejects.toMatchObject({ code: 'UNAVAILABLE' }); ipc.close(); expect(socket.destroyed).toBe(true);
  socket.emit('connect'); await rejected; expect(ipc.connected).toBe(false);
});
it('an abandoned IPC handshake cannot close a replacement connection', async () => {
  const sockets = Array.from({ length: 2 }, () => {
    const socket = Object.assign(new EventEmitter(), { destroyed: false, destroy() { socket.destroyed = true; socket.emit('close'); } }); return socket;
  });
  vi.spyOn(net, 'createConnection').mockReturnValueOnce(sockets[0] as any).mockReturnValueOnce(sockets[1] as any);
  const ipc = new NativeIpc('fixture', true); cleanups.push(() => ipc.close());
  const abandoned = ipc.connect().catch(error => error); ipc.close();
  const replacement = ipc.connect(); sockets[1].emit('connect'); await replacement; await abandoned;
  expect(ipc.connected).toBe(true); expect(sockets[1].destroyed).toBe(false);
});
it('upload insert failure leaves an orphan folder and prevents same-ID retry', () => {
  const dir = mkdtempSync(join(process.cwd(), '.runtime/upload-')); const db = new DatabaseSync(':memory:'); cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const uploads = new UploadStore(dir, db); const id = randomUUID(); const params = { id: randomUUID(), name: 'fixture.txt', size: 10, sha256: 'a'.repeat(64), mediaType: 'text/plain' };
  db.exec("CREATE TRIGGER reject_upload BEFORE INSERT ON uploads BEGIN SELECT RAISE(ABORT,'fixture database failure'); END");
  expect(() => uploads.begin(id, 'owner', params)).toThrow('fixture database failure'); db.exec('DROP TRIGGER reject_upload'); uploads.cleanup();
  expect(existsSync(join(dir, 'attachments', id, 'upload.part'))).toBe(false); expect(uploads.begin(id, 'owner', params)).toMatchObject({ id, offset: 0 });
});
