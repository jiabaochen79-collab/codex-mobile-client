import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { submitDesktopQuestion } from '../src/agent/desktop-question.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const identity = { processId: 42, startedAt: 'ticks', executablePath: 'desktop' };
const request = { id: 'request', kind: 'input' as const, title: 'question', detail: '', questions: [{ id: 'q1', question: 'First?', options: [] }, { id: 'q2', question: 'Second?', options: [] }] };
const answers = { q1: [' First answer '], q2: ['Second answer'] };
let child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
let input: string;
beforeEach(() => {
  vi.useFakeTimers(); input = '';
  child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
  child.stdin.on('data', data => { input += data; });
  vi.mocked(spawn).mockReturnValue(child as any);
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
const submit = (check = vi.fn().mockResolvedValue(undefined)) => submitDesktopQuestion('helper', identity, 'Task title', request, answers, check);
it('sends only the device identity and the selected question answers, then checks authorization before native submission', async () => {
  const check = vi.fn().mockResolvedValue(undefined);
  const result = submit(check); await vi.advanceTimersByTimeAsync(0);
  expect(check).toHaveBeenCalledTimes(1);
  expect(input).toBe(JSON.stringify({ ...identity, title: 'Task title', answers: [{ question: 'First?', answer: 'First answer' }, { question: 'Second?', answer: 'Second answer' }] }) + '\n');
  child.stdout.write('{"rea'); child.stdout.write('dy":true}\n'); await vi.advanceTimersByTimeAsync(0);
  expect(check).toHaveBeenCalledTimes(2); expect(input.endsWith('submit\n')).toBe(true);
  child.stdout.write('{"submitted":true,"closed":true}\n'); child.emit('close', 0);
  await expect(result).resolves.toEqual({ closed: true }); expect(child.kill).not.toHaveBeenCalled();
});
it('does not click submit when authorization changes during native preparation', async () => {
  const check = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce({ code: 'STALE' });
  const result = submit(check); const assertion = expect(result).rejects.toMatchObject({ code: 'STALE' });
  await vi.advanceTimersByTimeAsync(0); child.stdout.write('{"ready":true}\n'); await vi.advanceTimersByTimeAsync(0);
  await assertion; expect(input).not.toContain('submit\n'); expect(child.kill).toHaveBeenCalledOnce();
});
it.each(['before', 'after'])('keeps a %s-submit timeout distinct and never retries the operation', async phase => {
  const result = submit(); const assertion = expect(result).rejects.toMatchObject({ code: phase === 'before' ? 'CLIENT_UNAVAILABLE' : 'OUTCOME_UNKNOWN' });
  await vi.advanceTimersByTimeAsync(0);
  if (phase === 'after') { child.stdout.write('{"ready":true}\n'); await vi.advanceTimersByTimeAsync(0); }
  await vi.advanceTimersByTimeAsync(21000); await assertion;
  expect(spawn).toHaveBeenCalledOnce(); expect(child.kill).toHaveBeenCalledOnce();
});
it.each(['CLIENT_UNAVAILABLE', 'OUTCOME_UNKNOWN'])('preserves native %s errors without a transport fallback', async error => {
  const result = submit(); const assertion = expect(result).rejects.toMatchObject({ code: error }); await vi.advanceTimersByTimeAsync(0);
  child.stdout.write(JSON.stringify({ error, stage: 'card' }) + '\n'); await assertion;
  expect(spawn).toHaveBeenCalledOnce();
});
it.each(['bad json\n', '{"unknown":true}\n', 'x'.repeat(4097)])('rejects incompatible native output', async output => {
  const result = submit(); const assertion = expect(result).rejects.toMatchObject({ code: 'CLIENT_UNAVAILABLE' }); await vi.advanceTimersByTimeAsync(0);
  child.stdout.write(output); await assertion;
});
it('reports a submitted card that has not closed for the caller to reconcile', async () => {
  const result = submit(); await vi.advanceTimersByTimeAsync(0); child.stdout.write('{"ready":true}\n'); await vi.advanceTimersByTimeAsync(0);
  child.stdout.write('{"submitted":true,"closed":false}\n'); child.emit('close', 0);
  await expect(result).resolves.toEqual({ closed: false });
});
it('rejects missing identity before starting native code', async () => {
  await expect(submitDesktopQuestion('helper', { ...identity, startedAt: undefined }, 'Task title', request, answers, vi.fn())).rejects.toMatchObject({ code: 'CLIENT_UNAVAILABLE' });
  expect(spawn).not.toHaveBeenCalled();
});
