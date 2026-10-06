import { createHmac, randomBytes } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import sharp from 'sharp';
import { MAX_IMAGE_BYTES, RemoteError, type MessageImage } from '../shared/protocol.js';
import { presentUserMessage } from '../shared/user-message.js';

type Source = { value: string; realPath?: string; stamp?: string };
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const unavailable = () => new RemoteError('IMAGE_UNAVAILABLE', '图片不存在、已更改或无法读取，请刷新会话后重试。');
const stamp = (stat: { size: number; mtimeMs: number; ino: number }) => `${stat.size}:${stat.mtimeMs}:${stat.ino}`;

function imagePath(value: string) {
  if (value.startsWith('file:')) { try { value = fileURLToPath(value); } catch { return; } }
  value = value.replace(/^\\\\\?\\(?=[a-z]:\\)/i, '');
  if (value.includes('\0') || value.startsWith('\\\\') || value.startsWith('//')) return;
  if (!isAbsolute(value) && !/^[a-z]:[\\/]/i.test(value)) return;
  if (value.slice(2).includes(':')) return;
  return value;
}

export function markdownImages(text: string) {
  const images: { source: string; alt: string }[] = [];
  marked.walkTokens(marked.lexer(text), token => {
    if (token.type === 'image' && images.length < 20) {
      let source = token.href;
      try { if (!source.startsWith('data:')) source = decodeURI(source); } catch { /* Keep literal file names containing percent signs. */ }
      images.push({ source, alt: token.text });
    }
  });
  return images;
}

export function userImageContent(item: any) {
  let text: string = item.text ?? (item.content ?? []).filter((c: any) => c.type === 'text' || c.type === 'inputText').map((c: any) => c.text).join('\n');
  const images: { source: string; alt: string }[] = (item.content ?? []).flatMap((c: any) => {
    const source = c.type === 'localImage' ? c.path : c.type === 'image' ? c.url : undefined;
    return typeof source === 'string' ? [{ source, alt: c.type === 'localImage' ? win32.basename(source) : '照片' }] : [];
  });
  // Remove only the desktop's complete attachment envelope, never edit model input.
  text = presentUserMessage(text, images.map(image => image.alt));
  return { text, images };
}

export class ConversationImages {
  private secret = randomBytes(32);
  private threads = new Map<string, Map<string, Source>>();
  private cache = new Map<string, Buffer>();
  private cacheBytes = 0;

  begin(id: string, retain = false) { if (!retain || !this.threads.has(id)) this.threads.set(id, new Map()); }
  clear(id?: string) {
    if (id) this.threads.delete(id); else this.threads.clear();
    this.cache.clear(); this.cacheBytes = 0;
  }
  register(threadId: string, value: string, alt: string): MessageImage | undefined {
    const entries = this.threads.get(threadId);
    if (!entries) return;
    let source: Source;
    if (/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=\r\n]+$/i.test(value) && value.length <= MAX_SOURCE_BYTES * 1.4) source = { value };
    else {
      const path = imagePath(value); if (!path) return;
      source = { value: path };
      try { source.realPath = realpathSync(path); source.stamp = stamp(statSync(path)); } catch { /* Missing references remain visible as retryable placeholders. */ }
    }
    const id = createHmac('sha256', this.secret).update(JSON.stringify([threadId, source])).digest('hex');
    entries.delete(id); entries.set(id, source);
    return { id, alt: (alt || '照片').slice(0, 180) };
  }
  async read(threadId: string, imageId: string, variant: 'thumbnail' | 'full') {
    const source = this.threads.get(threadId)?.get(imageId);
    if (!source) throw unavailable();
    let input: Buffer;
    const key = `${threadId}:${imageId}:${variant}`;
    try {
      if (source.realPath) {
        if (realpathSync(source.value) !== source.realPath || stamp(statSync(source.value)) !== source.stamp) throw unavailable();
      } else if (!source.value.startsWith('data:')) throw unavailable();
      const cached = this.cache.get(key);
      if (cached) { this.cache.delete(key); this.cache.set(key, cached); return { mediaType: 'image/jpeg' as const, data: cached.toString('base64') }; }
      if (source.realPath) {
        const handle = await open(source.realPath, 'r');
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES || stamp(stat) !== source.stamp) throw unavailable();
          input = Buffer.alloc(stat.size);
          let offset = 0;
          while (offset < input.length) { const read = await handle.read(input, offset, input.length - offset, offset); if (!read.bytesRead) throw unavailable(); offset += read.bytesRead; }
          if (stamp(await handle.stat()) !== source.stamp || realpathSync(source.value) !== source.realPath) throw unavailable();
        } finally { await handle.close(); }
      } else input = Buffer.from(source.value.slice(source.value.indexOf(',') + 1), 'base64');
      // Decode only raster signatures, then re-encode without metadata or active content.
      const raster = input.subarray(0, 3).equals(Buffer.from([255, 216, 255])) || input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || /^GIF8[79]a/.test(input.subarray(0, 6).toString()) || input.subarray(0, 4).toString() === 'RIFF' && input.subarray(8, 12).toString() === 'WEBP';
      if (!raster || input.length > MAX_SOURCE_BYTES) throw unavailable();
      const convert = (size: number, quality: number) => sharp(input, { limitInputPixels: 40000000, failOn: 'error' }).rotate().resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality }).toBuffer();
      let bytes = await convert(variant === 'thumbnail' ? 600 : 2000, variant === 'thumbnail' ? 72 : 85);
      if (bytes.length > MAX_IMAGE_BYTES) bytes = await convert(1280, 70);
      if (bytes.length > MAX_IMAGE_BYTES || !this.threads.get(threadId)?.has(imageId)) throw unavailable();
      this.cache.set(key, bytes); this.cacheBytes += bytes.length;
      while (this.cacheBytes > 16 * 1024 * 1024) { const oldest = this.cache.keys().next().value!; this.cacheBytes -= this.cache.get(oldest)!.length; this.cache.delete(oldest); }
      return { mediaType: 'image/jpeg' as const, data: bytes.toString('base64') };
    } catch { throw unavailable(); }
  }
}
