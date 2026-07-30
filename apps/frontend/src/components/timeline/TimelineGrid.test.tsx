import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TimelineGrid } from "./TimelineGrid";

describe("TimelineGrid", () => {
  const baseDate = new Date("2026-07-20");

  it("renders correct number of day columns", () => {
    const days = [
      new Date("2026-07-20"),
      new Date("2026-07-21"),
      new Date("2026-07-22"),
    ];
    const { container } = render(<TimelineGrid days={days} />);

    const columns = container.querySelectorAll('[class*="border-r"]');
    expect(columns).toHaveLength(3);
  });

  it("renders each day column with a left border", () => {
    const days = [new Date("2026-07-20"), new Date("2026-07-21")];
    const { container } = render(<TimelineGrid days={days} />);

    const columns = container.querySelectorAll('[class*="border-r"]');
    expect(columns).toHaveLength(2);
  });
});
