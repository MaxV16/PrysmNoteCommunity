import { describe, it, expect, vi } from "vitest";
import { useRef, useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarkdownToolbar, applyMarkdownAction } from "./MarkdownToolbar";

function makeTextarea(value: string, start: number, end = start) {
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setSelectionRange(start, end);
  return ta;
}

describe("applyMarkdownAction", () => {
  it("wraps the selection in bold", () => {
    const ta = makeTextarea("hello world", 0, 5);
    applyMarkdownAction(ta, "bold");
    expect(ta.value).toBe("**hello** world");
  });

  it("unwraps when the selection is already bold", () => {
    const ta = makeTextarea("**hello** world", 2, 7);
    applyMarkdownAction(ta, "bold");
    expect(ta.value).toBe("hello world");
  });

  it("inserts a placeholder when nothing is selected", () => {
    const ta = makeTextarea("", 0, 0);
    applyMarkdownAction(ta, "bold");
    expect(ta.value).toBe("**bold text**");
    // The placeholder stays selected so the user can type over it.
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([2, 11]);
  });

  it("prefixes every selected line and toggles back off", () => {
    const ta = makeTextarea("one\ntwo", 0, 7);
    applyMarkdownAction(ta, "bullet");
    expect(ta.value).toBe("- one\n- two");
    ta.setSelectionRange(0, ta.value.length);
    applyMarkdownAction(ta, "bullet");
    expect(ta.value).toBe("one\ntwo");
  });

  it("fences the selection as a code block", () => {
    const ta = makeTextarea("x = 1", 0, 5);
    applyMarkdownAction(ta, "code");
    expect(ta.value).toBe("```\nx = 1\n```");
  });

  it("inserts a link and selects the URL placeholder", () => {
    const ta = makeTextarea("", 0, 0);
    applyMarkdownAction(ta, "link");
    expect(ta.value).toBe("[link text](url)");
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe("url");
  });
});

function Harness() {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  return (
    <>
      <MarkdownToolbar textareaRef={ref} onChange={setValue} />
      <textarea ref={ref} aria-label="draft" value={value} onChange={(e) => setValue(e.target.value)} />
    </>
  );
}

describe("MarkdownToolbar", () => {
  it("emits the new value when a formatting button is pressed", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const ta = screen.getByLabelText("draft") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello world" } });
    ta.setSelectionRange(0, 5);

    await user.click(screen.getByRole("button", { name: "Bold" }));

    expect(ta.value).toBe("**hello** world");
  });

  it("does nothing when the textarea is not mounted", () => {
    const onChange = vi.fn();
    render(<MarkdownToolbar textareaRef={{ current: null }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Italic" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
