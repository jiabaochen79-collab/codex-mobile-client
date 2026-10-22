import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexDesktop } from '../src/agent/desktop.js';
import { RemoteError } from '../src/shared/protocol.js';

afterEach(() => vi.restoreAllMocks());

function frame(message: unknown) {
  const body = Buffer.from(JSON.stringify(message)); const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

async function fixture(failure = 'success') {
  const id = randomUUID(), commandId = randomUUID();
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\steering-test-${randomUUID()}` : join(tmpdir(), `steer-${randomUUID()}.sock`);
  const adapter = new CodexDesktop('unused'); const state = adapter as any;
  const native = { id, cwd: 'C:/fixture', turns: [{ turnId: 'active-turn', status: 'inProgress', items: [] }] };
  const next = structuredClone(native); const requests: any[] = []; let accepted = 0;
  const control = { duringDiscovery: () => {} };
  let peer: net.Socket | undefined;
  const server = net.createServer(socket => {
    peer = socket; let buffer = Buffer.alloc(0);
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const length = buffer.readUInt32LE(); const message = JSON.parse(buffer.subarray(4, length + 4).toString()); buffer = buffer.subarray(length + 4);
        const reply = (body: object) => socket.write(frame({ type: 'response', requestId: message.requestId, method: message.method, ...body }));
        if (message.method === 'initialize') reply({ resultType: 'success', result: { clientId: 'test-helper' } });
        else if (message.type === 'request') {
          requests.push(message);
          if (message.method === 'thread-owner-discovery') { control.duringDiscovery(); reply({ resultType: 'success', handledByClientId: 'new-owner', result: {} }); }
          else if (message.method === 'thread-follower-steer-turn') {
            if (failure === 'unknown') socket.destroy();
            else if (failure === 'denied') reply({ resultType: 'error', handledByClientId: 'old-owner', error: { code: 'PERMISSION_DENIED', message: 'not allowed' } });
            else if (failure === 'forwarded') reply({ resultType: 'error', handledByClientId: 'old-owner', error: 'no-client-found' });
            else if (message.targetClientId === 'old-owner' || failure === 'route') reply({ resultType: 'error', error: 'no-client-found' });
            else { accepted++; reply({ resultType: 'success', handledByClientId: 'new-owner', result: {} }); }
          }
        } else if (message.method === 'thread-stream-following-changed' && message.params.following) {
          socket.write(frame({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'new-owner', params: { hostId: 'local', conversationId: id, change: { type: 'snapshot', conversationState: next, revision: 1 } } }));
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(pipe, resolve));
  state.ipc.pipe = pipe; await state.ipc.connect();
  state.discovery = { processId: 123, startedAt: 'original-start', executablePath: 'C:/Codex.exe', toolsPipe: 'fixture-tools' };
  state.current = { id, owner: 'old-owner', revision: 1, ownerCheckedAt: Date.now(), state: native }; state.followed.set(id, state.current);
  vi.spyOn(state, 'ready').mockResolvedValue(undefined);
  vi.spyOn(state, 'known').mockImplementation(() => {});
  vi.spyOn(state, 'index').mockReturnValue({ close() {} });
  vi.spyOn(state, 'readyTaskActivity').mockResolvedValue({ completionId: null });
  vi.spyOn(state, 'nativeQueuedCount').mockReturnValue(0);
  return { state, next, requests, control, commandId, accepted: () => accepted,
    send: (authorize?: () => void) => adapter.execute({ method: 'send', params: { id, epoch: '123:old-owner', mode: 'steer', turnId: 'active-turn', text: 'Keep the original direction text.' } }, commandId, authorize),
    async close() { adapter.close(); peer?.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
  };
}

it('refreshes the cached owner before delivering steering once to the same active turn', async () => {
  const f = await fixture('success'); const authorize = vi.fn();
  try {
    await expect(f.send(authorize)).resolves.toEqual({ accepted: true });
    expect(f.requests.map(request => request.method)).toEqual(['thread-owner-discovery', 'thread-follower-steer-turn']);
    const request = f.requests[1];
    expect(request.targetClientId).toBe('new-owner');
    expect(request.params.clientUserMessageId).toBe(f.commandId);
    expect(request.params.input).toEqual([{ type: 'text', text: 'Keep the original direction text.', text_elements: [] }]);
    expect(f.accepted()).toBe(1); expect(authorize).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it.each(['completed', 'new-turn', 'restarted'])('does not dispatch steering after the target is %s', async change => {
  const f = await fixture();
  if (change === 'completed') f.next.turns[0].status = 'completed';
  if (change === 'new-turn') f.next.turns[0].turnId = 'different-turn';
  if (change === 'restarted') f.control.duringDiscovery = () => { f.state.discovery = { ...f.state.discovery, startedAt: 'new-start' }; };
  try {
    await expect(f.send()).rejects.toMatchObject({ code: change === 'restarted' ? 'CLIENT_UNAVAILABLE' : 'STALE' });
    expect(f.requests.map(request => request.method)).toEqual(['thread-owner-discovery']);
    expect(f.accepted()).toBe(0);
  } finally { await f.close(); }
});

it('checks authorization after refreshing the owner and before dispatching steering', async () => {
  const f = await fixture('success'); let allowed = true;
  f.control.duringDiscovery = () => { allowed = false; };
  const authorize = () => { if (!allowed) throw new RemoteError('CLIENT_DENIED', 'control revoked'); };
  try {
    await expect(f.send(authorize)).rejects.toMatchObject({ code: 'CLIENT_DENIED' });
    expect(f.requests.filter(request => request.method === 'thread-follower-steer-turn')).toHaveLength(0); expect(f.accepted()).toBe(0);
  } finally { await f.close(); }
});

it.each(['forwarded', 'denied', 'unknown'])('never replays a %s steering failure', async failure => {
  const f = await fixture(failure);
  try {
    await expect(f.send()).rejects.toMatchObject({ code: failure === 'denied' ? 'CLIENT_DENIED' : failure === 'unknown' ? 'OUTCOME_UNKNOWN' : 'CLIENT_REJECTED' });
    expect(f.requests.map(request => request.method)).toEqual(['thread-owner-discovery', 'thread-follower-steer-turn']); expect(f.accepted()).toBe(0);
  } finally { await f.close(); }
});

it('never replays a rejected dispatch and returns an actionable connection error', async () => {
  const f = await fixture('route');
  try {
    await expect(f.send()).rejects.toMatchObject({ code: 'CLIENT_UNAVAILABLE' });
    expect(f.requests.map(request => request.method)).toEqual(['thread-owner-discovery', 'thread-follower-steer-turn']);
    expect(f.accepted()).toBe(0);
  } finally { await f.close(); }
});
