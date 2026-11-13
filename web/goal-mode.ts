import type { ThreadGoal } from '../src/shared/protocol';

export const goalStatusNames: Record<ThreadGoal['status'], string> = {
  active: '正在执行目标', paused: '目标已暂停', complete: '目标已达成', blocked: '目标暂时受阻',
  budgetLimited: '目标预算已用完', usageLimited: '目标达到用量限制'
};

export const goalStatusDescriptions: Record<ThreadGoal['status'], string> = {
  active: 'Codex 会在会话空闲时继续推进目标。暂停目标会停止自动推进。',
  paused: '目标已暂停。点击继续后，Codex 会按原目标继续工作。',
  blocked: '目标暂时停止自动推进。请查看最近回复，补充所需信息后继续，也可以删除目标。',
  usageLimited: '模型服务用量受限。请在额度恢复后继续目标。',
  budgetLimited: '目标 Token 预算已用完。请先在 Codex 中调整预算，也可以删除目标。',
  complete: '目标已达成。'
};

export function goalPrompt(objective: string) {
  return `/goal ${objective.trim()}`;
}
