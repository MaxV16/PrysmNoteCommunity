export const TASK_TITLE_MAX = 5000;

export const TASK_DESCRIPTION_MAX = 100000;

export const TAG_NAME_MAX = 50;

export const SUBTASK_TITLE_MAX = TASK_TITLE_MAX;

export const SUBTASK_DESCRIPTION_MAX = TASK_DESCRIPTION_MAX;

export type CharLimitStatus = {
  used: number;
  max: number;
  remaining: number;
  over: number;
  isOver: boolean;
  isNear: boolean;
};

/**
 * Compute the counter state for a value against a maximum.
 * `isNear` becomes true within 10% of the limit (or the last 100 chars,
 * whichever is smaller) so counters only draw attention when it matters.
 */
export function charLimitStatus(value: string, max: number): CharLimitStatus {
  const used = value.length;
  const remaining = max - used;
  const nearWindow = Math.min(100, Math.floor(max * 0.1));
  return {
    used,
    max,
    remaining,
    over: remaining < 0 ? -remaining : 0,
    isOver: remaining < 0,
    isNear: remaining >= 0 && remaining <= nearWindow,
  };
}
