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
    // Mid-word contractions (the word before the apostrophe is not a single
    // letter, so the old \b anchor missed them).
    expect(normalizeAssistantMarkdown("I can 't do that .")).toBe("I can't do that.");
    expect(normalizeAssistantMarkdown("then I 'll delete them one by one .")).toBe(
      "then I'll delete them one by one."
    );
    expect(normalizeAssistantMarkdown("we don 't have the stuff .")).toBe("we don't have the stuff.");
  });

  it("handles curly-quote apostrophes", () => {
    expect(normalizeAssistantMarkdown("I ’ ll do that . maybe don’t worry")).toBe(
      "I’ll do that. maybe don’t worry"
    );
    expect(normalizeAssistantMarkdown("he’s gone , it ’ s fine")).toBe("he’s gone, it’s fine");
  });

  it("rejoins split UUIDs and quoted words", () => {
    expect(
      normalizeAssistantMarkdown(
        "1 . ID :\n\n3 5 8 b 2 5 0 b\n0 9 5 5\n4 0 d 8 -b 9 5 0\n5 7 4 b 6 2 5 1 f 2 f 2"
      )
    ).toBe("1. ID:\n\n358b250b\n0955\n40d8-b950\n574b6251f2f2");
    expect(normalizeAssistantMarkdown("2 tasks titled \" Work \" scheduled .")).toBe(
      '2 tasks titled "Work" scheduled.'
    );
    // A run without a digit is an ordinary list of words - never collapsed.
    expect(normalizeAssistantMarkdown("a b c d e f g")).toBe("a b c d e f g");
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
