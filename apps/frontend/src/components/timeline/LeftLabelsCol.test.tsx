import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { LeftLabelsCol } from "./LeftLabelsCol";
import type { BoardSection } from "@/lib/board-sections";

const sections: BoardSection[] = [
  { id: "s1", title: "Work", color: "#ff0000", kind: "timeline", status: null, position: 0 },
  { id: "s2", title: "Home", color: "#00ff00", kind: "timeline", status: null, position: 1 },
];

function renderCol(rail: boolean, onToggleRail = vi.fn()) {
  return render(
    <DndContext>
      <LeftLabelsCol
        sections={sections}
        counts={{ s1: 3, s2: 1 }}
        collapsedMap={{}}
        rowHeights={{ s1: 80, s2: 120 }}
        unsortedCount={2}
        unsortedHeight={100}
        onToggleCollapse={vi.fn()}
        onRename={vi.fn()}
        onMove={vi.fn()}
        onDelete={vi.fn()}
        onAddSection={vi.fn()}
        rail={rail}
        onToggleRail={onToggleRail}
      />
    </DndContext>
  );
}

describe("LeftLabelsCol rail mode", () => {
  it("renders the full label column with titles when not railed", () => {
    const { container, queryByTestId, getByText } = renderCol(false);
    const root = container.querySelector('[data-section-rail="false"]') as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.className).toContain("w-[38vw]");
    expect(root.className).toContain("max-w-[150px]");
    expect(container.textContent).toContain("Work");
    expect(container.textContent).toContain("Home");
    // Titles stay on one line so a long name cannot grow the lane row.
    expect(getByText("Work").className).toContain("truncate");
    // Expanded shows the collapse control, not the rail expand control.
    expect(queryByTestId("expand-sections-rail")).toBeNull();
    expect(queryByTestId("collapse-sections-rail")).toBeTruthy();
  });

  it("collapses to a narrow rail without titles", () => {
    const { container, getByTestId, queryByTestId } = renderCol(true);
    const root = container.querySelector('[data-section-rail="true"]') as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.className).toContain("w-10");
    // Titles and the "Unsorted" label are dropped; counts stay.
    expect(container.textContent).not.toContain("Work");
    expect(container.textContent).not.toContain("Unsorted");
    expect(container.textContent).toContain("3");
    // Droppable targets must survive so drag-into-section still works.
    expect(container.querySelectorAll("[data-section-drop-target]")).toHaveLength(2);
    expect(getByTestId("expand-sections-rail")).toBeTruthy();
    expect(queryByTestId("collapse-sections-rail")).toBeNull();
  });

  it("calls onToggleRail from the rail expand control", () => {
    const onToggleRail = vi.fn();
    const { getByTestId } = renderCol(true, onToggleRail);
    fireEvent.click(getByTestId("expand-sections-rail"));
    expect(onToggleRail).toHaveBeenCalledTimes(1);
  });

  it("calls onToggleRail from the expanded collapse control", () => {
    const onToggleRail = vi.fn();
    const { getByTestId } = renderCol(false, onToggleRail);
    fireEvent.click(getByTestId("collapse-sections-rail"));
    expect(onToggleRail).toHaveBeenCalledTimes(1);
  });
});
