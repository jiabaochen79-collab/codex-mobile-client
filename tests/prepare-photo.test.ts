import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { preparePhoto } from '../web/prepare-photo.js';
import { useAttachments } from '../web/use-attachments.js';

describe('mobile photo preparation', () => {
  beforeEach(() => vi.stubGlobal('createImageBitmap', async (file: Blob) => {
    const decoded = await sharp(Buffer.from(await file.arrayBuffer()), { failOn: 'warning', limitInputPixels:40000000 }).raw().toBuffer({resolveWithObject:true});
    return {width:decoded.info.width,height:decoded.info.height,close:()=>{}};
  }));
  afterEach(() => vi.unstubAllGlobals());
  it('rejects header-only images before uploading', async () => {
    const file=new File([new Uint8Array([137,80,78,71,13,10,26,10])],'broken.png',{type:'image/png'});
    await expect(preparePhoto(file,true)).rejects.toThrow('图片损坏');
    await expect(preparePhoto(file,false)).rejects.toThrow('图片损坏');
  });
  it('keeps ordinary files intact', async () => {
    const file = new File(['report'], 'report.txt', { type:'text/plain' });
    expect(await preparePhoto(file, false)).toBe(file);
    await expect(preparePhoto(file, true)).rejects.toThrow('请选择照片');
  });
  it('preserves existing JPEG photos without recompressing them', async () => {
    const bytes = await sharp({ create:{ width:80, height:60, channels:3, background:'#21785f' } }).jpeg().toBuffer();
    const file = new File([new Uint8Array(bytes)], 'IMG_0100.JPG', { type:'image/jpeg' });
    expect(await preparePhoto(file, true)).toBe(file);
  });
  it('recognizes browser-converted JPEG bytes even when the filename still says HEIC', async () => {
    const bytes = await sharp({ create:{ width:80, height:60, channels:3, background:'#476aab' } }).jpeg().toBuffer();
    const file = new File([new Uint8Array(bytes)], 'IMG_0101.HEIC', { type:'image/heic', lastModified:42 });
    const converted = await preparePhoto(file, true);
    expect(converted.name).toBe('IMG_0101.jpg'); expect(converted.type).toBe('image/jpeg'); expect(converted.lastModified).toBe(42);
    expect(Buffer.from(await converted.arrayBuffer())).toEqual(bytes); expect(file.name).toBe('IMG_0101.HEIC');
  });
  it('normalizes image names with missing MIME types and refuses SVG in the photo picker', async () => {
    const bytes = await sharp({ create:{ width:32, height:32, channels:3, background:'#476aab' } }).png().toBuffer();
    const file = await preparePhoto(new File([new Uint8Array(bytes)], '照片'), true);
    expect(file.name).toBe('照片.png'); expect(file.type).toBe('image/png');
    const svg = new File(['<svg/>'], 'source.svg', { type:'image/svg+xml' });
    await expect(preparePhoto(svg, true)).rejects.toThrow('文件'); expect(await preparePhoto(svg, false)).toBe(svg);
  });
  it('reserves the entire photo selection before starting asynchronous uploads', async () => {
    const files = Array.from({length:5}, (_,i) => new File(['sample'], `${i}.txt`, {type:'text/plain'}));
    const queue = useAttachments({thread:()=>'task',control:()=>({allowed:true,clientId:'fixture',epoch:'fixture'}),request:async()=>{throw new Error('fixture offline');}});
    const pending = queue.add(files);
    expect(queue.current.value).toHaveLength(5);
    await expect(queue.add([files[0]])).rejects.toThrow('5');
    await pending; queue.clear(); expect(queue.current.value).toHaveLength(0);
  });
  it('retains files selected before control was lost, ready for retry after takeover', async () => {
    const queue = useAttachments({thread:()=>'task',control:()=>({allowed:false,clientId:'fixture'}),request:async()=>{throw new Error('must not dispatch');}});
    await queue.add([new File(['photo selection'], 'selected.txt')]);
    expect(queue.current.value).toHaveLength(1); expect(queue.current.value[0].error).toContain('接管');
    queue.clear();
  });
});
