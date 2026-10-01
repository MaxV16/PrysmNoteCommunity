import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import {
  TimelineDragContext,
  useTimelineBarDrag,
  type TimelineBarCommit,
} from "./useTimelineBarDrag";
import type { Task } from "@/types/task";

function makeTask(partial: Partial<Task> = {}): Task {
  return {
    id: "t1",
    user_id: "u1",
    parent_task_id: null,
    title: "Task",
    description: null,
    status: "todo",
    priority: 2,
    start_date: "2026-08-03",
    due_date: "2026-08-03",
    is_all_day: false,
    estimated_minutes: null,
    recurrence_rule: null,
    recurrence_end_date: null,
    sort_order: 0,
    is_archived: false,
    completed_at: null,
    created_at: "2026-01-01T00:00:00",
    updated_at: "2026-01-01T00:00:00",
    tags: [],
    links: [],
    subtasks: [],
    ...partial,
  };
}

function Harness(props: {
  onLongPress: () => void;
  disabled?: boolean;
}) {
  const drag = useTimelineBarDrag(makeTask(), "move", props.disabled, {
    onLongPress: props.onLongPress,
  });
  return createElement(
    "div",
    { "data-timeline-body": "" },
    createElement("div", {
      ref: drag.ref,
      "data-task-bar": "",
      "data-testid": "bar",
      onPointerDown: drag.onPointerDown,
    }),
    createElement("span", { "data-testid": "dragging" }, String(drag.dragging))
  );
}

/**
 * A native event with the pointer fields the engine reads. testing-library's
 * `fireEvent.pointer*` falls back to MouseEvent in jsdom and can drop
 * `pointerType`/`pointerId`, so the init values are written directly.
 */
function pointerEvent(type: string, init: Record<string, unknown>): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(init)) {
    (ev as unknown as Record<string, unknown>)[key] = value;
  }
  return ev;
}

function setup(opts: { disabled?: boolean; matchMediaMatches?: boolean } = {}) {
  const commits: TimelineBarCommit[] = [];
  const longPresses: number[] = [];
  const onLongPress = () => {
    longPresses.push(1);
  };
  const matchMediaSpy = vi.fn((query: string) => ({
    matches: opts.matchMediaMatches ?? false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  window.matchMedia = matchMediaSpy as unknown as typeof window.matchMedia;

  const utils = render(
    createElement(
      TimelineDragContext.Provider,
      {
        value: {
          dayWidth: 28,
          sectionIds: new Set<string>(),
          onCommit: (c: TimelineBarCommit) => {
            commits.push(c);
          },
        },
      },
      createElement(Harness, { onLongPress, disabled: opts.disabled })
    )
  );

  return {
    ...utils,
    bar: utils.getByTestId("bar"),
    commits,
    longPresses,
    matchMediaSpy,
  };
}

function down(el: Element, pointerType: string, x: number, y: number) {
  act(() => {
    el.dispatchEvent(
      pointerEvent("pointerdown", {
        button: 0,
        pointerId: 1,
        pointerType,
        clientX: x,
        clientY: y,
      })
    );
  });
}

function move(x: number, y: number, pointerType = "mouse") {
  act(() => {
    window.dispatchEvent(
      pointerEvent("pointermove", { pointerId: 1, pointerType, clientX: x, clientY: y })
    );
  });
}

function up(x: number, y: number, pointerType = "mouse") {
  act(() => {
    window.dispatchEvent(
      pointerEvent("pointerup", { pointerId: 1, pointerType, clientX: x, clientY: y })
    );
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("useTimelineBarDrag gesture contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom does not drive frames; back rAF with the faked timer so the engine's
    // single write loop is deterministic under test.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 16)
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("picks a task up on the first pixel of mouse movement", () => {
    const h = setup();
    down(h.bar, "mouse", 100, 100);
    expect(h.getByTestId("dragging").textContent).toBe("false");
    // Exactly one pixel: no dead zone, no activation threshold.
    move(101, 100);
    expect(h.getByTestId("dragging").textContent).toBe("true");
    up(101, 100);
  });

  it("never consults matchMedia, so a phone and a tablet share one contract", () => {
    const h = setup({ matchMediaMatches: false });
    down(h.bar, "touch", 100, 100);
    // The removed (max-width: 767px) gate must never come back: the gesture
    // contract cannot depend on the viewport width.
    expect(h.matchMediaSpy).not.toHaveBeenCalled();
    up(100, 100, "touch");
  });

  it("opens the action bar on a stationary touch hold, identically at 375px and 1024px", () => {
    for (const matchMediaMatches of [true, false]) {
      const h = setup({ matchMediaMatches });
      down(h.bar, "touch", 100, 100);
      advance(400);
      up(100, 100, "touch");
      expect(h.longPresses).toHaveLength(1);
      expect(h.commits).toHaveLength(0);
      cleanup();
    }
  });

  it("treats movement past the tolerance before the hold as a pan, never a pickup", () => {
    const h = setup();
    down(h.bar, "touch", 100, 100);
    // 20px > the 10px tolerance, before the hold fires.
    move(100, 120, "touch");
    advance(400);
    up(100, 120, "touch");
    expect(h.longPresses).toHaveLength(0);
    expect(h.commits).toHaveLength(0);
    expect(h.getByTestId("dragging").textContent).toBe("false");
  });

  it("drags instead of opening the action bar when the finger moves after the hold", () => {
    const h = setup();
    down(h.bar, "touch", 100, 100);
    advance(400);
    move(160, 100, "touch");
    up(160, 100, "touch");
    expect(h.longPresses).toHaveLength(0);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].days).toBe(2);
  });

  it("opens the action bar for a drag-disabled bar on a stationary hold and never commits", () => {
    const h = setup({ disabled: true });
    down(h.bar, "touch", 100, 100);
    advance(400);
    up(100, 100, "touch");
    expect(h.longPresses).toHaveLength(1);
    expect(h.commits).toHaveLength(0);
  });

  it("leaves a drag-disabled bar inert to the mouse", () => {
    const h = setup({ disabled: true });
    down(h.bar, "mouse", 100, 100);
    move(160, 100);
    up(160, 100);
    expect(h.commits).toHaveLength(0);
    expect(h.longPresses).toHaveLength(0);
  });

  it("commits two consecutive touch drags on the same bar without wiggling", () => {
    const h = setup();
    // First drag: hold → pick up → move 2 days → release → commit
    down(h.bar, "touch", 100, 100);
    advance(400);
    move(160, 100, "touch");
    up(160, 100, "touch");
    expect(h.longPresses).toHaveLength(0);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].days).toBe(2);
    expect(h.getByTestId("dragging").textContent).toBe("false");

    // Second drag on the same bar: hold → pick up → move 1 day → release → commit
    down(h.bar, "touch", 100, 100);
    advance(400);
    move(130, 100, "touch");
    up(130, 100, "touch");
    expect(h.commits).toHaveLength(2);
    expect(h.commits[1].days).toBe(1);
    expect(h.getByTestId("dragging").textContent).toBe("false");
  });

  it("handles drag then drag-disabled-bar then drag again", () => {
    // Drag a normal bar
    const h1 = setup();
    down(h1.bar, "touch", 100, 100);
    advance(400);
    move(160, 100, "touch");
    up(160, 100, "touch");
    expect(h1.commits).toHaveLength(1);
    expect(h1.getByTestId("dragging").textContent).toBe("false");
    cleanup();

    // Now drag a disabled bar (hold only, no commit)
    const h2 = setup({ disabled: true });
    down(h2.bar, "touch", 100, 100);
    advance(400);
    up(100, 100, "touch");
    expect(h2.longPresses).toHaveLength(1);
    expect(h2.commits).toHaveLength(0);
    cleanup();

    // Drag a normal bar again - must still commit
    const h3 = setup();
    down(h3.bar, "touch", 100, 100);
    advance(400);
    move(160, 100, "touch");
    up(160, 100, "touch");
    expect(h3.commits).toHaveLength(1);
    expect(h3.getByTestId("dragging").textContent).toBe("false");
  });
});
