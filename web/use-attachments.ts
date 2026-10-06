import { computed, reactive } from 'vue';
import { MAX_ATTACHMENT_TOTAL, MAX_FILE_SIZE, MAX_UPLOAD_CHUNK } from '../src/shared/upload-limits';
import type { Attachment, Command } from '../src/shared/protocol';
import { preparePhoto } from './prepare-photo';

export type PendingFile = { key: string; file: File; threadId: string; photosOnly: boolean; prepared: boolean; preparing: boolean; attachment?: Attachment; progress: number; error: string; uploading: boolean; cancelled: boolean; preview?: string; controller?: AbortController };
export function useAttachments(options: { request: (command: Command, id?: string) => Promise<any>; thread: () => string | undefined; deviceId?: string; control: () => { clientId: string; epoch?: string; allowed: boolean } }) {
  const all = reactive<PendingFile[]>([]);
  const current = computed(() => all.filter(f => f.threadId === options.thread()));
  const uploading = computed(() => all.some(f => f.uploading || !f.cancelled && !f.attachment?.ready && !f.error));
  async function upload(item: PendingFile) {
    if (item.uploading || item.cancelled) return;
    item.uploading = true; item.error = '';
    try {
      if (!options.control().allowed) throw new Error('请先接管控制权。');
      if (!item.prepared) {
        item.preparing = true;
        const file = await preparePhoto(item.file,item.photosOnly);
        if (item.cancelled) return;
        if (file.size > MAX_FILE_SIZE) throw new Error('处理后的照片超过 25 MB，请选择较小的照片。');
        if (all.filter(f=>f.threadId===item.threadId&&f!==item).reduce((sum,f)=>sum+(f.attachment?.size ?? f.file.size),0)+file.size > MAX_ATTACHMENT_TOTAL) throw new Error('处理后的附件合计超过 50 MB。');
        if (item.preview) URL.revokeObjectURL(item.preview);
        item.file = file; item.prepared = true; item.preparing = false;
        item.preview = /^image\/(png|jpeg|webp|gif)$/.test(file.type) ? URL.createObjectURL(file) : undefined;
      }
      if (!item.attachment) {
        const hash = await crypto.subtle.digest('SHA-256', await item.file.arrayBuffer());
        const sha256 = Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2,'0')).join('');
        if (item.cancelled) return;
        item.attachment = await options.request({ method:'upload.begin', params:{id:item.threadId,name:item.file.name,size:item.file.size,mediaType:item.file.type,sha256} }, item.key);
      } else item.attachment = await options.request({method:'upload.status',params:{attachmentId:item.attachment.id}});
      if (item.cancelled) { await remove(item); return; }
      let chunkSize = 16 * 1024; let failures = 0;
      while (item.attachment!.offset < item.file.size && !item.cancelled) {
        const control = options.control(); if(!control.allowed||!control.epoch) throw new Error('控制权已改变，附件上传已暂停。');
        const offset = item.attachment!.offset; item.controller = new AbortController();
        const timeout = setTimeout(()=>item.controller?.abort(),60000); const started = Date.now();
        try {
          const response = await fetch(`/api/uploads/${item.attachment!.id}/${offset}`,{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/octet-stream','X-Client-Id':control.clientId,'X-Control-Epoch':control.epoch,...(options.deviceId?{'X-Remote-Device':options.deviceId}:{})},body:item.file.slice(offset,offset+Math.min(MAX_UPLOAD_CHUNK,chunkSize)),signal:item.controller.signal});
          const result=await response.json(); if(!response.ok)throw Object.assign(new Error(result.error?.message??'上传失败，请重试。'),{code:result.error?.code,status:response.status});item.attachment=result;
          if (item.attachment!.offset <= offset) throw new Error('电脑未确认上传进度，请重试。');
          failures = 0; const elapsed = Date.now() - started;
          if (elapsed < 2000) chunkSize = Math.min(64 * 1024, chunkSize * 2);
          else if (elapsed > 5000) chunkSize = Math.max(16 * 1024, chunkSize / 2);
          item.progress=Math.floor(item.attachment!.offset/item.file.size*100);
        } catch (e: any) {
          const retryable = e instanceof TypeError || e?.name === 'AbortError' || [502,503,504].includes(e?.status) || ['OUTCOME_UNKNOWN','UPLOAD_OFFSET','BUSY'].includes(e?.code);
          if (item.cancelled || !retryable || ++failures > 3) throw e;
          clearTimeout(timeout);
          await new Promise(resolve => setTimeout(resolve, 500 * 2 ** (failures - 1)));
          if (item.cancelled) return;
          if (!options.control().allowed || options.control().epoch !== control.epoch) throw new Error('控制权已改变，附件上传已暂停。');
          // Confirm the durable offset before retrying an ambiguous PUT.
          item.attachment = await options.request({method:'upload.status',params:{attachmentId:item.attachment!.id}});
          item.progress=Math.floor(item.attachment!.offset/item.file.size*100);
          chunkSize = 16 * 1024;
        } finally { clearTimeout(timeout); }
      }
      if(!item.cancelled)item.attachment=await options.request({method:'upload.complete',params:{attachmentId:item.attachment!.id}});
    } catch(e:any){if(!item.cancelled)item.error=e?.name==='AbortError'?'上传已暂停，可重试。':e instanceof Error?e.message:'照片处理或上传失败，请重试。';}
    finally {item.uploading=false;item.preparing=false;item.controller=undefined;}
  }
  async function add(files: File[], photosOnly = false) {
    const threadId=options.thread();if(!threadId)throw new Error('目标任务已关闭，请重新选择任务。');
    if(files.length+current.value.length>5)throw new Error('每条消息最多 5 个附件。');
    if(files.some(f=>f.size<1||f.size>MAX_FILE_SIZE))throw new Error('请选择非空文件，单个文件不超过 25 MB。');
    if(current.value.reduce((n,f)=>n+(f.attachment?.size ?? f.file.size),0)+files.reduce((n,f)=>n+f.size,0)>MAX_ATTACHMENT_TOTAL)throw new Error('附件合计不能超过 50 MB。');
    const items = files.map(file => reactive<PendingFile>({key:crypto.randomUUID(),file,threadId,photosOnly,prepared:false,preparing:false,progress:0,error:'',uploading:false,cancelled:false}));
    all.push(...items);
    for(const item of items)await upload(item);
  }
  function discard(item:PendingFile){item.cancelled=true;item.controller?.abort();if(item.preview){URL.revokeObjectURL(item.preview);item.preview=undefined;}const index=all.indexOf(item);if(index>=0)all.splice(index,1);}
  async function remove(item:PendingFile){item.cancelled=true;item.controller?.abort();try{if(item.attachment)await options.request({method:'upload.remove',params:{attachmentId:item.attachment.id}});discard(item);}catch{item.cancelled=false;item.error='附件未能从电脑移除，请恢复连接后重试删除。';if(!all.includes(item))all.push(item);}}
  function clear(threadId?:string){for(const item of [...all])if(!threadId||item.threadId===threadId)discard(item);}
  function cancelPending() { for (const item of [...all]) if (!item.attachment?.ready) void remove(item); }
  function restore(threadId: string, attachments: Attachment[]) {
    for (const attachment of attachments) {
      if (all.some(item => item.threadId === threadId && item.attachment?.id === attachment.id)) continue;
      // Completed files remain on the helper; do not pretend to have their original bytes.
      all.push({ key: attachment.id, threadId, file: new File([], attachment.name, { type: attachment.mediaType }), photosOnly: false, prepared: true, preparing: false, attachment, progress: 100, error: '', uploading: false, cancelled: false });
    }
  }
  return {current,add,upload,remove,clear,restore,uploading,cancelPending,hasPending:computed(()=>all.length>0)};
}
