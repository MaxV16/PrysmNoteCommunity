import { describe, it, expect } from "vitest";
import { normalizeAssistantMarkdown } from "./ai-format";

describe("normalizeAssistantMarkdown", () => {
  it("fixes emphasis written with stray spaces so bold actually renders", () => {
    expect(normalizeAssistantMarkdown("** what should the task be ?**")).toBe(
      "**what should the task be?**"
    );
    expect(normalizeAssistantMarkdown("** bold text **")).toBe("**bold text**");
    // "* x *" at line start is a list marker (preserved); mid-line it is emphasis.
    expect(normalizeAssistantMarkdown("and * x * and _ y _")).toBe("and *x* and _y_");
  });

  it("fixes spaces around punctuation and contractions", () => {
    expect(normalizeAssistantMarkdown("Give me a title ( e .g . daily , weekly )")).toBe(
      "Give me a title (e.g. daily, weekly)"
    );
    expect(normalizeAssistantMarkdown("I 'll create it")).toBe("I'll create it");
  });

  it("rejoins digits, ordinals, ranges and clock times split by streaming", () => {
    expect(normalizeAssistantMarkdown("4 \u2013 1 2 (recurs daily)")).toBe("4-12 (recurs daily)");
    expect(normalizeAssistantMarkdown("May 2 9 th , 2 0 2 7")).toBe("May 29th, 2027");
    expect(normalizeAssistantMarkdown("4 pm to 1 2 am")).toBe("4pm to 12am");
  });

  it("leaves clean markdown untouched", () => {
    const clean =
      "Done! **Drink water** is now an endless daily task (starts today).";
    expect(normalizeAssistantMarkdown(clean)).toBe(clean);
    expect(normalizeAssistantMarkdown("**a** **b** and *x*")).toBe("**a** **b** and *x*");
  });

  it("preserves GFM task-list checkboxes and lists", () => {
    expect(normalizeAssistantMarkdown("- [x] done\n- [ ] todo")).toBe(
      "- [x] done\n- [ ] todo"
    );
    expect(normalizeAssistantMarkdown("* item one\n* item two")).toBe(
      "* item one\n* item two"
    );
  });

  it("skips fenced code blocks", () => {
    const code = "```python\nx = [1 , 2]\n```\n** summary **";
    expect(normalizeAssistantMarkdown(code)).toBe(
      "```python\nx = [1 , 2]\n```\n**summary**"
    );
  });
});
