import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CodexDesktop, normalizeSnapshot } from '../src/agent/desktop.js';
import { NativeIpc } from '../src/agent/ipc.js';
import * as nativeQuestion from '../src/agent/desktop-question.js';
import { asyncInputAccepted, asyncInputReplies } from '../src/agent/async-user-input.js';
import { RemoteError } from '../src/shared/protocol.js';

afterEach(() => vi.restoreAllMocks());
const questionId = (item = 'question-message', index = 0) => JSON.stringify(['request_user_input_async', item, index]);
const question = { id: 'question-message', type: 'agentMessage', text: 'Which address?', delivery: 'async', questions: [{ title: 'Which address?', options: ['Same address', 'Another address', 'Unsure'] }] };
const reply = (status = 'accepted', answer = 'Same address', id = questionId()) => ({ id: 'reply', type: 'steeringUserMessage', status, input: [{ type: 'text', text: '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: id, question: 'Which address?', answer }]) + '\n</send_user_message_question_reply>' }] });
const state = (items: any[] = [question]) => ({ id: randomUUID(), title: 'Input fixture', cwd: 'C:/fixture', threadRuntimeStatus: { type: 'active' }, turns: [{ turnId: 'active-turn', status: 'inProgress', turnStartedAtMs: 1, items }] });

it('detects message questions even when there is no legacy request and the history page omits the question', () => {
  const result = normalizeSnapshot(state([question, { id: 'after', type: 'agentMessage', text: 'Continuing unrelated work' }]), 'epoch', 1);
  expect(result.messages).toHaveLength(1);
  expect(result.requests).toEqual([{ id: questionId(), kind: 'input', title: '需要你的回复', detail: '', questions: [{ id: questionId(), question: 'Which address?', options: question.questions[0].options.map(label => ({ label })) }] }]);
});
it('assigns desktop-compatible identities to every question and preserves manual-only questions', () => {
  const result = normalizeSnapshot(state([{ ...question, questions: [...question.questions, { title: 'Anything else?', options: [] }] }]), 'epoch');
  expect(result.requests.map(r => r.id)).toEqual([questionId()]);
  expect(result.requests[0].questions?.map(q => q.id)).toEqual([questionId(), questionId('question-message', 1)]);
  expect(result.requests[0].questions?.[1]).toMatchObject({ question: 'Anything else?', options: [] });
});
it.each(['pending', 'rejected', 'interrupted'])('keeps a question after a %s steering response', status => {
  expect(normalizeSnapshot(state([question, reply(status)]), 'epoch').requests).toHaveLength(1);
});
it('clears an accepted response and ignores forged or earlier acknowledgements', () => {
  expect(normalizeSnapshot(state([question, reply()]), 'epoch').requests).toEqual([]);
  expect(normalizeSnapshot(state([reply(), question]), 'epoch').requests).toHaveLength(1);
  expect(normalizeSnapshot(state([question, reply('accepted', 'answer', 'other-question')]), 'epoch').requests).toHaveLength(1);
});
it.each(['completed', 'failed', 'interrupted', 'inProgress'])('keeps an unanswered question when the latest turn is %s and the desktop is idle', status => {
  const current = state([question, { id: 'final', type: 'agentMessage', text: 'Please confirm before proceeding', phase: 'final_answer' }]);
  current.turns[0].status = status;
  current.threadRuntimeStatus.type = 'idle';
  const snapshot = normalizeSnapshot(current, 'epoch', 1);
  expect(snapshot.busy).toBe(false);
  expect(snapshot.messages).toHaveLength(1);
  expect(snapshot.requests.map(r => r.id)).toEqual([questionId()]);
  expect(normalizeSnapshot(JSON.parse(JSON.stringify(current)), 'reconnected').requests).toEqual(snapshot.requests);
});
it('does not resurrect questions from an older turn when another turn becomes current', () => {
  const current = state(); current.turns[0].status = 'completed';
  const next = { turnId: 'next-turn', status: 'inProgress', turnStartedAtMs: 2, items: [] as any[] };
  current.turns.push(next);
  current.turns.reverse();
  expect(normalizeSnapshot(current, 'epoch').requests).toEqual([]);
  next.items.push({ ...question, id: 'new-question' });
  expect(normalizeSnapshot(current, 'epoch').requests.map(r => r.id)).toEqual([questionId('new-question')]);
});
it('clears a desktop-accepted skip without reviving it when the turn ends', () => {
  const current = state([question, reply('accepted', '')]);
  current.turns[0].status = 'completed'; current.threadRuntimeStatus.type = 'idle';
  expect(normalizeSnapshot(current, 'epoch').requests).toEqual([]);
  current.turns[0].status = 'inProgress'; current.threadRuntimeStatus.type = 'active';
  expect(normalizeSnapshot(current, 'epoch').requests).toEqual([]);
});
it('retains legacy blocking questions alongside new message questions', () => {
  const result = normalizeSnapshot({ ...state(), requests: [{ id: 7, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'old', question: 'Old question?', options: [] }] } }] }, 'epoch');
  expect(result.requests.map(r => r.id)).toEqual([7, questionId()]);
});

function desktop() {
  const adapter = new CodexDesktop('unused');
  const current = state();
  const followed = { id: current.id, owner: 'owner', revision: 1, state: current };
  Reflect.set(adapter, 'current', followed);
  Reflect.get(adapter, 'followed').set(current.id, followed);
  vi.spyOn(adapter as any, 'ready').mockResolvedValue(undefined);
  vi.spyOn(adapter as any, 'follow').mockResolvedValue(undefined);
  vi.spyOn(adapter as any, 'snapshot').mockImplementation(() => normalizeSnapshot(current, 'epoch'));
  Reflect.set(adapter, 'discovery', { processId: 42, startedAt: 'ticks', executablePath: 'desktop' });
  const navigate = vi.spyOn(adapter as any, 'appTool').mockResolvedValue({ navigated: true });
  const submit = vi.spyOn(nativeQuestion, 'submitDesktopQuestion').mockRejectedValue(new Error('Answer submission must not use a window'));
  const reconcile = vi.spyOn(nativeQuestion, 'reconcileDesktopQuestion').mockImplementation(async (_exe, _identity, _title, _request, _answers, check) => { await check(); return { closed: true }; });
  const request = vi.spyOn(NativeIpc.prototype, 'request').mockImplementation(async method => {
    if (method === 'thread-follower-steer-turn' || method === 'thread-follower-start-turn') current.turns[0].items.push(reply('accepted', 'Custom address'));
    return { resultType: 'success' };
  });
  return { adapter, current, request, submit, reconcile, navigate, command: { method: 'respond' as const, params: { id: current.id, epoch: 'epoch', requestId: questionId(), answers: { [questionId()]: ['Custom address'] } } } };
}
it.each(['inProgress', 'completed'])('submits a %s async answer once through task IPC before closing the accepted card', async status => {
  const { adapter, current, request, submit, reconcile, navigate, command } = desktop();
  current.turns[0].status = status;
  if (status === 'completed') current.threadRuntimeStatus.type = 'idle';
  try {
    await expect(adapter.execute(command, randomUUID())).resolves.toEqual({ accepted: true });
    expect(request).toHaveBeenCalledOnce();
    const [method, params, version, owner] = request.mock.calls[0];
    expect(method).toBe(status === 'completed' ? 'thread-follower-start-turn' : 'thread-follower-steer-turn');
    expect(version).toBe(status === 'completed' ? 2 : 1); expect(owner).toBe('owner');
    const body = params as { turnStart: { request: { input: { text: string }[] } }; input: { text: string }[] };
    const input = status === 'completed' ? body.turnStart.request.input : body.input;
    expect(asyncInputReplies(input[0].text)).toEqual([{ questionItemId: questionId(), question: 'Which address?', answer: 'Custom address' }]);
    expect(navigate).toHaveBeenCalledWith('navigate_to_codex_page', { threadId: current.id }, current.id, undefined);
    expect(submit).not.toHaveBeenCalled(); expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile.mock.calls[0].slice(2, 5)).toEqual(['Input fixture', normalizeSnapshot(state(), 'epoch').requests[0], command.params.answers]);
    expect(request.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0]);
  } finally { adapter.close(); }
});
it('checks authorization and question freshness again before submitting the answer', async () => {
  const { adapter, current, command, request } = desktop();
  const authorize = vi.fn().mockImplementation(() => { current.turns[0].items.push(reply()); });
  try {
    await expect(adapter.execute(command, randomUUID(), authorize)).rejects.toMatchObject({ code: 'STALE' });
    expect(request).not.toHaveBeenCalled();
  } finally { adapter.close(); }
});
it.each(['open card', 'unknown submission'])('reconciles an accepted answer after %s without sending the answer again', async kind => {
  const { adapter, current, command, submit, request, reconcile } = desktop();
  request.mockImplementation(async () => {
    current.turns[0].items.push(reply('accepted', 'Custom address'));
    if (kind === 'unknown submission') throw new RemoteError('OUTCOME_UNKNOWN', 'Unconfirmed card');
    return { resultType: 'success' };
  });
  try {
    await expect(adapter.execute(command, randomUUID())).resolves.toEqual({ accepted: true });
    expect(submit).not.toHaveBeenCalled(); expect(reconcile).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledOnce();
  } finally { adapter.close(); }
});
it('does not dismiss a new question that repeats an earlier question text', async () => {
  const { adapter, current, command, request } = desktop();
  request.mockImplementation(async () => {
    current.turns[0].items.push(reply('accepted', 'Custom address'), { ...question, id: 'new-question' });
    return { resultType: 'success' };
  });
  const reconcile = vi.spyOn(nativeQuestion, 'reconcileDesktopQuestion').mockImplementation(async (_exe, _identity, _title, _request, _answers, check) => { await check(); return { closed: true }; });
  try { await expect(adapter.execute(command, randomUUID())).rejects.toMatchObject({ code: 'STALE' }); }
  finally { adapter.close(); }
});
it.each(['new turn', 'answered', 'other question', 'empty answer', 'extra answer', 'decline'])('rejects %s async replies before native dispatch', async kind => {
  const { adapter, current, request, command } = desktop();
  if (kind === 'new turn') current.turns.push({ turnId: 'new-turn', status: 'inProgress', turnStartedAtMs: 2, items: [] });
  if (kind === 'answered') current.turns[0].items.push(reply());
  if (kind === 'other question') command.params.requestId = questionId('another-message');
  if (kind === 'empty answer') command.params.answers[questionId()] = [' '];
  if (kind === 'extra answer') Object.assign(command.params.answers, { unknown: ['answer'] });
  if (kind === 'decline') Object.assign(command.params, { decision: 'decline' });
  try { await expect(adapter.execute(command, randomUUID())).rejects.toMatchObject({ code: ['empty answer', 'extra answer', 'decline'].includes(kind) ? 'INVALID' : 'STALE' }); expect(request).not.toHaveBeenCalled(); }
  finally { adapter.close(); }
});
it.each(['inProgress', 'completed'])('keeps a %s answer retryable after an IPC rejection and leaves the original question unchanged', async status => {
  const { adapter, current, request, reconcile, command } = desktop(); request.mockResolvedValue({ resultType: 'error' });
  current.turns[0].status = status;
  if (status === 'completed') current.threadRuntimeStatus.type = 'idle';
  try { await expect(adapter.execute(command, randomUUID())).rejects.toMatchObject({ code: 'CLIENT_REJECTED' }); expect(normalizeSnapshot(current, 'epoch').requests).toHaveLength(1); expect(request).toHaveBeenCalledOnce(); expect(reconcile).not.toHaveBeenCalled(); }
  finally { adapter.close(); }
});
it.each(['inProgress', 'completed'])('retains a %s question subscription and installation blocker until the reply is accepted', async status => {
  const { adapter, current } = desktop();
  Reflect.get(adapter, 'followed').set(current.id, Reflect.get(adapter, 'current'));
  current.turns[0].status = status;
  if (status === 'completed') current.threadRuntimeStatus.type = 'idle';
  try {
    expect(await adapter.updateBlockers()).toEqual(['有待回答的提问']);
    adapter.setSubscriptions([]); expect(Reflect.get(adapter, 'followed').has(current.id)).toBe(true);
    current.turns[0].items.push(reply());
    expect(await adapter.updateBlockers()).toEqual([]);
    adapter.setSubscriptions([]); expect(Reflect.get(adapter, 'followed').has(current.id)).toBe(false);
  } finally { adapter.close(); }
});
it('renders accepted answer text without exposing the native reply wrapper', () => {
  const result = normalizeSnapshot(state([question, reply()]), 'epoch');
  expect(result.messages.at(-1)?.text).toBe('Which address?\nSame address');
});
it('detects canonical history questions, clears only the answered question and accepts canonical user replies', () => {
  const current = state([{ ...question, questions: [...question.questions, { title: 'Second question?', options: [] }] }, reply()]);
  const { turns, ...rest } = current;
  const canonical = { ...rest, turnHistory: { history: { entitiesByKey: { active: turns[0] } } } };
  expect(normalizeSnapshot(canonical, 'epoch').requests.map(r => r.id)).toEqual([questionId('question-message', 1)]);
  const answered = reply('accepted', 'second answer', questionId('question-message', 1));
  turns[0].items.push({ id: 'canonical-reply', type: 'userMessage', content: answered.input });
  expect(normalizeSnapshot(canonical, 'epoch').requests).toEqual([]);
});
it('ignores plain option text and malformed reply metadata', () => {
  expect(normalizeSnapshot(state([{ id: 'ordinary', type: 'agentMessage', text: 'Choose A or B' }]), 'epoch').requests).toEqual([]);
  const malformed = { ...reply(), input: [{ type: 'text', text: '<send_user_message_question_reply>{invalid}</send_user_message_question_reply>' }] };
  expect(normalizeSnapshot(state([question, malformed]), 'epoch').requests).toHaveLength(1);
});
it('fails closed when the desktop process identity is unavailable', async () => {
  const { adapter, command, request, submit } = desktop();
  Reflect.set(adapter, 'discovery', undefined);
  try { await expect(adapter.execute(command, randomUUID())).rejects.toMatchObject({ code: 'CLIENT_UNAVAILABLE' }); expect(request).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled(); }
  finally { adapter.close(); }
});
it('accepts only exact question identities, text, and answers in native history', () => {
  const request = normalizeSnapshot(state(), 'epoch').requests[0];
  for (const item of [reply('pending', 'Custom address'), reply('accepted', 'Wrong answer'), reply('accepted', 'Custom address', 'wrong-id')]) {
    expect(asyncInputAccepted(state([question, item]), request, { [questionId()]: ['Custom address'] })).toBe(false);
  }
  const current = state(); current.turns.push({ turnId: 'next', status: 'completed', turnStartedAtMs: 2, items: [{ type: 'userMessage', content: reply('accepted', 'Custom address').input }] });
  expect(asyncInputAccepted(current, request, { [questionId()]: ['Custom address'] })).toBe(true);
});
it.each(['missing reply', 'card still open', 'unknown outcome'])('never resends an answer after %s', async kind => {
  vi.useFakeTimers();
  const { adapter, command, submit, request, reconcile } = desktop();
  if (kind === 'unknown outcome') request.mockRejectedValue(new RemoteError('OUTCOME_UNKNOWN', 'Unconfirmed transport'));
  if (kind === 'missing reply') request.mockResolvedValue({ resultType: 'success' });
  reconcile.mockResolvedValue({ closed: false });
  try {
    const assertion = expect(adapter.execute(command, randomUUID())).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    await vi.advanceTimersByTimeAsync(6000); await assertion;
    expect(request).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(kind === 'card still open' ? 3 : 0);
  } finally { adapter.close(); vi.useRealTimers(); }
});
it('retries transient card closure without resubmitting the already accepted answer', async () => {
  const { adapter, command, request, reconcile } = desktop();
  reconcile.mockRejectedValueOnce(new RemoteError('OUTCOME_UNKNOWN', 'Stale accessibility element')).mockResolvedValueOnce({ closed: false });
  try {
    await expect(adapter.execute(command, randomUUID())).resolves.toEqual({ accepted: true });
    expect(request).toHaveBeenCalledOnce(); expect(reconcile).toHaveBeenCalledTimes(3);
  } finally { adapter.close(); }
});
it('continues using the legacy response protocol for blocking user input', async () => {
  const { adapter, current, request } = desktop();
  current.turns[0].items = [];
  Object.assign(current, { requests: [{ id: 7, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'old', question: 'Blocking question?', options: [] }] } }] });
  try {
    await adapter.execute({ method: 'respond', params: { id: current.id, epoch: 'epoch', requestId: 7, answers: { old: ['manual answer'] } } }, randomUUID());
    expect(request).toHaveBeenCalledWith('thread-follower-submit-user-input', { conversationId: current.id, requestId: 7, response: { answers: { old: { answers: ['manual answer'] } } } }, 1, 'owner');
  } finally { adapter.close(); }
});
