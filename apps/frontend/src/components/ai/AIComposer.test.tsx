import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AIComposer } from "./AIComposer";

describe("AIComposer emoji picker", () => {
  it("inserts the chosen emoji at the caret", async () => {
    const user = userEvent.setup();
    render(<AIComposer onSend={vi.fn()} />);
    const textarea = screen.getByPlaceholderText("Ask Prysm Note…") as HTMLTextAreaElement;

    await user.type(textarea, "hi");
    await user.click(screen.getByRole("button", { name: "Insert emoji" }));
    expect(screen.getByRole("dialog", { name: "Pick an emoji" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Insert 🎉" }));

    expect(textarea.value).toBe("hi🎉");
    expect(screen.queryByRole("dialog", { name: "Pick an emoji" })).toBeNull();
  });

  it("closes the picker on Escape", async () => {
    const user = userEvent.setup();
    render(<AIComposer onSend={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Insert emoji" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Pick an emoji" })).toBeNull();
  });

  it("closes the picker on an outside click", async () => {
    const user = userEvent.setup();
    render(<AIComposer onSend={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Insert emoji" }));
    await user.click(document.body);
    expect(screen.queryByRole("dialog", { name: "Pick an emoji" })).toBeNull();
  });
});

describe("AIComposer answer now", () => {
  it("shows the Answer now control while the AI is still thinking", async () => {
    const user = userEvent.setup();
    const onAnswerNow = vi.fn();
    render(<AIComposer onSend={vi.fn()} showAnswerNow onAnswerNow={onAnswerNow} />);
    const button = screen.getByRole("button", { name: "Answer now" });
    await user.click(button);
    expect(onAnswerNow).toHaveBeenCalledTimes(1);
  });

  it("hides the Answer now control once the reply is streaming", () => {
    render(<AIComposer onSend={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Answer now" })).toBeNull();
  });
});
