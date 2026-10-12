import { threadGoalSchema, type ThreadGoal } from '../shared/protocol.js';
import { createHash } from 'node:crypto';

export function threadGoal(state: any): ThreadGoal | null {
  const value = state.threadGoal ?? state.completedThreadGoal;
  const result = threadGoalSchema.safeParse(value);
  if (!result.success || result.data.threadId !== state.id) return null;
  const goal = result.data;
  const revision = createHash('sha256').update(JSON.stringify([goal.threadId, goal.objective, goal.status, goal.createdAt, goal.tokenBudget])).digest('hex');
  return { ...goal, revision };
}
