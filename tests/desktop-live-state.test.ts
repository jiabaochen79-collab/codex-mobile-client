import { describe, it, expect } from 'vitest';
import { LiveState } from '../src/bridge/live-state.js';
describe('native live state', () => {
  it('records a start acknowledgement before the delayed started event', () => {
    const state = new LiveState(); state.started('t', { id: 'turn', status: 'inProgress' });
    expect(state.read('t')).toMatchObject({ id: 'turn', status: 'inProgress' });
    state.accept({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'turn', status: 'completed' } } });
    state.started('t', { id: 'turn', status: 'inProgress' });
    expect(state.read('t')?.status).toBe('completed');
  });
  it('keeps an in-progress turn for helpers that attach after its start', () => {
    const state = new LiveState();
    state.accept({ method: 'turn/started', params: { threadId: 't', turn: { id: 'turn', status: 'inProgress', startedAt: 1, items: [] } } });
    state.accept({ method: 'item/started', params: { threadId: 't', turnId: 'turn', item: { id: 'message', type: 'agentMessage', text: '' } } });
    state.accept({ method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'turn', itemId: 'message', delta: '进行中' } });
    expect(state.read('t')).toMatchObject({ id: 'turn', status: 'inProgress', items: [{ id: 'message', text: '进行中' }] });
    expect(state.read('other')).toBe(null);
  });
  it('uses authoritative completed items and turn errors', () => {
    const state = new LiveState();
    state.accept({ method: 'turn/started', params: { threadId: 't', turn: { id: 'turn', status: 'inProgress', startedAt: 1 } } });
    state.accept({ method: 'item/completed', params: { threadId: 't', turnId: 'turn', item: { id: 'message', type: 'agentMessage', text: '最终内容', questions: [{ title: '继续？' }] } } });
    state.accept({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'turn', status: 'failed', error: { message: '网络不可用' } } } });
    expect(state.read('t')).toMatchObject({ status: 'failed', error: { message: '网络不可用' }, items: [{ text: '最终内容', questions: [{ title: '继续？' }] }] });
  });
  it('isolates late events from previous turns and does not cache raw tool outputs', () => {
    const state = new LiveState();
    state.accept({ method: 'turn/started', params: { threadId: 't', turn: { id: 'new', status: 'inProgress' } } });
    state.accept({ method: 'item/completed', params: { threadId: 't', turnId: 'old', item: { id: 'old', type: 'agentMessage', text: 'old' } } });
    state.accept({ method: 'item/completed', params: { threadId: 't', turnId: 'new', item: { id: 'cmd', type: 'commandExecution', command: 'echo OK', aggregatedOutput: 'large'.repeat(10000) } } });
    expect(state.read('t')?.items).toEqual([{ id: 'cmd', type: 'commandExecution', command: 'echo OK' }]);
  });
});
