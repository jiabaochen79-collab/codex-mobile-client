function rasterFormat(bytes: Uint8Array): { type: string; extension: string; suffix: RegExp } | undefined {
  if ([137,80,78,71,13,10,26,10].every((byte,index) => bytes[index] === byte)) return { type:'image/png', extension:'png', suffix:/\.png$/i };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { type:'image/jpeg', extension:'jpg', suffix:/\.jpe?g$/i };
  const text = new TextDecoder().decode(bytes);
  if (text.startsWith('RIFF') && text.slice(8,12) === 'WEBP') return { type:'image/webp', extension:'webp', suffix:/\.webp$/i };
  if (/^GIF8[79]a/.test(text)) return { type:'image/gif', extension:'gif', suffix:/\.gif$/i };
}
function photoName(name: string, extension: string) { return `${name.replace(/\.[^.]*$/, '') || 'photo'}.${extension}`; }
async function jpegBlob(image: CanvasImageSource, width: number, height: number) {
  if (!width || !height) throw new Error('照片没有有效的图像内容。');
  const scale = Math.min(1, 4096 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  try {
    const context = canvas.getContext('2d'); if (!context) throw new Error('浏览器暂时无法处理照片。');
    context.fillStyle = '#ffffff'; context.fillRect(0,0,canvas.width,canvas.height);
    context.drawImage(image,0,0,canvas.width,canvas.height);
    return await new Promise<Blob>((resolve,reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('照片转换失败。')), 'image/jpeg', 0.92));
  } finally { canvas.width = 1; canvas.height = 1; }
}
async function nativeJpeg(file: File) {
  const url = URL.createObjectURL(file); const image = new Image();
  try { image.src = url; await image.decode(); return await jpegBlob(image,image.naturalWidth,image.naturalHeight); }
  finally { URL.revokeObjectURL(url); }
}
async function validateRaster(file: File) {
  try {
    if (typeof createImageBitmap === 'function') {
      const image = await createImageBitmap(file);
      try { if (!image.width || !image.height || image.width * image.height > 40000000) throw new Error(); return { width: image.width, height: image.height }; }
      finally { image.close(); }
    } else {
      const url = URL.createObjectURL(file); const image = new Image();
      try { image.src = url; await image.decode(); if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40000000) throw new Error(); return { width: image.naturalWidth, height: image.naturalHeight }; }
      finally { image.src = ''; URL.revokeObjectURL(url); }
    }
  } catch { throw new Error('图片损坏或尺寸过大，请重新选择。'); }
}
export async function preparePhoto(file: File, photosOnly: boolean, maxPixels = 40000000): Promise<File> {
  const header = new Uint8Array(await file.slice(0,16).arrayBuffer()); const format = rasterFormat(header);
  if (format) {
    const size = await validateRaster(file);
    if (size.width * size.height > maxPixels) return new File([await nativeJpeg(file)], photoName(file.name, 'jpg'), { type: 'image/jpeg', lastModified: file.lastModified });
    const name = format.suffix.test(file.name) ? file.name : photoName(file.name,format.extension);
    return name === file.name && file.type === format.type ? file : new File([file],name,{type:format.type,lastModified:file.lastModified});
  }
  const heic = /\.hei[cf]$/i.test(file.name) || /^image\/hei[cf](?:-sequence)?$/i.test(file.type);
  if (!photosOnly && !heic) return file;
  if (/svg/i.test(file.type) || /\.svg$/i.test(file.name) || file.type && !file.type.startsWith('image/') && !heic) throw new Error('请选择照片或常用图片，其他类型请使用“文件”。');
  let blob: Blob;
  try { blob = await nativeJpeg(file); }
  catch {
    if (!heic && new TextDecoder().decode(header.slice(4,8)) !== 'ftyp') throw new Error('无法读取这张照片，请重新选择。');
    // Load the local CSP-safe decoder only when the browser cannot decode HEIC itself.
    const { isHeic, heicTo } = await import('heic-to/csp');
    if (!await isHeic(file)) throw new Error('无法识别这张照片的格式。');
    const image = await heicTo({blob:file,type:'bitmap'});
    try { blob = await jpegBlob(image,image.width,image.height); } finally { image.close(); }
  }
  return new File([blob],photoName(file.name,'jpg'),{type:'image/jpeg',lastModified:file.lastModified});
}
