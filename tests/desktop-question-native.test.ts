import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { expect, it } from 'vitest';

const valid = { processId: process.pid, startedAt: 'wrong-time', executablePath: process.execPath, title: 'fixture', answers: [{ question: 'First?', answer: 'Answer' }] };
it.skipIf(process.platform !== 'win32')('matches normalized free-form cards without crossing document boundaries or accepting ambiguous editors', () => {
  mkdirSync('.runtime', { recursive: true });
  const dir = mkdtempSync(resolve('.runtime/question-native-'));
  try {
    const executable = resolve(dir, 'QuestionFixture.exe');
    const framework = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/WPF/';
    execFileSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', ['/nologo', '/target:exe', '/platform:x64', '/utf8output', `/out:${executable}`, '/reference:System.Web.Extensions.dll', '/reference:System.Xaml.dll', ...['WindowsBase', 'PresentationCore', 'PresentationFramework', 'UIAutomationClient', 'UIAutomationTypes'].map(name => `/reference:${framework}${name}.dll`), resolve('tests/desktop-question-fixture.cs')], { windowsHide: true });
    const results = JSON.parse(execFileSync(executable, [resolve('release/RemoteCompanion.exe')], { encoding: 'utf8', windowsHide: true, timeout: 20000 }));
    expect(results).toEqual(['shallow', 'free-form-deep', 'minimized', 'ambiguous', 'wrong-question', 'wrong-title', 'document-boundary', 'closed']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 25000);
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
