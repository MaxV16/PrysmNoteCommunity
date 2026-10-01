import { describe, it, expect } from "vitest";
import {
  TASK_TITLE_MAX,
  TASK_DESCRIPTION_MAX,
  TAG_NAME_MAX,
  SUBTASK_TITLE_MAX,
  SUBTASK_DESCRIPTION_MAX,
  charLimitStatus,
} from "./char-limits";

describe("char-limit constants", () => {
  it("exposes the task, subtask and tag limits", () => {
    expect(TASK_TITLE_MAX).toBe(5000);
    expect(TASK_DESCRIPTION_MAX).toBe(100000);
    expect(TAG_NAME_MAX).toBe(50);
  });

  it("shares the task limits with subtasks", () => {
    expect(SUBTASK_TITLE_MAX).toBe(TASK_TITLE_MAX);
    expect(SUBTASK_DESCRIPTION_MAX).toBe(TASK_DESCRIPTION_MAX);
  });
});

describe("charLimitStatus", () => {
  it("reports the used and remaining counts while under the limit", () => {
    const status = charLimitStatus("hello", 100);
    expect(status.used).toBe(5);
    expect(status.max).toBe(100);
    expect(status.remaining).toBe(95);
    expect(status.over).toBe(0);
    expect(status.isOver).toBe(false);
  });

  it("is not near the limit when far from it", () => {
    expect(charLimitStatus("hello", 100).isNear).toBe(false);
  });

  it("is near the limit inside the near threshold", () => {
    // threshold is min(100, floor(max * 0.1)) -> 100 for large limits
    expect(charLimitStatus("x".repeat(90), 100).isNear).toBe(true);
    expect(charLimitStatus("x".repeat(100), 100).isNear).toBe(true);
  });

  it("uses 10% of the limit as the near threshold for small limits", () => {
    // floor(50 * 0.1) === 5
    expect(charLimitStatus("x".repeat(44), 50).isNear).toBe(false);
    expect(charLimitStatus("x".repeat(45), 50).isNear).toBe(true);
    expect(charLimitStatus("x".repeat(50), 50).isNear).toBe(true);
  });

  it("caps the near threshold at 100 characters", () => {
    // A 5000 char limit would be 500 by percentage, clamped down to 100.
    expect(charLimitStatus("x".repeat(TASK_TITLE_MAX - 100), TASK_TITLE_MAX).isNear).toBe(true);
    expect(charLimitStatus("x".repeat(TASK_TITLE_MAX - 101), TASK_TITLE_MAX).isNear).toBe(false);
  });

  it("reports how many characters are over the limit", () => {
    const status = charLimitStatus("x".repeat(110), 100);
    expect(status.remaining).toBe(-10);
    expect(status.over).toBe(10);
    expect(status.isOver).toBe(true);
    expect(status.isNear).toBe(false);
  });

  it("treats an empty value as safely under the limit", () => {
    const status = charLimitStatus("", 50);
    expect(status.used).toBe(0);
    expect(status.remaining).toBe(50);
    expect(status.isOver).toBe(false);
  });
});
