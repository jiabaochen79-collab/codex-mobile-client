import { api } from './api';

export type FeedbackPicture = { data: string; uploadId?: string; ready?: boolean };
export async function uploadFeedbackPictures(base: string, pictures: FeedbackPicture[], headers: Record<string, string> | undefined, save: () => Promise<boolean>) {
  for (const picture of pictures) {
    const bytes = Uint8Array.from(atob(picture.data), char => char.charCodeAt(0));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    picture.uploadId ??= crypto.randomUUID();
    if (!await save()) throw new Error('截图上传进度无法保存，请检查浏览器存储空间。');
    let status = await api(base + '/uploads', { id: picture.uploadId, size: bytes.length, sha256 }, headers);
    let failures = 0;
    while (status.offset < bytes.length) {
      const offset = status.offset; const chunk = bytes.subarray(offset, offset + 65536);
      const data = btoa(Array.from(chunk, byte => String.fromCharCode(byte)).join(''));
      try {
        status = await api(`${base}/uploads/${picture.uploadId}/chunks`, { offset, data }, headers);
        if (status.offset <= offset) throw new Error('服务器未确认截图上传进度。');
        failures = 0;
      } catch (error: any) {
        if (!['OUTCOME_UNKNOWN', 'UPLOAD_OFFSET', 'BUSY', 'INTERNAL'].includes(error?.code) || ++failures > 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** (failures - 1)));
        status = await api(`${base}/uploads/${picture.uploadId}`, undefined, headers);
      }
    }
    picture.ready = status.ready === true;
    if (!picture.ready) throw new Error('截图尚未校验完成，请重试。');
    if (!await save()) throw new Error('截图上传进度无法保存。');
  }
  return pictures.map(picture => ({ uploadId: picture.uploadId! }));
}
