import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPackage } from '@electron/asar';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { assessProtocols, DesktopCompatibility, protocolRegistries } from '../src/agent/compatibility.js';
import { CodexDesktop } from '../src/agent/desktop.js';
import { NativeIpc } from '../src/agent/ipc.js';
import { supportsDesktopCommand } from '../src/shared/protocol.js';

const protocols = {
  'thread-stream-state-changed': 11, 'thread-stream-following-changed': 1, 'thread-owner-discovery': 1,
  'thread-follower-start-turn': 2, 'thread-follower-interrupt-turn': 4, 'thread-follower-steer-turn': 1,
  'thread-follower-update-thread-settings': 1, 'thread-follower-command-approval-decision': 1,
  'thread-follower-file-approval-decision': 1, 'thread-follower-submit-user-input': 1, 'thread-read-state-changed': 2
};
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function installed(version: string, registry = protocols) {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-contract-')); directories.push(dir);
  const source = join(dir, 'source'); mkdirSync(join(source, '.vite/build'), { recursive: true }); mkdirSync(join(dir, 'app/resources'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(source, '.vite/build/renamed-module.js'), `const changedSymbol=${JSON.stringify(registry)}; throw new Error('This file must never execute');`);
  await createPackage(source, join(dir, 'app/resources/app.asar'));
  return { dir, exe: join(dir, 'app/ChatGPT.exe') };
}
function index(home: string) {
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT,name TEXT,title TEXT,cwd TEXT,updated_at_ms INTEGER,updated_at INTEGER,project_id TEXT,source TEXT,archived INTEGER,rollout_path TEXT); CREATE TABLE projects(id TEXT,name TEXT); CREATE TABLE project_roots(project_id TEXT,path TEXT);'); db.close();
}
describe('desktop contract compatibility', () => {
  it.each(['26.901.51231', '26.903.61454', '27.1.100-beta'])('accepts an unchanged contract independently of application version %s', async version => {
    const app = await installed(version, { ...protocols, 'thread-read-state-changed': 3 }); const inspector = new DesktopCompatibility();
    const result = inspector.inspect(app.exe); expect(result.appVersion).toBe(version); expect(assessProtocols(result.protocols).reason).toBeNull(); expect(inspector.inspect(app.exe)).toBe(result);
  });
  it('uses JavaScript tokens and literal objects, not comments, strings, or executable expressions', () => {
    const decoy = `/* ${JSON.stringify(protocols)} */ const text=${JSON.stringify(JSON.stringify(protocols))};`;
    expect(protocolRegistries(decoy)).toEqual([]); expect(protocolRegistries(decoy + `const actual=${JSON.stringify(protocols)}`)).toEqual([protocols]);
    expect(protocolRegistries(`const r={...unknown,${JSON.stringify(protocols).slice(1)}`)).toEqual([]);
    expect(protocolRegistries(`const r=${JSON.stringify(protocols).replace(':11', ':danger()')}`)).toEqual([]);
  });
  it('rejects conflicting definitions instead of choosing a permissive contract', async () => {
    const app = await installed('27.1.100'); const source = join(app.dir, 'source');
    writeFileSync(join(source, '.vite/build/conflict.js'), `const conflict=${JSON.stringify({ ...protocols, 'thread-follower-start-turn': 3 })};`);
    await createPackage(source, join(app.dir, 'app/resources/app.asar'));
    expect(() => new DesktopCompatibility().inspect(app.exe)).toThrow('通讯接口定义');
  });
  it('blocks incompatible transcript protocols but limits only affected write capabilities', () => {
    expect(() => assessProtocols({ ...protocols, 'thread-stream-state-changed': 12 })).toThrow('thread-stream-state-changed');
    const limited = assessProtocols({ ...protocols, 'thread-follower-start-turn': 3 });
    expect(limited.capabilities).toContain('stop-generation'); expect(limited.capabilities).not.toContain('send-messages'); expect(limited.capabilities).not.toContain('attachments'); expect(limited.reason).toContain('发送消息');
    const id = randomUUID(); expect(supportsDesktopCommand(limited.capabilities, { method: 'send', params: { id, epoch: 'x', text: 'blocked' } })).toBe(false);
    expect(supportsDesktopCommand(limited.capabilities, { method: 'stop', params: { id, epoch: 'x', turnId: 'turn' } })).toBe(true);
    expect(supportsDesktopCommand(undefined, { method: 'send', params: { id, epoch: 'x', text: 'legacy' } })).toBe(true);
  });
  it('supports the verified v2 settings contract without allowing unknown future versions', () => {
    const current = assessProtocols({ ...protocols, 'thread-follower-update-thread-settings': 2 });
    expect(current.capabilities).toContain('model-settings'); expect(current.capabilities).toContain('task-mode'); expect(current.capabilities).toContain('permission-settings'); expect(current.reason).toBeNull();
    const future = assessProtocols({ ...protocols, 'thread-follower-update-thread-settings': 3 });
    expect(future.capabilities).not.toContain('model-settings'); expect(future.capabilities).not.toContain('task-mode'); expect(future.capabilities).not.toContain('permission-settings'); expect(future.capabilities).toContain('stop-generation');
  });
  it('distinguishes a stopped client from an incompatible version', async () => {
    const adapter = new CodexDesktop('unused'); vi.spyOn(adapter as any, 'discover').mockResolvedValue({ version: null, processId: 0, executablePath: null, toolsPipe: null });
    try { expect(await adapter.status()).toMatchObject({ available: false, version: null, reason: expect.stringContaining('未检测到') }); } finally { adapter.close(); }
  });
  it('validates the original index read-only and reports the application version', async () => {
    const app = await installed('26.903.61454'); index(app.dir); const adapter = new CodexDesktop('unused', app.dir);
    const discover = vi.spyOn(adapter as any, 'discover').mockResolvedValue({ version: '26.903.8094.0', processId: 123, executablePath: app.exe, toolsPipe: 'fixture' }); vi.spyOn(NativeIpc.prototype, 'connect').mockResolvedValue();
    try {
      expect(await adapter.status()).toMatchObject({ available: true, version: '26.903.61454' }); await adapter.status(); expect(discover).toHaveBeenCalledTimes(1);
      const db = new DatabaseSync(join(app.dir, 'state_5.sqlite')); db.exec('ALTER TABLE threads DROP COLUMN project_id'); db.close(); Reflect.set(adapter, 'checkedAt', 0);
      expect(await adapter.status()).toMatchObject({ available: false, version: '26.903.61454', reason: expect.stringContaining('索引结构') });
    } finally { adapter.close(); }
  });
  it('keeps a validated tools pipe when discovery briefly loses the busy pipe', async () => {
    const app = await installed('26.903.61454'); index(app.dir); const adapter = new CodexDesktop('unused', app.dir);
    const discovery = { version: '26.903.8094.0', processId: 123, executablePath: app.exe, toolsPipe: 'fixture' };
    const discover = vi.spyOn(adapter as any, 'discover').mockResolvedValueOnce(discovery).mockResolvedValueOnce({ ...discovery, toolsPipe: null });
    vi.spyOn(NativeIpc.prototype, 'connect').mockResolvedValue();
    try {
      expect(await adapter.status()).toMatchObject({ available: true }); Reflect.set(adapter, 'checkedAt', 0);
      expect(await adapter.status()).toMatchObject({ available: true }); expect(discover).toHaveBeenCalledTimes(2);
    } finally { adapter.close(); }
  });
  it('identifies remote app-tool calls as Codex calls', async () => {
    const adapter = new CodexDesktop('unused'); Reflect.set(adapter, 'discovery', { version: 'fixture', processId: 123, executablePath: 'fixture', toolsPipe: 'fixture' });
    vi.spyOn(NativeIpc.prototype, 'connect').mockResolvedValue();
    const request = vi.spyOn(NativeIpc.prototype, 'request').mockResolvedValue({ result: { success: true, contentItems: [{ type: 'inputText', text: '{}' }] } });
    try {
      await (adapter as any).appTool('list_projects', {}, 'context');
      expect(request).toHaveBeenCalledWith('tools/call', expect.objectContaining({ namespace: 'codex_app', tool: 'list_projects', callerSource: 'codex' }));
    } finally { adapter.close(); }
  });
  it('denies incompatible commands before following a task or dispatching IPC', async () => {
    const adapter = new CodexDesktop('unused'); const limited = assessProtocols({ ...protocols, 'thread-follower-start-turn': 3 }); vi.spyOn(adapter, 'status').mockResolvedValue({ available: true, version: 'future', ...limited });
    const follow = vi.spyOn(adapter as any, 'follow'); const request = vi.spyOn(NativeIpc.prototype, 'request');
    try { await expect(adapter.execute({ method: 'send', params: { id: randomUUID(), epoch: 'x', text: 'do not send' } }, randomUUID())).rejects.toMatchObject({ code: 'UNSUPPORTED' }); expect(follow).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled(); } finally { adapter.close(); }
  });
  it('requires a valid project response and makes no write calls during readiness checks', async () => {
    const app = await installed('26.903.61454'); index(app.dir); const db = new DatabaseSync(join(app.dir, 'state_5.sqlite')); const file = join(app.dir, 'task.jsonl'); writeFileSync(file, ''); db.prepare('INSERT INTO threads(id,archived,source,rollout_path,updated_at) VALUES(?,0,?,?,1)').run(randomUUID(), 'vscode', file); db.close();
    const adapter = new CodexDesktop('unused', app.dir); vi.spyOn(adapter as any, 'discover').mockResolvedValue({ version: '26.903.8094.0', processId: 123, executablePath: app.exe, toolsPipe: 'fixture' }); vi.spyOn(NativeIpc.prototype, 'connect').mockResolvedValue(); const tool = vi.spyOn(adapter as any, 'appTool').mockResolvedValue({ unexpected: [] });
    try { expect(await adapter.status()).toMatchObject({ available: false, reason: expect.stringContaining('项目接口') }); expect(tool.mock.calls.map(call => call[0])).toEqual(['list_projects']); } finally { adapter.close(); }
  });
  it.each([2, 3])('keeps mobile read markers while only publishing the supported v2 desktop payload (v%s)', async version => {
    const app = await installed('fixture'); index(app.dir); const adapter = new CodexDesktop('unused', app.dir); const id = randomUUID();
    vi.spyOn(adapter, 'status').mockResolvedValue({ available: true, version: 'fixture', reason: null }); Reflect.set(adapter, 'contract', { protocols: { ...protocols, 'thread-read-state-changed': version } });
    vi.spyOn(adapter as any, 'taskActivity').mockReturnValue({ id, running: false, unread: true, completionId: 'done' }); vi.spyOn((adapter as any).runtimeActivity, 'read').mockResolvedValue(new Map([[id, false]]));
    const seen = vi.spyOn((adapter as any).activity, 'markSeen'); const broadcast = vi.spyOn(NativeIpc.prototype, 'broadcast').mockImplementation(() => {});
    try { expect(await adapter.execute({ method: 'seen', params: { id, completionId: 'done' } }, randomUUID())).toEqual({ seen: true }); expect(seen).toHaveBeenCalledWith(id, 'done'); expect(broadcast).toHaveBeenCalledTimes(version === 2 ? 1 : 0); } finally { adapter.close(); }
  });
});
