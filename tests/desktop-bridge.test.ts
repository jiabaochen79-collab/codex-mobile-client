import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopBroker, type RpcMessage } from '../src/bridge/broker.js';

afterEach(() => vi.useRealTimers());
function fixture() {
  const executor = vi.fn<(message: RpcMessage) => void>(), desktop = vi.fn<(message: RpcMessage) => void>();
  const broker = new DesktopBroker(executor, desktop);
  const response = vi.fn<(message: RpcMessage) => void>();
  const client = broker.connect(response);
  const initialize = () => { broker.fromDesktop({ id: 1, method: 'initialize', params: {} }); broker.fromExecutor({ id: 1, result: { userAgent: 'codex-cli/0.171', codexHome: 'C:/Fixture' } }); };
  return { broker, executor, desktop, response, client, initialize };
}

describe('shared desktop executor broker', () => {
  it('waits for the original desktop handshake and never initializes another executor', () => {
    const f = fixture();
    expect(() => f.client.request('read', 'thread/read', { threadId: 'task' })).toThrow('尚未就绪');
    expect(f.executor).not.toHaveBeenCalled(); f.initialize();
    expect(f.client.status()).toMatchObject({ ready: true, userAgent: 'codex-cli/0.171' });
    expect(f.executor.mock.calls.filter(([message]) => message.method === 'initialize')).toHaveLength(1);
    f.broker.close();
  });
  it('separates desktop and helper request IDs and preserves the native result', () => {
    const f = fixture(); f.initialize(); f.client.request(1, 'thread/read', { threadId: 'task' });
    const sent = f.executor.mock.calls.at(-1)![0];
    expect(sent.id).not.toBe(1); expect(sent.method).toBe('thread/read');
    f.desktop.mockClear(); f.broker.fromExecutor({ id: sent.id, result: { thread: { id: 'task' } } });
    expect(f.response).toHaveBeenLastCalledWith({ id: 1, result: { thread: { id: 'task' } } });
    expect(f.desktop).not.toHaveBeenCalled(); f.broker.close();
  });
  it('keeps account-token refreshes exclusively on the original desktop connection', () => {
    const f = fixture(); f.initialize();
    const request = { id: 10, method: 'account/chatgptAuthTokens/refresh', params: { refreshReason: 'unauthorized' } };
    f.broker.fromExecutor(request); expect(f.desktop).toHaveBeenLastCalledWith(request); expect(f.response).not.toHaveBeenCalled();
    expect(() => f.client.request('login', 'account/login/start', {})).toThrow('不属于');
    f.broker.close();
  });
  it('only accepts approval confirmation from the matching native resolved event', () => {
    const f = fixture(); f.initialize();
    f.broker.fromExecutor({ id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: 'task', turnId: 'turn' } });
    f.client.respond('answer', 9, 'task', 'turn', { decision: 'accept' });
    expect(f.response).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'answer' }));
    f.broker.fromExecutor({ method: 'serverRequest/resolved', params: { requestId: 9, threadId: 'other' } });
    expect(f.response).not.toHaveBeenCalledWith({ id: 'answer', result: { accepted: true } });
    f.broker.fromExecutor({ method: 'serverRequest/resolved', params: { requestId: 9, threadId: 'task' } });
    expect(f.response).toHaveBeenCalledWith({ id: 'answer', result: { accepted: true } }); f.broker.close();
  });
  it('rejects cross-task and stale-turn replies without writing to the executor', () => {
    const f = fixture(); f.initialize();
    f.broker.fromExecutor({ id: 'request', method: 'item/tool/requestUserInput', params: { threadId: 'task', turnId: 'turn' } });
    f.executor.mockClear();
    expect(() => f.client.respond('wrong', 'request', 'other', 'turn', { answers: {} })).toThrow('已经变化');
    expect(() => f.client.respond('wrong', 'request', 'task', 'old', { answers: {} })).toThrow('已经变化');
    expect(f.executor).not.toHaveBeenCalled(); f.broker.close();
  });
  it('does not resend a submitted answer after disconnect or a desktop click', () => {
    const f = fixture(); f.initialize();
    f.broker.fromExecutor({ id: 'request', method: 'item/fileChange/requestApproval', params: { threadId: 'task', turnId: 'turn' } });
    f.client.respond('answer', 'request', 'task', 'turn', { decision: 'decline' }); f.client.close();
    const other = f.broker.connect(vi.fn());
    expect(other.pending('task')).toEqual([]);
    expect(() => other.respond('again', 'request', 'task', 'turn', { decision: 'accept' })).toThrow('已经变化');
    f.broker.fromDesktop({ id: 'request', result: { decision: 'accept' } });
    expect(f.executor.mock.calls.filter(([message]) => message.id === 'request')).toHaveLength(1); f.broker.close();
  });
  it('returns an unknown outcome on timeout and never replays a mutating request', () => {
    vi.useFakeTimers(); const f = fixture(); f.initialize();
    f.client.request('stop', 'turn/interrupt', { threadId: 'task', turnId: 'turn' });
    const before = f.executor.mock.calls.length; vi.advanceTimersByTime(20000);
    expect(f.response).toHaveBeenCalledWith({ id: 'stop', error: expect.objectContaining({ code: 'OUTCOME_UNKNOWN' }) });
    expect(f.executor).toHaveBeenCalledTimes(before); f.broker.close();
  });
  it.each(['timeout', 'disconnect'])('never delivers a late helper response to the desktop after %s', kind => {
    vi.useFakeTimers(); const f = fixture(); f.initialize();
    f.client.request('send', 'turn/start', { threadId: 'task', input: [] });
    const wireId = f.executor.mock.calls.at(-1)![0].id;
    if (kind === 'timeout') vi.advanceTimersByTime(20000); else f.client.close();
    f.desktop.mockClear(); f.response.mockClear();
    f.broker.fromExecutor({ id: wireId, result: { turn: { id: 'turn' } } });
    expect(f.desktop).not.toHaveBeenCalled(); expect(f.response).not.toHaveBeenCalled(); f.broker.close();
  });
  it('does not let a broken helper socket interrupt desktop execution', () => {
    const f = fixture(); f.initialize();
    f.broker.connect(() => { throw new Error('closed socket'); });
    const event = { method: 'turn/started', params: { threadId: 'task', turn: { id: 'turn' } } };
    expect(() => f.broker.fromExecutor(event)).not.toThrow();
    expect(f.desktop).toHaveBeenLastCalledWith(event); f.broker.close();
  });
  it('does not forward private dynamic tool calls with numeric ID zero to the helper', () => {
    const f = fixture(); f.initialize();
    f.broker.fromExecutor({ id: 0, method: 'item/tool/call', params: { threadId: 'task' } });
    expect(f.response).not.toHaveBeenCalled(); expect(f.desktop).toHaveBeenCalled(); f.broker.close();
  });
});
