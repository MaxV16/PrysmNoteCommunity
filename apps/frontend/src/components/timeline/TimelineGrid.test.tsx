import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TimelineGrid } from "./TimelineGrid";

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
});
