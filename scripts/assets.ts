import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { Copy, Eye, EyeOff, RefreshCw, Settings, Unplug, ExternalLink, Monitor, ShieldCheck, MessagesSquare, Ticket, Moon, Download, MessageSquare } from 'lucide-vue-next';
mkdirSync('web/public', { recursive: true }); mkdirSync('release', { recursive: true });
const symbol = await renderToString(createSSRApp({ render: () => h(MessagesSquare, { size: 164, color: '#ffffff', strokeWidth: 1.65 }) }));
const png = await sharp({ create: { width: 256, height: 256, channels: 4, background: '#26373c' } }).composite([{ input: await sharp(Buffer.from(symbol)).png().toBuffer(), left: 46, top: 46 }]).png().toBuffer();
writeFileSync('web/public/brand.png', png);
const sizes = [16, 24, 32, 48, 64, 128, 256];
const icoHeader = Buffer.alloc(6 + sizes.length * 16); icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(sizes.length, 4);
const bitmaps: Buffer[] = []; let offset = icoHeader.length;
for (const [index, size] of sizes.entries()) {
  const bitmap = await sharp(png).resize(size, size).png().toBuffer(); const entry = 6 + index * 16;
  icoHeader[entry] = icoHeader[entry + 1] = size === 256 ? 0 : size;
  icoHeader.writeUInt16LE(1, entry + 4); icoHeader.writeUInt16LE(32, entry + 6); icoHeader.writeUInt32LE(bitmap.length, entry + 8); icoHeader.writeUInt32LE(offset, entry + 12);
  bitmaps.push(bitmap); offset += bitmap.length;
}
writeFileSync('release/companion.ico', Buffer.concat([icoHeader, ...bitmaps]));
mkdirSync('release/icons', { recursive: true });
writeFileSync('release/icons/brand.png', png);
for (const [name, component] of [['copy', Copy], ['copy-white', Copy], ['eye', Eye], ['eye-off', EyeOff], ['refresh', RefreshCw], ['settings', Settings], ['unplug', Unplug], ['external', ExternalLink], ['monitor', Monitor], ['shield', ShieldCheck], ['ticket', Ticket], ['moon', Moon], ['download', Download], ['feedback', MessageSquare]] as const) {
  const color = name === 'unplug' ? '#a93d41' : name === 'copy-white' ? '#ffffff' : '#445161';
  const svg = await renderToString(createSSRApp({ render: () => h(component, { size: 20, color }) }));
  await sharp(Buffer.from(svg)).png().toFile(`release/icons/${name}.png`);
}
