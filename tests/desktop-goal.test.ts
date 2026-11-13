import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { operateDesktopGoal } from '../src/agent/desktop-goal.js';
import type { ThreadGoal } from '../src/shared/protocol.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const identity = { processId: 42, startedAt: 'ticks', executablePath: 'desktop' };
const goal: ThreadGoal = { threadId: '12345678-1234-4234-8234-123456789abc', objective: 'Only this goal', status: 'blocked', tokenBudget: null, tokensUsed: 10, timeUsedSeconds: 1, createdAt: 1700000000, updatedAt: 1700000001, revision: 'a'.repeat(64) };
let child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; kill: ReturnType<typeof vi.fn> }, input: string;
beforeEach(() => {
  vi.useFakeTimers(); input = '';
  child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
  child.stdin.on('data', data => { input += data; }); vi.mocked(spawn).mockReturnValue(child as any);
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
it.each(['resume', 'clear'] as const)('reauthorizes and rechecks the goal before native %s without exposing other task contents', async action => {
  const check = vi.fn().mockResolvedValue(undefined);
  const result = operateDesktopGoal('helper', identity, 'Task title', goal, action, check); await vi.advanceTimersByTimeAsync(0);
  expect(JSON.parse(input)).toEqual({ ...identity, title: 'Task title', objective: goal.objective, action });
  child.stdout.write('{"rea'); child.stdout.write('dy":true}\n'); await vi.advanceTimersByTimeAsync(0);
  expect(check).toHaveBeenCalledTimes(2); expect(input.endsWith('submit\n')).toBe(true);
  child.stdout.write('{"submitted":true}\n'); child.emit('close', 0); await result;
  expect(spawn).toHaveBeenCalledOnce(); expect(child.kill).not.toHaveBeenCalled();
});
it('does not click a goal after authorization or revision changes', async () => {
  const check = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce({ code: 'STALE' });
  const result = operateDesktopGoal('helper', identity, 'Task title', goal, 'clear', check);
  const assertion = expect(result).rejects.toMatchObject({ code: 'STALE' });
  await vi.advanceTimersByTimeAsync(0); child.stdout.write('{"ready":true}\n'); await vi.advanceTimersByTimeAsync(0); await assertion;
  expect(input).not.toContain('submit\n'); expect(child.kill).toHaveBeenCalledOnce();
});
it.each([false, true])('does not retry a native timeout (submitted=%s)', async committing => {
  const result = operateDesktopGoal('helper', identity, 'Task title', goal, 'resume', vi.fn().mockResolvedValue(undefined));
  const assertion = expect(result).rejects.toMatchObject({ code: committing ? 'OUTCOME_UNKNOWN' : 'CLIENT_UNAVAILABLE' });
  await vi.advanceTimersByTimeAsync(0);
  if (committing) { child.stdout.write('{"ready":true}\n'); await vi.advanceTimersByTimeAsync(0); }
  await vi.advanceTimersByTimeAsync(21000); await assertion;
  expect(spawn).toHaveBeenCalledOnce(); expect(child.kill).toHaveBeenCalledOnce();
});
it('refuses to operate without the verified desktop identity', async () => {
  await expect(operateDesktopGoal('helper', { ...identity, startedAt: undefined }, 'Task title', goal, 'clear', vi.fn())).rejects.toMatchObject({ code: 'CLIENT_UNAVAILABLE' });
  expect(spawn).not.toHaveBeenCalled();
});
