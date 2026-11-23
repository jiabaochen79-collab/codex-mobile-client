import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { CompletionMonitor } from '../src/agent/notifications.js';
import { AgentStore } from '../src/agent/store.js';

it('classifies real 0.171 task_complete errors as failures without uploading error bodies', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-native-notification-'));
  const store = new AgentStore(directory), taskId = randomUUID(), file = join(directory, 'rollout.jsonl');
  const monitor = new CompletionMonitor(store, () => [{ id: taskId, path: file }]);
  try {
    monitor.watch(taskId, 0);
    writeFileSync(file, [
      { type: 'task_complete', turn_id: 'failed', error: { message: 'fixture-private-error', codex_error_info: 'other' }, last_agent_message: null },
      { type: 'task_complete', turn_id: 'completed', error: null, last_agent_message: 'fixture-private-reply' },
      { type: 'task_complete', turn_id: 'legacy-completed' },
      { type: 'turn_aborted', turn_id: 'stopped', reason: 'user' }
    ].map(payload => JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload })).join('\n') + '\n');
    await monitor.poll();
    const events = store.notificationOutbox();
    expect(events.map(event => [event.turnId, event.status])).toEqual([['failed', 'failed'], ['completed', 'completed'], ['legacy-completed', 'completed']]);
    expect(JSON.stringify(events)).not.toContain('fixture-private');
  } finally {
    monitor.close(); store.close();
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('codex-native-notification-')) throw new Error('Unexpected notification fixture directory');
    rmSync(directory, { recursive: true, force: true });
  }
});
