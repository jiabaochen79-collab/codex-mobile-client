import type { ThreadGoal } from '../src/shared/protocol';

export const goalStatusNames: Record<ThreadGoal['status'], string> = {
  active: '正在执行目标', paused: '目标已暂停', complete: '目标已达成', blocked: '目标暂时受阻',
  budgetLimited: '目标预算已用完', usageLimited: '目标达到用量限制'
};

export function goalPrompt(objective: string) {
  return `/goal ${objective.trim()}`;
}
