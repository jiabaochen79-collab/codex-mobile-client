import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexDesktop } from '../src/agent/desktop.js';
import { NativeIpc } from '../src/agent/ipc.js';
import { commandSchema, supportsDesktopCommand, type Command, type Snapshot } from '../src/shared/protocol.js';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: vi.fn()
}));

afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });
describe('desktop settings versions', () => {
  it.each([1, 2])('updates only next-turn settings using protocol v%s', async version => {
    const home = mkdtempSync(join(tmpdir(), 'settings-version-'));
    const adapter = new CodexDesktop('unused', home);
    Reflect.set(adapter, 'discovery', { cliExecutablePath: 'C:/Codex/bin/codex.exe' });
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ models: [{ slug: 'model', display_name: 'Model', default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'high' }] }] }));
    const snap: Snapshot = { id: randomUUID(), title: 'Fixture', epoch: 'epoch', turnId: 'active-turn', busy: true, messages: [], requests: [], hasMore: false, settings: { model: 'model', effort: 'high', mode: 'default', revision: 'revision' } };
    Reflect.set(adapter, 'contract', { protocols: { 'thread-follower-update-thread-settings': version } });
    Reflect.set(adapter, 'current', { id: snap.id, owner: 'owner', state: {}, revision: 1 });
    vi.spyOn(adapter as any, 'ready').mockResolvedValue(undefined); vi.spyOn(adapter as any, 'follow').mockResolvedValue(undefined); vi.spyOn(adapter as any, 'snapshot').mockReturnValue(snap);
    const request = vi.spyOn(NativeIpc.prototype, 'request').mockResolvedValue({ resultType: 'success', result: { applied: true } }); const authorize = vi.fn();
    try {
      const base = { id: snap.id, epoch: snap.epoch, revision: snap.settings!.revision };
      const commands: Command[] = [{ method: 'mode.update', params: { ...base, mode: 'plan' } }, { method: 'settings.update', params: { ...base, model: 'model', effort: 'high' } }];
      for (const command of commands) await adapter.execute(command, randomUUID(), authorize);
      expect(request).toHaveBeenCalledTimes(2); expect(authorize).toHaveBeenCalledTimes(2);
      for (const [method, params, actualVersion, owner] of request.mock.calls) {
        expect(method).toBe('thread-follower-update-thread-settings'); expect(actualVersion).toBe(version); expect(owner).toBe('owner');
        expect((params as any).activeTurnId).toBe(version === 2 ? null : undefined);
        expect(Object.keys((params as any).threadSettings)).not.toContain('sandboxPolicy');
      }
      if (version === 2) {
        for (const [result, code] of [[{ applied: false }, 'STALE'], [{}, 'OUTCOME_UNKNOWN']] as const) {
          request.mockResolvedValue({ resultType: 'success', result });
          await expect(adapter.execute(commands[0], randomUUID())).rejects.toMatchObject({ code });
        }
      }
    } finally { adapter.close(); rmSync(home, { recursive: true, force: true }); }
  });
  it.each([
    ['ask', { permissions: ':workspace', approvalPolicy: 'on-request', approvalsReviewer: 'user' }],
    ['approve', { permissions: ':workspace', approvalPolicy: 'on-request', approvalsReviewer: 'guardian_subagent' }],
    ['full', { permissions: ':danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' }]
  ] as const)('maps %s to a named native permission profile without a sandbox override', async (permission, expected) => {
    const home = mkdtempSync(join(tmpdir(), 'permission-version-')); const adapter = new CodexDesktop('unused', home);
    const snap: Snapshot = { id: randomUUID(), title: 'Fixture', epoch: 'epoch', turnId: 'active-turn', busy: true, messages: [], requests: [], hasMore: false, settings: { model: 'model', effort: 'high', mode: 'default', permission: 'ask', revision: 'revision' } };
    Reflect.set(adapter, 'contract', { protocols: { 'thread-follower-update-thread-settings': 2 } }); Reflect.set(adapter, 'current', { id: snap.id, owner: 'owner', state: {}, revision: 1 });
    vi.spyOn(adapter as any, 'ready').mockResolvedValue(undefined); vi.spyOn(adapter as any, 'follow').mockResolvedValue(undefined); vi.spyOn(adapter as any, 'snapshot').mockReturnValue(snap);
    const request = vi.spyOn(NativeIpc.prototype, 'request').mockResolvedValue({ resultType: 'success', result: { applied: true } }); const authorize = vi.fn();
    const command = commandSchema.parse({ method: 'permissions.update', params: { id: snap.id, epoch: snap.epoch, revision: snap.settings!.revision, permission } });
    try {
      await adapter.execute(command, randomUUID(), authorize); expect(authorize).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith('thread-follower-update-thread-settings', { conversationId: snap.id, threadSettings: expected, activeTurnId: null }, 2, 'owner');
      expect((request.mock.calls[0][1] as any).threadSettings).not.toHaveProperty('sandboxPolicy');
      expect(supportsDesktopCommand(undefined, command)).toBe(false); expect(supportsDesktopCommand(['permission-settings'], command)).toBe(true);
    } finally { adapter.close(); rmSync(home, { recursive: true, force: true }); }
  });
});
