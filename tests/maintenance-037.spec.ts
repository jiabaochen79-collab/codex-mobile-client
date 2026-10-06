import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const origin = process.env.PLAN_WEB_ORIGIN ?? 'http://127.0.0.1:19975';
test('feedback preprocessing scales a real 32MP JPEG within the server limit', async ({ page }, info) => {
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const source = '/prepare-photo.ts'; const { preparePhoto } = await import(source);
    const canvas = document.createElement('canvas'); canvas.width = 3200; canvas.height = 10000;
    const context = canvas.getContext('2d')!; context.fillStyle = '#228899'; context.fillRect(0, 0, canvas.width, canvas.height);
    const original = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/jpeg', 0.8)); canvas.width = canvas.height = 1;
    const file = await preparePhoto(new File([original], 'large.jpg', { type: 'image/jpeg' }), true, 25000000);
    const url = URL.createObjectURL(file), image = new Image(); image.src = url; await image.decode();
    const width = image.naturalWidth, height = image.naturalHeight; URL.revokeObjectURL(url);
    const bytes = new Uint8Array(await file.arrayBuffer()); let text = ''; for (const byte of bytes) text += String.fromCharCode(byte);
    return { width, height, size: file.size, type: file.type, data: btoa(text) };
  });
  expect(result.width * result.height).toBeLessThanOrEqual(25000000); expect(Math.max(result.width, result.height)).toBe(4096); expect(result.size).toBeLessThan(5 * 1024 * 1024); expect(result.type).toBe('image/jpeg');
  writeFileSync(info.outputPath('feedback-resized.jpg'), Buffer.from(result.data, 'base64'));
});
