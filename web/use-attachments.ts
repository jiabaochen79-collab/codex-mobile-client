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
        if (all.filter(f=>f.threadId===item.threadId&&f!==item).reduce((sum,f)=>sum+f.file.size,0)+file.size > MAX_ATTACHMENT_TOTAL) throw new Error('处理后的附件合计超过 50 MB。');
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
      while (item.attachment!.offset < item.file.size && !item.cancelled) {
        const control = options.control(); if(!control.allowed||!control.epoch) throw new Error('控制权已改变，附件上传已暂停。');
        const offset = item.attachment!.offset; item.controller = new AbortController();
        const timeout = setTimeout(()=>item.controller?.abort(),20000);
        try {
          const response = await fetch(`/api/uploads/${item.attachment!.id}/${offset}`,{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/octet-stream','X-Client-Id':control.clientId,'X-Control-Epoch':control.epoch,...(options.deviceId?{'X-Remote-Device':options.deviceId}:{})},body:item.file.slice(offset,offset+Math.min(MAX_UPLOAD_CHUNK,64*1024)),signal:item.controller.signal});
          const result=await response.json(); if(!response.ok)throw new Error(result.error?.message??'上传失败，请重试。');item.attachment=result;
          item.progress=Math.floor(item.attachment!.offset/item.file.size*100);
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
    if([...current.value.map(f=>f.file),...files].reduce((n,f)=>n+f.size,0)>MAX_ATTACHMENT_TOTAL)throw new Error('附件合计不能超过 50 MB。');
    const items = files.map(file => reactive<PendingFile>({key:crypto.randomUUID(),file,threadId,photosOnly,prepared:false,preparing:false,progress:0,error:'',uploading:false,cancelled:false}));
    all.push(...items);
    for(const item of items)await upload(item);
  }
  function discard(item:PendingFile){item.cancelled=true;item.controller?.abort();if(item.preview)URL.revokeObjectURL(item.preview);const index=all.indexOf(item);if(index>=0)all.splice(index,1);}
  async function remove(item:PendingFile){discard(item);if(item.attachment){try{await options.request({method:'upload.remove',params:{attachmentId:item.attachment.id}});}catch{}}}
  function clear(threadId?:string){for(const item of [...all])if(!threadId||item.threadId===threadId)discard(item);}
  function cancelPending() { for (const item of [...all]) if (!item.attachment?.ready) void remove(item); }
  return {current,add,upload,remove,clear,uploading,cancelPending,hasPending:computed(()=>all.length>0)};
}
