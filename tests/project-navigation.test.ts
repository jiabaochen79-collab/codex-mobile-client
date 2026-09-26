import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodexDesktop } from '../src/agent/desktop.js';
import { normalizeProjectPath, projectForConversation, type IndexedProject } from '../src/agent/projects.js';
import { commandSchema } from '../src/shared/protocol.js';
const projects: IndexedProject[] = [
  { id: 'parent', name: '父项目', path: 'E:/work/app', roots: ['E:/work/app'], nativeIds: ['native-parent'] },
  { id: 'child', name: '子项目', path: 'E:/work/app/child', roots: ['E:/work/app/child', 'D:/alternate'], nativeIds: ['native-child'] }
];
let directory: string | undefined;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });
describe('project navigation', () => {
  it('matches Windows case, separators and extended paths without sibling-prefix collisions', () => {
    expect(normalizeProjectPath('\\\\?\\E:\\work\\APP\\')).toBe('e:/work/app');
    expect(projectForConversation(projects, null, 'e:\\WORK\\app\\src')).toBe('parent');
    expect(projectForConversation(projects, null, 'E:/work/app-other')).toBe(null);
    expect(projectForConversation(projects, null, '')).toBe(null);
  });
  it('uses the most specific directory and respects explicit native assignment', () => {
    expect(projectForConversation(projects, null, 'E:/work/app/child/src')).toBe('child');
    expect(projectForConversation(projects, null, 'D:/alternate/src')).toBe('child');
    expect(projectForConversation(projects, 'native-parent', 'E:/work/app/child')).toBe('parent');
    expect(projectForConversation(projects, 'unlisted', 'E:/work/app')).toBe(null);
  });
  it('filters before pagination and searches the whole index literally', () => {
    directory = mkdtempSync(join(tmpdir(), 'remote-project-test-'));
    const db = new DatabaseSync(join(directory, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT,name TEXT,title TEXT,cwd TEXT,updated_at_ms INTEGER,updated_at INTEGER,archived INTEGER,source TEXT,project_id TEXT,rollout_path TEXT)');
    const insert = db.prepare("INSERT INTO threads VALUES(?,NULL,?,?,1000,?,0,'vscode',NULL,NULL)");
    for (let i=0;i<40;i++) insert.run(`parent-${i}`, `Parent ${i}`, 'E:/work/app', 100+i);
    insert.run('old-child', '历史 100% 完成', 'E:/work/app/child', 1); insert.run('recent', '独立会话', 'C:/other', 200);
    db.prepare('UPDATE threads SET rollout_path=?').run(join(directory, 'state_5.sqlite')); db.close();
    const adapter = new CodexDesktop('unused', directory);
    try {
      expect(adapter.list(0,{projectId:'child'},projects).conversations.map(c=>c.id)).toEqual(['old-child']);
      expect(adapter.list(0,{projectId:'parent'},projects).hasMore).toBe(true);
      expect(adapter.list(30,{projectId:'parent'},projects).conversations).toHaveLength(10);
      expect(adapter.list(0,{projectId:null},projects).conversations.map(c=>c.id)).toEqual(['recent']);
      expect(adapter.list(0,{query:'%'},projects).conversations.map(c=>c.id)).toEqual(['old-child']);
      expect(adapter.list(0,{query:'parent 39'},projects).conversations.map(c=>c.id)).toEqual(['parent-39']);
    } finally { adapter.close(); }
  });
  it('sorts by millisecond timestamps when both timestamp columns exist', () => {
    directory = mkdtempSync(join(tmpdir(), 'remote-project-sort-test-'));
    const db = new DatabaseSync(join(directory, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT,name TEXT,title TEXT,cwd TEXT,updated_at_ms INTEGER,updated_at INTEGER,archived INTEGER,source TEXT,project_id TEXT,rollout_path TEXT)');
    const file = join(directory, 'task.jsonl'); writeFileSync(file, '');
    const insert = db.prepare("INSERT INTO threads VALUES(?,NULL,?,'E:/work/app',?,?,0,'vscode',NULL,?)");
    insert.run('seconds-newer', 'Seconds newer', 1000, 1, file); insert.run('milliseconds-newer', 'Milliseconds newer', 2000, 0, file); db.close();
    const adapter = new CodexDesktop('unused', directory);
    try { expect(adapter.list(0, {}, projects).conversations.map(c => c.id)).toEqual(['milliseconds-newer', 'seconds-newer']); }
    finally { adapter.close(); }
  });
  it('excludes archived and deleted records consistently from pages, search, project counts and reads', async () => {
    directory = mkdtempSync(join(tmpdir(), 'remote-lifecycle-test-'));
    const db = new DatabaseSync(join(directory, 'state_5.sqlite'));
    db.exec("CREATE TABLE threads(id TEXT,name TEXT,title TEXT,cwd TEXT,updated_at_ms INTEGER,updated_at INTEGER,archived INTEGER,source TEXT,project_id TEXT,rollout_path TEXT); CREATE TABLE projects(id TEXT,name TEXT); CREATE TABLE project_roots(project_id TEXT,path TEXT)");
    const activePath = join(directory, 'active.jsonl'); writeFileSync(activePath, '');
    mkdirSync(join(directory, 'archived_sessions')); const archivedPath = join(directory, 'archived_sessions', 'old.jsonl'); writeFileSync(archivedPath, '');
    const insert = db.prepare("INSERT INTO threads VALUES(?,NULL,?,'E:/work/app',1000,?,?,'vscode',NULL,?)");
    for (let i=0;i<35;i++) insert.run(`active-${i}`, `Active ${i}`, i, 0, activePath);
    insert.run('archived', 'Hidden archived', 100, 1, activePath);
    insert.run('deleted', 'Hidden deleted', 101, 0, join(directory, 'missing.jsonl'));
    insert.run('moved', 'Hidden moved', 102, 0, archivedPath);
    const adapter = new CodexDesktop('unused', directory);
    vi.spyOn(adapter as any, 'appTool').mockResolvedValue({projects:[{id:'parent',name:'Parent',path:'E:/work/app'}]});
    try {
      const first = adapter.list(0, {projectId:'parent'}, projects);
      expect(first.conversations).toHaveLength(30); expect(first.hasMore).toBe(true);
      expect(adapter.list(30, {projectId:'parent'}, projects).conversations).toHaveLength(5);
      expect(adapter.list(0, {query:'Hidden'}, projects).conversations).toEqual([]);
      expect((await (adapter as any).projects(true))[0].count).toBe(35);
      for (const id of ['archived','deleted','moved']) expect(() => (adapter as any).known(id)).toThrow(expect.objectContaining({code:'NOT_FOUND'}));
      expect(() => (adapter as any).known('active-0')).not.toThrow();
      db.prepare('UPDATE threads SET archived=1 WHERE id=?').run('active-0');
      db.prepare('DELETE FROM threads WHERE id=?').run('active-1');
      expect(adapter.list(30).conversations).toHaveLength(3);
      for (const id of ['active-0','active-1']) expect(() => (adapter as any).known(id)).toThrow(expect.objectContaining({code:'NOT_FOUND'}));
      rmSync(activePath);
      expect(adapter.list(0).conversations).toEqual([]);
    } finally { adapter.close(); db.close(); vi.restoreAllMocks(); }
  });
  it('uses a retained historical thread as the project context when no active thread remains', async () => {
    directory = mkdtempSync(join(tmpdir(), 'remote-project-context-test-'));
    const db = new DatabaseSync(join(directory, 'state_5.sqlite'));
    const file = join(directory, 'archived.jsonl'); writeFileSync(file, '');
    db.exec('CREATE TABLE threads(id TEXT,name TEXT,title TEXT,cwd TEXT,updated_at_ms INTEGER,updated_at INTEGER,archived INTEGER,source TEXT,project_id TEXT,rollout_path TEXT); CREATE TABLE projects(id TEXT,name TEXT); CREATE TABLE project_roots(project_id TEXT,path TEXT)');
    db.prepare("INSERT INTO threads VALUES(?,NULL,'Archived context','E:/work/app',1000,1,1,'vscode',NULL,?)").run('archived-context', file); db.close();
    const adapter = new CodexDesktop('unused', directory);
    const appTool = vi.spyOn(adapter as any, 'appTool').mockResolvedValue({ projects: [{ id: 'parent', name: 'Parent', path: 'E:/work/app' }] });
    try { await expect((adapter as any).projects(true)).resolves.toEqual([{ id: 'parent', name: 'Parent', path: 'E:/work/app', nativeIds: [], roots: ['E:/work/app'], count: 0 }]); expect(appTool).toHaveBeenCalledWith('list_projects', {}, 'archived-context'); }
    finally { adapter.close(); vi.restoreAllMocks(); }
  });
  it('accepts narrow project/search filters while rejecting privileged extras', () => {
    expect(commandSchema.safeParse({method:'list',params:{projectId:null,query:'hello'}}).success).toBe(true);
    expect(commandSchema.safeParse({method:'list',params:{projectId:'parent',cwd:'C:/'}}).success).toBe(false);
  });
});
