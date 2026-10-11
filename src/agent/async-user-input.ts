import type { Interaction } from '../shared/protocol.js';

const open = '<send_user_message_question_reply>';
const close = '</send_user_message_question_reply>';
type Reply = { questionItemId: string; question: string; answer: string };

export function asyncInputReplies(text: string): Reply[] | undefined {
  const value = text.trim();
  if (!value.startsWith(open) || !value.endsWith(close)) return;
  try {
    const parsed = JSON.parse(value.slice(open.length, -close.length));
    const replies = Array.isArray(parsed) ? parsed : [parsed];
    if (replies.length && replies.every(reply => reply && typeof reply.questionItemId === 'string' && typeof reply.question === 'string' && typeof reply.answer === 'string')) return replies;
  } catch { return; }
}

export function asyncUserInputRequests(state: any): Interaction[] {
  const turns: any[] = state.turnHistory?.history?.entitiesByKey ? Object.values(state.turnHistory.history.entitiesByKey) : state.turns ?? [];
  // Completing a turn does not answer its questions. Limit requests to the
  // latest turn so historical questions cannot leak into a newer task round.
  const turn = [...turns].sort((a, b) => (a.turnStartedAtMs ?? 0) - (b.turnStartedAtMs ?? 0)).at(-1);
  const pending = new Map<string, Interaction>();
  for (const item of turn?.items ?? []) {
    if (item.type === 'agentMessage' && typeof item.id === 'string' && Array.isArray(item.questions)) {
      item.questions.forEach((question: any, index: number) => {
        const id = JSON.stringify(['request_user_input_async', item.id, index]);
        if (id.length > 200 || typeof question?.title !== 'string' || !question.title.trim()) return;
        pending.set(id, { id, kind: 'input', title: '需要你的回复', detail: '', questions: [{ id, question: question.title, options: (Array.isArray(question.options) ? question.options : []).filter((option: unknown) => typeof option === 'string').map((label: string) => ({ label })) }] });
      });
    } else if (item.type === 'userMessage' || item.type === 'steeringUserMessage' && item.status === 'accepted') {
      const content = item.type === 'userMessage' ? item.content : item.input;
      if (content?.length === 1 && content[0]?.type === 'text' && typeof content[0].text === 'string') {
        for (const reply of asyncInputReplies(content[0].text) ?? []) pending.delete(reply.questionItemId);
      }
    }
  }
  const groups = new Map<string, Interaction>();
  for (const request of pending.values()) {
    const [, itemId] = JSON.parse(String(request.id));
    const group = groups.get(itemId);
    if (group) group.questions!.push(...request.questions!);
    else groups.set(itemId, request);
  }
  return [...groups.values()];
}

export function hasPendingInteractions(state: any) { return !!state?.requests?.length || !!state && asyncUserInputRequests(state).length > 0; }
export function asyncInputAccepted(state: any, request: Interaction, answers: Record<string, string[]>) {
  const turns: any[] = state.turnHistory?.history?.entitiesByKey ? Object.values(state.turnHistory.history.entitiesByKey) : state.turns ?? [];
  const accepted = new Map<string, Reply>();
  for (const turn of turns) for (const item of turn.items ?? []) {
    if (item.type !== 'userMessage' && !(item.type === 'steeringUserMessage' && item.status === 'accepted')) continue;
    const content = item.type === 'userMessage' ? item.content : item.input;
    if (content?.length !== 1 || content[0]?.type !== 'text' || typeof content[0].text !== 'string') continue;
    for (const reply of asyncInputReplies(content[0].text) ?? []) accepted.set(reply.questionItemId, reply);
  }
  return !!request.questions?.length && request.questions.every(question => {
    const reply = accepted.get(question.id);
    return reply?.question === question.question && reply.answer === answers[question.id][0].trim();
  });
}
