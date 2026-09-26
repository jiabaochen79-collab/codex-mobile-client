import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { UploadStore, validateFilename } from '../src/agent/uploads.js';
import { parseUploadFrame, uploadFrame } from '../src/shared/upload-frame.js';
describe('attachment uploads',()=>{
  let dir:string;let db:DatabaseSync;let store:UploadStore;let id:string;let owner:string;let thread:string;
  beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'remote-upload-'));db=new DatabaseSync(':memory:');store=new UploadStore(dir,db);id=randomUUID();owner=randomUUID();thread=randomUUID();});
  afterEach(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  function begin(bytes=Buffer.from('中文 file content')){store.begin(id,owner,{id:thread,name:'input.txt',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),mediaType:'text/plain'});return bytes;}
  it('validates filenames against traversal, streams and Windows device names',()=>{
    for(const name of ['../file','C:\\file','a:b','file\nname','NUL.txt','COM1','x.','x ','a/b'])expect(()=>validateFilename(name)).toThrow();
    expect(validateFilename('中文 报告.xlsx')).toBe('中文 报告.xlsx');
  });
  it('retries identical chunks and resumes safely before atomic finalization',()=>{
    const bytes=begin();store.write(id,owner,0,bytes.subarray(0,5));expect(store.write(id,owner,0,bytes.subarray(0,5)).offset).toBe(5);
    expect(()=>store.write(id,owner,1,Buffer.from('bad'))).toThrow();expect(()=>store.complete(id,owner)).toThrow();
    store=new UploadStore(dir,db);store.write(id,owner,5,bytes.subarray(5));expect(store.complete(id,owner).ready).toBe(true);
    const file=store.resolve([id],owner,thread)[0];expect(readFileSync(file.path)).toEqual(bytes);
  });
  it('rejects cross-session and cross-task attachment references',()=>{
    const bytes=begin();store.write(id,owner,0,bytes);store.complete(id,owner);
    expect(()=>store.status(id,randomUUID())).toThrow();expect(()=>store.resolve([id],owner,randomUUID())).toThrow();expect(()=>store.resolve([id,id],owner,thread)).toThrow();
  });
  it('does not delete committed files when cleaning unsubmitted uploads',()=>{
    const bytes=begin();store.write(id,owner,0,bytes);store.complete(id,owner);store.commit([id]);
    expect(()=>store.remove(id,owner)).toThrow();db.prepare('UPDATE uploads SET created=0').run();store=new UploadStore(dir,db);expect(store.resolve([id],owner,thread)).toHaveLength(1);
  });
  it('rejects corrupt file hashes and oversized declarations',()=>{
    const bytes=begin();store.write(id,owner,0,Buffer.alloc(bytes.length));expect(()=>store.complete(id,owner)).toThrow();
    expect(()=>store.begin(randomUUID(),owner,{id:thread,name:'large.bin',size:26*1024*1024,sha256:'0'.repeat(64),mediaType:''})).toThrow();
  });
  it('does not impose a lifetime quota from previously sent attachments',()=>{
    const bytes=begin();store.write(id,owner,0,bytes);store.complete(id,owner);store.commit([id]);
    db.prepare('UPDATE uploads SET size=? WHERE id=?').run(3*1024**3,id);
    id=randomUUID();expect(()=>begin()).not.toThrow();
  });
  it('bounds and authenticates binary framing metadata',()=>{
    const bytes=Buffer.from('fixture');const header={type:'upload-chunk' as const,id,sessionId:owner,clientId:randomUUID(),controlEpoch:randomUUID(),attachmentId:randomUUID(),offset:0};
    const frame=uploadFrame(header,bytes);expect(parseUploadFrame(frame)).toEqual({header,bytes});
    expect(()=>parseUploadFrame(Buffer.from([255,255,255,255]))).toThrow();
  });
});
