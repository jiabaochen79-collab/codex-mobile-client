import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const valid = { processId: process.pid, startedAt: 'wrong-time', executablePath: process.execPath, title: 'fixture', answers: [{ question: 'First?', answer: 'Answer' }] };
it.skipIf(process.platform !== 'win32').each([
  null, {}, { ...valid, title: '' }, { ...valid, answers: [] },
  { ...valid, answers: [null] },
  { ...valid, answers: [{ question: '', answer: 'Answer' }] },
  { ...valid, answers: [{ question: 'First?', answer: ' ' }] },
  { ...valid, answers: [{ question: 'First?', answer: 'x'.repeat(4001) }] }
])('rejects invalid native input without touching a desktop card: %j', input => {
  const output = execFileSync(resolve('release/RemoteCompanion.exe'), ['--desktop-question'], { input: JSON.stringify(input) + '\nsubmit\n', encoding: 'utf8', windowsHide: true, timeout: 10000 });
  expect(JSON.parse(output)).toMatchObject({ error: 'CLIENT_UNAVAILABLE', stage: 'input' });
  expect(output).not.toContain('submitted');
});
it.skipIf(process.platform !== 'win32')('refuses a non-Codex process even when it belongs to the current user', () => {
  const output = execFileSync(resolve('release/RemoteCompanion.exe'), ['--desktop-question'], { input: JSON.stringify(valid) + '\nsubmit\n', encoding: 'utf8', windowsHide: true, timeout: 10000 });
  expect(JSON.parse(output)).toMatchObject({ error: 'CLIENT_UNAVAILABLE' });
  expect(output).not.toContain('"ready":true'); expect(output).not.toContain('submitted');
});
