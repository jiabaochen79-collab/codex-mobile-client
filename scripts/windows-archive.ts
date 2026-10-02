import { createWriteStream, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ZipFile } from 'yazl';

export async function writeWindowsArchive(root: string, archive: string, files: readonly string[]): Promise<void> {
  const zip = new ZipFile();
  function add(relative: string): void {
    const absolute = join(root, relative); const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Package symlinks are not allowed: ${relative}`);
    if (stat.isDirectory()) {
      zip.addEmptyDirectory(relative);
      for (const name of readdirSync(absolute).sort()) add(`${relative}/${name}`);
    } else zip.addFile(absolute, relative);
  }
  for (const file of files) add(file);
  await new Promise<void>((done, reject) => {
    const stream = createWriteStream(archive);
    stream.on('error', reject); stream.on('close', done); zip.outputStream.on('error', reject);
    zip.outputStream.pipe(stream); zip.end();
  });
}
