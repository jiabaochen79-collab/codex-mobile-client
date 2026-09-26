import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexDesktop } from '../src/agent/desktop.js';
const adapter = new CodexDesktop(resolve('release/RemoteCompanion.exe'));
try {
  console.log('status', await adapter.status());
  const list = await adapter.execute({ method: 'list', params: { offset: 0 } }, randomUUID()) as any;
  console.log('indexedConversations', list.conversations.length);
  const id = process.argv[2];
  if (process.argv.includes('--models')) {
    const result = await adapter.execute({ method: 'models', params: {} }, randomUUID()) as any;
    console.log('models', result.models.map((model: any) => model.id));
  }
  if (process.argv.includes('--projects')) {
    const result = await adapter.execute({ method: 'projects', params: {} }, randomUUID()) as any;
    console.log('projects', { count: result.projects?.length, validIds: result.projects?.filter((p: any) => typeof p.id === 'string' && p.id.length).length, validPaths: result.projects?.filter((p: any) => typeof p.path === 'string' && p.path.length).length });
  }
  if (id && !id.startsWith('--')) {
    const snapshot = await adapter.execute({ method: 'read', params: { id, limit: 20 } }, randomUUID()) as any;
    console.log('snapshot', { id: snapshot.id, busy: snapshot.busy, messages: snapshot.messages.length, requests: snapshot.requests.length, hasMore: snapshot.hasMore });
  }
} finally { adapter.close(); }
