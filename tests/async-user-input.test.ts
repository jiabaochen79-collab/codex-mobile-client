import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CodexDesktop, normalizeSnapshot } from '../src/agent/desktop.js';
import { NativeIpc } from '../src/agent/ipc.js';

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
  expect(result.requests.map(r => r.id)).toEqual([questionId(), questionId('question-message', 1)]);
  expect(result.requests[1].questions?.[0]).toMatchObject({ question: 'Anything else?', options: [] });
});
it.each(['pending', 'rejected', 'interrupted'])('keeps a question after a %s steering response', status => {
  expect(normalizeSnapshot(state([question, reply(status)]), 'epoch').requests).toHaveLength(1);
});
it('clears an accepted response, ignores forged or earlier acknowledgements and does not show ended-turn questions', () => {
  expect(normalizeSnapshot(state([question, reply()]), 'epoch').requests).toEqual([]);
  expect(normalizeSnapshot(state([reply(), question]), 'epoch').requests).toHaveLength(1);
  expect(normalizeSnapshot(state([question, reply('accepted', 'answer', 'other-question')]), 'epoch').requests).toHaveLength(1);
  const ended = state(); ended.turns[0].status = 'completed';
  expect(normalizeSnapshot(ended, 'epoch').requests).toEqual([]);
  expect(normalizeSnapshot({ ...state(), threadRuntimeStatus: { type: 'idle' } }, 'epoch').requests).toEqual([]);
});
it('retains legacy blocking questions alongside new message questions', () => {
  const result = normalizeSnapshot({ ...state(), requests: [{ id: 7, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'old', question: 'Old question?', options: [] }] } }] }, 'epoch');
  expect(result.requests.map(r => r.id)).toEqual([7, questionId()]);
});

function desktop() {
  const adapter = new CodexDesktop('unused');
  const current = state();
  Reflect.set(adapter, 'current', { id: current.id, owner: 'owner', revision: 1, state: current });
  vi.spyOn(adapter as any, 'ready').mockResolvedValue(undefined);
  vi.spyOn(adapter as any, 'follow').mockResolvedValue(undefined);
  vi.spyOn(adapter as any, 'snapshot').mockImplementation(() => normalizeSnapshot(current, 'epoch'));
  const request = vi.spyOn(NativeIpc.prototype, 'request').mockResolvedValue({ resultType: 'success' });
  return { adapter, current, request, command: { method: 'respond' as const, params: { id: current.id, epoch: 'epoch', requestId: questionId(), answers: { [questionId()]: ['Custom address'] } } } };
}
it('submits a free-text async answer through steering with the native question identity and inherited settings', async () => {
  const { adapter, current, request, command } = desktop(); const id = randomUUID();
  try {
    await expect(adapter.execute(command, id)).resolves.toEqual({ accepted: true });
    expect(request).toHaveBeenCalledTimes(1);
    const [method, params, version, owner] = request.mock.calls[0] as any;
    expect([method, version, owner]).toEqual(['thread-follower-steer-turn', 1, 'owner']);
    expect(params.clientUserMessageId).toBe(id);
    expect(params.input).toEqual([{ type: 'text', text: '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: questionId(), question: 'Which address?', answer: 'Custom address' }]) + '\n</send_user_message_question_reply>', text_elements: [] }]);
    expect(params.restoreMessage.context).toMatchObject({ addedFiles: [], workspaceRoots: [current.cwd] });
    expect(params).not.toHaveProperty('turnStart'); expect(params).not.toHaveProperty('threadSettings');
  } finally { adapter.close(); }
});
it.each(['ended', 'answered', 'other question', 'empty answer', 'extra answer', 'decline'])('rejects %s async replies before native dispatch', async kind => {
  const { adapter, current, request, command } = desktop();
  if (kind === 'ended') current.turns[0].status = 'completed';
  if (kind === 'answered') current.turns[0].items.push(reply());
  if (kind === 'other question') command.params.requestId = questionId('another-message');
  if (kind === 'empty answer') command.params.answers[questionId()] = [' '];
  if (kind === 'extra answer') Object.assign(command.params.answers, { unknown: ['answer'] });
  if (kind === 'decline') Object.assign(command.params, { decision: 'decline' });
  try { await expect(adapter.execute(command, randomUUID())).rejects.toMatchObject({ code: ['empty answer', 'extra answer', 'decline'].includes(kind) ? 'INVALID' : 'STALE' }); expect(request).not.toHaveBeenCalled(); }
  finally { adapter.close(); }
});
it('keeps an answer retryable after a native rejection and leaves the original question unchanged', async () => {
  const { adapter, current, request, command } = desktop(); request.mockResolvedValue({ resultType: 'error' });
  try { await expect(adapter.execute(command, randomUUID())).rejects.toMatchObject({ code: 'CLIENT_REJECTED' }); expect(normalizeSnapshot(current, 'epoch').requests).toHaveLength(1); }
  finally { adapter.close(); }
});
it('retains a question subscription and installation blocker until the reply is accepted', async () => {
  const { adapter, current } = desktop();
  Reflect.get(adapter, 'followed').set(current.id, Reflect.get(adapter, 'current'));
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
it('fails closed when the native steering protocol is incompatible', async () => {
  const { adapter, command, request } = desktop();
  Reflect.set(adapter, 'checkedStatus', { capabilities: ['compatibility-checked', 'respond-approval'] });
  try { await expect(adapter.execute(command, randomUUID())).rejects.toMatchObject({ code: 'UNSUPPORTED' }); expect(request).not.toHaveBeenCalled(); }
  finally { adapter.close(); }
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
