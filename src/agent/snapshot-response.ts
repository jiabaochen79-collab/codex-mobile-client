import { hash } from '../shared/security.js';
import type { Snapshot } from '../shared/protocol.js';
export function snapshotResponse(snapshot: Snapshot, expected?: string) {
  const { revision: _revision, ...body } = snapshot;
  const revision = hash(JSON.stringify(body));
  return expected === revision ? { id: snapshot.id, epoch: snapshot.epoch, revision, notModified: true as const } : { ...body, revision };
}
