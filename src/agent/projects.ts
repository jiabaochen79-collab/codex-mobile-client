import { win32 } from 'node:path';
import type { Project } from '../shared/protocol.js';

export type IndexedProject = Project & { nativeIds: string[]; roots: string[] };
export function normalizeProjectPath(value: string) {
  if (!value) return '';
  const ordinary = value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  return win32.normalize(ordinary).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}
export function projectForConversation(projects: IndexedProject[], nativeId: string | null, cwd: string): string | null {
  if (nativeId) return projects.find(p => p.id === nativeId || p.nativeIds.includes(nativeId))?.id ?? null;
  const directory = normalizeProjectPath(cwd);
  let winner: IndexedProject | undefined; let length = -1;
  for (const project of projects) for (const value of project.roots) {
    const root = normalizeProjectPath(value);
    if (root && root.length > length && (directory === root || directory.startsWith(root + '/'))) { winner = project; length = root.length; }
  }
  return winner?.id ?? null;
}
