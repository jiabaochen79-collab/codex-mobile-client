import { expect, it } from 'vitest';
import { collaborationMode, threadSettings } from '../src/agent/models.js';

it('preserves an explicit native default effort when switching plan mode', () => {
  const settings = threadSettings({ latestThreadSettings: { model: 'current', effort: null, collaborationMode: { mode: 'default', settings: { model: 'current', reasoning_effort: null } } }, latestReasoningEffort: 'high' });
  expect(settings.effort).toBeNull();
  expect(collaborationMode(settings, 'plan').settings.reasoning_effort).toBeNull();
});
it('uses legacy effort only when authoritative settings do not provide it', () => {
  expect(threadSettings({ latestThreadSettings: { model: 'current' }, latestReasoningEffort: 'high' }).effort).toBe('high');
  expect(threadSettings({ latestThreadSettings: { model: 'current', collaborationMode: { mode: 'default', settings: { reasoning_effort: null } } }, latestReasoningEffort: 'high' }).effort).toBeNull();
});
