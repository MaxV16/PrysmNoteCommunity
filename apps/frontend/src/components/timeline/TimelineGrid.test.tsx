import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TimelineGrid } from "./TimelineGrid";
import { DAY_WIDTH, DAY_HEADER_HEIGHT } from "./constants";

describe("TimelineGrid", () => {
  it("renders correct number of day columns", () => {
    const days = [
      new Date("2026-07-20"),
      new Date("2026-07-21"),
      new Date("2026-07-22"),
    ];
    const { container } = render(<TimelineGrid days={days} />);

    const columns = container.querySelectorAll("[data-day-column]");
    expect(columns).toHaveLength(3);
  });

  it("flags today's column with data-is-today", () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const days = [yesterday, now];
    const { container } = render(<TimelineGrid days={days} />);

    const todayCols = container.querySelectorAll('[data-day-column][data-is-today="true"]');
    expect(todayCols).toHaveLength(1);
  });

  it("moves the line when the live today changes across midnight", () => {
    const day18 = new Date(2026, 9, 18);
    const day19 = new Date(2026, 9, 19);
    const days = [day18, day19];

    const { container, rerender } = render(
      <TimelineGrid days={days} today={new Date(2026, 9, 18)} />
    );
    const flaggedAt18 = () =>
      Array.from(container.querySelectorAll('[data-day-column][data-is-today="true"]'));
    expect(flaggedAt18()).toHaveLength(1);

    // A session left open past midnight must show the new day's line instead of
    // the day the grid first mounted.
    rerender(<TimelineGrid days={days} today={new Date(2026, 9, 19)} />);
    expect(flaggedAt18()).toHaveLength(1);
    const indicator = container.querySelector("[data-today-indicator]") as HTMLElement | null;
    expect(indicator).not.toBeNull();
    expect(indicator!.parentElement?.getAttribute("data-is-today")).toBe("true");
    expect(
      Array.from(container.querySelectorAll("[data-day-column]")).indexOf(
        indicator!.parentElement as HTMLElement
      )
    ).toBe(1);
  });

  it("sizes every day column from one CSS variable so a zoom step never re-renders them", () => {
    const days = [new Date("2026-07-20"), new Date("2026-07-21")];
    const { container, rerender } = render(<TimelineGrid days={days} />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.getPropertyValue("--prysm-day-w")).toBe(`${DAY_WIDTH}px`);
    const columns = container.querySelectorAll("[data-day-column]");
    for (const col of columns) {
      const el = col as HTMLElement;
      // The width lives on the strip, so a zoom step is a single style patch
      // instead of 260 column re-renders. Reading the var keeps the px widths.
      expect(el.style.width).toBe("var(--prysm-day-w)");
      expect(el.style.minWidth).toBe("var(--prysm-day-w)");
      expect(el.style.flex).toBe("0 0 var(--prysm-day-w)");
    }
    rerender(<TimelineGrid days={days} dayWidth={72} />);
    expect(wrapper.style.getPropertyValue("--prysm-day-w")).toBe("72px");
  });

  it("positions the grid below the header height constant", () => {
    const { container } = render(<TimelineGrid days={[new Date("2026-07-20")]} />);
    // The absolute grid wrapper is the first element rendered.
    const wrapper = container.firstElementChild as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    expect(wrapper!.style.top).toBe(`${DAY_HEADER_HEIGHT}px`);
  });

  it("renders the today indicator behind bars with no pointer events", () => {
    const now = new Date();
    const days = [now];
    const { container } = render(<TimelineGrid days={days} />);
    const indicator = container.querySelector("[data-today-indicator]") as HTMLElement | null;
    expect(indicator).not.toBeNull();
    expect(indicator!.style.zIndex).toBe("0");
    expect(indicator!.style.pointerEvents).toBe("none");
    expect(indicator!.style.opacity).toBe("0.9");
    // The marker is a flat hairline now: no glow shadow.
    expect(indicator!.style.boxShadow).toBe("");
  });
});
