import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { Markdown } from "./Markdown";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
