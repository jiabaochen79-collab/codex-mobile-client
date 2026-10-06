import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeIpc } from '../src/agent/ipc.js';
function frame(message: unknown) { const data = Buffer.from(JSON.stringify(message)); const header = Buffer.alloc(4); header.writeUInt32LE(data.length); return Buffer.concat([header, data]); }
describe('native IPC transport', () => {
  let server: net.Server; let client: NativeIpc; let peer: net.Socket;
  afterEach(async () => { client?.close(); peer?.destroy(); if (server) await new Promise<void>(r => server.close(() => r())); });
  async function start(handle: (socket: net.Socket, data: any) => void) {
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\remote-test-${randomUUID()}` : join(tmpdir(), `remote-${randomUUID()}.sock`);
    server = net.createServer(socket => { peer = socket; let buffer = Buffer.alloc(0); socket.on('data', d => { buffer = Buffer.concat([buffer, d]); while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) { const n = buffer.readUInt32LE(); const m = JSON.parse(buffer.subarray(4,n+4).toString()); buffer = buffer.subarray(n+4); handle(socket, m); } }); });
    await new Promise<void>(r => server.listen(pipe, r)); client = new NativeIpc(pipe); await client.connect();
  }
  it('handles split frames and exact request correlation', async () => {
    await start((socket, m) => {
      const reply = frame({ type: 'response', requestId: m.requestId, resultType: 'success', method: m.method, result: m.method === 'initialize' ? { clientId: 'fixture-client' } : { echoed: m.params } });
      socket.write(reply.subarray(0,2)); socket.write(reply.subarray(2,9)); socket.write(reply.subarray(9));
    });
    expect(client.clientId).toBe('fixture-client'); const result = await client.request('test', { value: '你好' }); expect(result.result.echoed.value).toBe('你好');
  });
  it('preserves actionable rejection reasons without exposing credential fields or extra lines', async () => {
    await start((socket, m) => socket.write(frame(m.method === 'initialize' ? { type: 'response', requestId: m.requestId, resultType: 'success', result: { clientId: 'fixture' } } : { type: 'response', requestId: m.requestId, resultType: 'error', error: { code: 'PERMISSION_DENIED', message: 'workspace is read-only; token=fixture-secret\nprivate details' } })));
    await expect(client.request('write', {})).rejects.toMatchObject({ code: 'CLIENT_DENIED', message: '电脑客户端拒绝操作：workspace is read-only; token=[redacted]' });
  });
  it('does not claim it can handle requests for the desktop client', async () => {
    let response: any;
    await start((socket, m) => { if (m.method === 'initialize') socket.write(frame({ type: 'response', requestId: m.requestId, resultType: 'success', result: { clientId: 'fixture' } })); else response = m; });
    peer.write(frame({ type: 'client-discovery-request', requestId: 'probe', request: { method: 'thread-follower-start-turn' } }));
    await new Promise(r => setTimeout(r,40)); expect(response.response.canHandle).toBe(false);
  });
  it('treats disconnect after dispatch as unknown outcome instead of retrying', async () => {
    await start((socket, m) => { if (m.method === 'initialize') socket.write(frame({ type: 'response', requestId: m.requestId, resultType: 'success', result: { clientId: 'fixture' } })); else socket.destroy(); });
    await expect(client.request('write', {})).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
  });
  it('rejects pending calls and ignores late frames after a local close', async () => {
    await start((socket, m) => { if (m.method === 'initialize') socket.write(frame({ type: 'response', requestId: m.requestId, resultType: 'success', result: { clientId: 'fixture' } })); });
    const call = client.request('pending', {}); const check = expect(call).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    client.close(); await check;
    expect(client.clientId).toBe('initializing-client');
  });
  it('rejects malformed initialization and does not cache an uninitialized socket as ready', async () => {
    let initializations = 0;
    await expect(start((socket, m) => { initializations++; socket.write(frame({ type: 'response', requestId: m.requestId, resultType: 'success', result: {} })); })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(client.connect()).rejects.toMatchObject({ code: 'UNSUPPORTED' }); expect(initializations).toBe(2); expect(client.clientId).toBe('initializing-client');
  });
  it('treats unrecognized success envelopes and mismatched methods as uncertain, not accepted', async () => {
    await start((socket, m) => socket.write(frame({ type: 'response', requestId: m.requestId, resultType: m.method === 'unknown' ? 'new-success-type' : 'success', method: m.method === 'mismatch' ? 'different' : m.method, result: { clientId: 'fixture' } })));
    await expect(client.request('unknown', {})).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    await expect(client.request('mismatch', {})).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
  });
});
