import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from 'yauzl';
import { afterEach, expect, it } from 'vitest';
import { writeWindowsArchive } from '../scripts/windows-archive.js';

const roots: string[] = [];
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'windows-archive-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('preserves Unicode filenames and includes only selected package paths', async () => {
  const root = fixture(); const directory = 'snow \u2603'; const file = directory + '/\u7167\u7247.txt';
  mkdirSync(join(root, directory)); writeFileSync(join(root, file), 'fixture'); writeFileSync(join(root, 'excluded.txt'), 'excluded');
  const archive = join(root, 'package.zip'); await writeWindowsArchive(root, archive, [directory]);
  const entries = await new Promise<string[]>((done, reject) => {
    open(archive, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const names: string[] = []; zip.on('error', reject); zip.on('end', () => done(names));
      zip.on('entry', entry => { names.push(entry.fileName); zip.readEntry(); }); zip.readEntry();
    });
  });
  expect(entries).toEqual([directory + '/', file]);
});

it('rejects a directory junction instead of following it into another tree', async () => {
  const root = fixture(); const outside = fixture();
  symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(writeWindowsArchive(root, join(root, 'package.zip'), ['linked'])).rejects.toThrow('symlinks are not allowed');
});
