import { afterEach, expect, it, vi } from 'vitest';
import { CodexDesktop } from '../src/agent/desktop.js';

afterEach(() => vi.restoreAllMocks());

function pendingSnapshot() {
  const desktop = new CodexDesktop('unused'); const state = desktop as any;
  const discovery = { processId: 123, startedAt: 'started', executablePath: 'C:/Codex/Codex.exe', toolsPipe: 'tools', version: '1', cliExecutablePath: 'C:/Codex/bin/codex.exe' };
  const current = { id: 'task', owner: 'owner', revision: 1, state: { id: 'task', turns: [] } };
  state.discovery = discovery; state.current = current;
  vi.spyOn(state, 'index').mockReturnValue({ close() {} });
  let finish!: (value: { completionId: string }) => void;
  vi.spyOn(state, 'readyTaskActivity').mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const reading = state.snapshot();
  return { desktop, state, discovery, current, reading, finish: () => finish({ completionId: 'completion' }) };
}

it.each([{}, { version: '2' }, { cliExecutablePath: 'C:/Codex/new-bin/codex.exe' }])('keeps a task read valid across a routine discovery refresh: %j', async metadata => {
  const { desktop, state, discovery, reading, finish } = pendingSnapshot();
  try {
    state.discovery = { ...discovery, ...metadata }; finish();
    await expect(reading).resolves.toMatchObject({ id: 'task', epoch: '123:owner', completionId: 'completion' });
  } finally { desktop.close(); }
});

it.each([
  { processId: 456 }, { startedAt: 'restarted' },
  { executablePath: 'C:/Other/Codex.exe' }, { toolsPipe: 'new-tools' }
])('retries a task read when the desktop connection really changes: %j', async change => {
  const { desktop, state, discovery, reading, finish } = pendingSnapshot();
  try {
    state.discovery = { ...discovery, ...change }; finish();
    await expect(reading).rejects.toMatchObject({ code: 'CLIENT_UNAVAILABLE' });
  } finally { desktop.close(); }
});

it.each(['disconnect', 'task', 'owner'])('does not return a snapshot after a %s change', async change => {
  const { desktop, state, current, reading, finish } = pendingSnapshot();
  try {
    if (change === 'disconnect') state.discovery = undefined;
    else state.current = { ...current, ...(change === 'task' ? { id: 'other-task' } : { owner: 'new-owner' }) };
    finish(); await expect(reading).rejects.toMatchObject({ code: 'CLIENT_UNAVAILABLE' });
  } finally { desktop.close(); }
});
