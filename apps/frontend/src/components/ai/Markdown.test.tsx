import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { Markdown } from "./Markdown";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Markdown task list checkboxes", () => {
  const list = "- [ ] first\n- [x] second";

  it("renders task list checkboxes read-only without a toggle handler", () => {
    render(<Markdown>{list}</Markdown>);
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(boxes[0].disabled).toBe(true);
    expect(boxes[0].checked).toBe(false);
    expect(boxes[1].checked).toBe(true);
  });

  it("reports the source line index and the new checked state", () => {
    const onToggleChecklist = vi.fn();
    render(<Markdown onToggleChecklist={onToggleChecklist}>{list}</Markdown>);

    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes[0].disabled).toBe(false);

    fireEvent.click(boxes[0]);
    expect(onToggleChecklist).toHaveBeenCalledWith(0, true);

    // Re-query: the optimistic state re-renders the markdown, so the previously
    // captured nodes are replaced.
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(onToggleChecklist).toHaveBeenCalledWith(1, false);
  });

  it("keeps a tick visible while the save is in flight", () => {
    render(<Markdown onToggleChecklist={() => {}}>{list}</Markdown>);
    const box = screen.getAllByRole("checkbox")[0] as HTMLInputElement;
    fireEvent.click(box);
    expect(box.checked).toBe(true);
  });
});

describe("Markdown images", () => {
  it("copies the image URL when the clipboard image API is unavailable", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText, write: vi.fn() },
      configurable: true,
    });
    vi.stubGlobal("ClipboardItem", undefined);

    render(<Markdown>{"![alt](https://example.com/pic.png)"}</Markdown>);

    const image = screen.getByRole("button", { name: "Copy image: alt" });
    fireEvent.click(image);

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://example.com/pic.png")
    );
    await waitFor(() => expect(image.getAttribute("title")).toBe("Image link copied"));
  });

  it("supports keyboard activation for copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText, write: vi.fn() },
      configurable: true,
    });
    vi.stubGlobal("ClipboardItem", undefined);

    render(<Markdown>{"![alt](/api/uploads/pic.png)"}</Markdown>);

    fireEvent.keyDown(screen.getByRole("button", { name: "Copy image: alt" }), {
      key: "Enter",
    });

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("/api/uploads/pic.png")
    );
  });

  it("opens the editor on click while keeping a separate copy button", async () => {
    const onActivate = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText, write: vi.fn() },
      configurable: true,
    });
    vi.stubGlobal("ClipboardItem", undefined);

    render(
      <Markdown onImageActivate={onActivate} imageActionLabel="Edit description">
        {"![chart](/api/uploads/chart.png)"}
      </Markdown>
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit description: chart" }));
    expect(onActivate).toHaveBeenCalledWith("/api/uploads/chart.png");

    fireEvent.click(screen.getByRole("button", { name: "Copy image: chart" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("/api/uploads/chart.png")
    );
  });
});
