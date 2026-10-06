import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, statfsSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { MAX_ATTACHMENT_TOTAL, MAX_FILE_SIZE, MAX_UPLOAD_CHUNK, RemoteError, type Attachment, type LocalAttachment } from '../shared/protocol.js';

type Upload = { id: string; owner: string; conversation: string; name: string; size: number; sha256: string; mediaType: string; offset: number; ready: number; committed: number; created: number };
export function validateFilename(name: string) {
  if (!name || name.length > 180 || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) throw new RemoteError('INVALID', '文件名包含不支持的字符。');
  return name;
}
export class UploadStore {
  private root: string;
  constructor(dir: string, private db: DatabaseSync) {
    this.root = join(dir, 'attachments'); mkdirSync(this.root, { recursive: true }); this.root = realpathSync(this.root);
    db.exec('CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversation TEXT NOT NULL,name TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,mediaType TEXT NOT NULL,offset INTEGER NOT NULL,ready INTEGER NOT NULL,committed INTEGER NOT NULL,created INTEGER NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS upload_holds(queue_id TEXT NOT NULL,attachment_id TEXT NOT NULL,PRIMARY KEY(queue_id,attachment_id));');
    this.cleanup();
  }
  private folder(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new RemoteError('INVALID', '附件标识无效。');
    const dir = join(this.root, id);
    if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !realpathSync(dir).startsWith(this.root + sep))) throw new RemoteError('INVALID', '附件目录无效。');
    return dir;
  }
  private get(id: string, owner: string): Upload {
    const row = this.db.prepare('SELECT * FROM uploads WHERE id=? AND owner=?').get(id, owner) as Upload | undefined;
    if (!row) throw new RemoteError('NOT_FOUND', '附件已失效，请重新选择文件。');
    this.folder(id); return row;
  }
  private info(row: Upload): Attachment { return { id: row.id, name: row.name, size: row.size, mediaType: row.mediaType, offset: row.offset, ready: !!row.ready }; }
  begin(id: string, owner: string, params: { id: string; name: string; size: number; sha256: string; mediaType: string }) {
    validateFilename(params.name); this.cleanup();
    if (params.size < 1 || params.size > MAX_FILE_SIZE) throw new RemoteError('INVALID', '单个文件不能超过 25 MB。');
    const existing = this.db.prepare('SELECT * FROM uploads WHERE id=?').get(id) as Upload | undefined;
    if (existing) {
      if (existing.owner !== owner || existing.conversation !== params.id || existing.name !== params.name || existing.sha256 !== params.sha256 || existing.size !== params.size) throw new RemoteError('INVALID', '上传标识已被使用。');
      return this.info(existing);
    }
    const bytes = Number(this.db.prepare('SELECT COALESCE(sum(size),0) AS bytes FROM uploads WHERE committed=0').get()!.bytes);
    const count = Number(this.db.prepare('SELECT count(*) AS count FROM uploads WHERE owner=? AND committed=0').get(owner)!.count);
    if (bytes + params.size > 2 * 1024 ** 3 || count >= 20) throw new RemoteError('UPLOAD_LIMIT', '未发送附件暂存已满，请移除未发送附件后重试。');
    const disk = statfsSync(this.root, { bigint: true });
    const reserved = Number(this.db.prepare('SELECT COALESCE(sum(size-offset),0) AS bytes FROM uploads WHERE committed=0').get()!.bytes);
    if (disk.bavail * disk.bsize < BigInt(reserved + params.size + 128 * 1024 ** 2)) throw new RemoteError('UPLOAD_STORAGE', '电脑剩余存储空间不足，请清理电脑存储后重试。');
    const folder = this.folder(id); mkdirSync(folder);
    const fd = openSync(join(folder, 'upload.part'), 'wx'); closeSync(fd);
    const row: Upload = { id, owner, conversation: params.id, name: params.name, size: params.size, sha256: params.sha256, mediaType: 'application/octet-stream', offset: 0, ready: 0, committed: 0, created: Date.now() };
    this.db.prepare('INSERT INTO uploads VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(row.id, row.owner, row.conversation, row.name, row.size, row.sha256, row.mediaType, 0, 0, 0, row.created);
    return this.info(row);
  }
  status(id: string, owner: string) { return this.info(this.get(id, owner)); }
  write(id: string, owner: string, offset: number, bytes: Buffer) {
    const row = this.get(id, owner);
    if (row.ready || bytes.length < 1 || bytes.length > MAX_UPLOAD_CHUNK || !Number.isSafeInteger(offset) || offset < 0 || offset + bytes.length > row.size) throw new RemoteError('INVALID', '文件分片无效。');
    const file = join(this.folder(id), 'upload.part');
    if (lstatSync(file).isSymbolicLink()) throw new RemoteError('INVALID', '附件路径无效。');
    const fd = openSync(file, 'r+');
    try {
      if (offset < row.offset && offset + bytes.length <= row.offset) {
        const previous = Buffer.alloc(bytes.length); readSync(fd, previous, 0, previous.length, offset);
        if (!previous.equals(bytes)) throw new RemoteError('INVALID', '重试分片与已接收内容不一致。');
      } else {
        if (offset !== row.offset) throw new RemoteError('UPLOAD_OFFSET', '上传进度不一致，请重试。');
        let written = 0; while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, offset + written);
        row.offset += bytes.length; this.db.prepare('UPDATE uploads SET offset=? WHERE id=?').run(row.offset, id);
      }
    } finally { closeSync(fd); }
    return this.info(row);
  }
  async complete(id: string, owner: string, authorize = () => {}) {
    authorize();
    const row = this.get(id, owner); if (row.ready) return this.info(row);
    if (row.offset !== row.size) throw new RemoteError('UPLOAD_INCOMPLETE', '文件尚未上传完成。');
    const folder = this.folder(id); const part = join(folder, 'upload.part');
    if (lstatSync(part).isSymbolicLink()) throw new RemoteError('INVALID', '附件路径无效。');
    const bytes = hashFile(part, row.size);
    if (bytes.size !== row.size || bytes.sha256 !== row.sha256) throw new RemoteError('UPLOAD_CORRUPT', '文件校验失败，请重新上传。');
    const extension = extname(row.name).toLowerCase();
    const header = bytes.header;
    const types: Record<string, [string, boolean]> = {
      '.png': ['image/png', header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))],
      '.jpg': ['image/jpeg', header[0] === 255 && header[1] === 216 && header[2] === 255],
      '.jpeg': ['image/jpeg', header[0] === 255 && header[1] === 216 && header[2] === 255],
      '.webp': ['image/webp', header.toString('ascii',0,4) === 'RIFF' && header.toString('ascii',8,12) === 'WEBP'],
      '.gif': ['image/gif', /^GIF8[79]a$/.test(header.toString('ascii',0,6))]
    };
    if (types[extension] && !types[extension][1]) throw new RemoteError('INVALID', '图片内容与格式不匹配。');
    if (types[extension]) {
      // Decode a bounded snapshot so concurrent validators cannot lock the file during finalization on Windows.
      try { await sharp(readFileSync(part), { limitInputPixels: 40000000, failOn: 'warning' }).resize(1, 1).raw().toBuffer(); }
      catch {
        authorize();
        // Another verified completion may have finalized the upload during decoding.
        const current = this.get(id, owner); if (current.ready) return this.info(current);
        throw new RemoteError('INVALID', '图片损坏或尺寸过大，请重新选择。');
      }
      authorize();
      const current = this.get(id, owner);
      if (current.ready) return this.info(current);
    }
    row.mediaType = types[extension]?.[0] ?? 'application/octet-stream';
    // Keep the original filename for native attachment rendering, within a generated directory.
    renameSync(part, join(folder, row.name)); row.ready = 1;
    this.db.prepare('UPDATE uploads SET ready=1,mediaType=? WHERE id=?').run(row.mediaType, id); return this.info(row);
  }
  resolve(ids: string[], owner: string, conversation: string): LocalAttachment[] {
    if (ids.length > 5 || new Set(ids).size !== ids.length) throw new RemoteError('INVALID', '每条消息最多包含 5 个不同附件。');
    const rows = ids.map(id => this.get(id, owner));
    if (rows.reduce((sum, r) => sum + r.size, 0) > MAX_ATTACHMENT_TOTAL) throw new RemoteError('INVALID', '消息附件合计不能超过 50 MB。');
    return rows.map(row => {
      if (!row.ready || row.conversation !== conversation) throw new RemoteError('INVALID', '附件未完成或不属于当前任务。');
      const file = join(this.folder(row.id), row.name);
      if (!existsSync(file) || lstatSync(file).isSymbolicLink() || statSync(file).size !== row.size) throw new RemoteError('NOT_FOUND', '附件文件已失效。');
      if (hashFile(file, row.size).sha256 !== row.sha256) throw new RemoteError('UPLOAD_CORRUPT', '附件内容已改变，请重新上传。');
      return { ...this.info(row), path: file };
    });
  }
  commit(ids: string[]) { for (const id of ids) this.db.prepare('UPDATE uploads SET committed=1 WHERE id=?').run(id); }
  remove(id: string, owner: string) {
    const row = this.get(id, owner); if (row.committed) throw new RemoteError('INVALID', '已发送的附件需要保留供原任务读取。');
    if (this.db.prepare('SELECT 1 FROM upload_holds WHERE attachment_id=?').get(id)) throw new RemoteError('INVALID', '附件已加入待发送队列，请先移除对应排队消息。');
    rmSync(this.folder(id), { recursive: true, force: true }); this.db.prepare('DELETE FROM uploads WHERE id=?').run(id); return { removed: true };
  }
  cleanup() {
    const rows = this.db.prepare('SELECT id,owner FROM uploads WHERE committed=0 AND created<? AND NOT EXISTS(SELECT 1 FROM upload_holds h WHERE h.attachment_id=uploads.id)').all(Date.now() - 86400000);
    for (const row of rows) this.remove(String(row.id), String(row.owner));
  }
}

function hashFile(file: string, expectedSize: number) {
  const digest = createHash('sha256'); const header = Buffer.alloc(16); let headerBytes = 0; let size = 0; const fd = openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(MAX_UPLOAD_CHUNK);
    while (size <= expectedSize) {
      const read = readSync(fd, chunk, 0, chunk.length, size);
      if (!read) break;
      const bytes = chunk.subarray(0, read); digest.update(bytes); size += read;
      if (headerBytes < header.length) { const length = Math.min(header.length - headerBytes, bytes.length); bytes.copy(header, headerBytes, 0, length); headerBytes += length; }
    }
    return { sha256: digest.digest('hex'), size, header };
  } finally { closeSync(fd); }
}
