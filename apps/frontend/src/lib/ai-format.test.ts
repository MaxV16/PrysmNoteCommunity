import { describe, it, expect } from "vitest";
import { normalizeAssistantMarkdown, stripTextToolCalls } from "./ai-format";

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

describe("user QA corpus (fragmented streaming artifacts)", () => {
  it("rejoins words split by fragmented streaming and fixes the literal prod artifacts", () => {
    expect(normalizeAssistantMarkdown("I 've cancelled the following tasks :")).toBe(
      "I've cancelled the following tasks:"
    );
    expect(normalizeAssistantMarkdown("Work ( tom orrow 4 \u2013 1 2 )")).toBe(
      "Work (tomorrow 4-12)"
    );
    expect(normalizeAssistantMarkdown("Pr ys m Note")).toBe("Prysm Note");
    expect(normalizeAssistantMarkdown("To use the finance feature in Pr ys m Note")).toBe(
      "To use the finance feature in Prysm Note"
    );
    expect(
      normalizeAssistantMarkdown("In Fin ance you can track Exp enses, Lo ans and De leting.")
    ).toBe("In Finance you can track Expenses, Loans and Deleting.");
  });

  it("cleans the exact user QA string (voice-dictated welcome copy) and caps variant", () => {
    expect(
      normalizeAssistantMarkdown(
        "I 'm Pr ys m AI , a hyper -int elligent task management agent designed to assist with scheduling , organizing , and optimizing your tasks and productivity ."
      )
    ).toBe(
      "I'm Prysm AI, a hyper-intelligent task management agent designed to assist with scheduling, organizing, and optimizing your tasks and productivity."
    );
    expect(normalizeAssistantMarkdown("Pr ys m AI")).toBe("Prysm AI");
  });

  it("re-splits words merged by a dropped space", () => {
    expect(normalizeAssistantMarkdown("Trackand Manage your day")).toBe("Track and Manage your day");
  });

  it("keeps emphasis markers tight even when the inner text was split", () => {
    expect(normalizeAssistantMarkdown("** Settings **")).toBe("**Settings**");
  });

  it("never changes ordinary prose (safety net)", () => {
    for (const clean of [
      "it is now the time",
      "to be or not to be",
      "new house",
      "a b c",
      "no one knows",
      "in to",
      "Track and Manage is a real feature",
    ]) {
      expect(normalizeAssistantMarkdown(clean)).toBe(clean);
    }
  });
});

describe("stripTextToolCalls", () => {
  it("removes [TOOL_CALLS] name {json} blocks but keeps surrounding prose", () => {
    expect(
      stripTextToolCalls(
        'I tried to delete them . [TOOL_CALLS] search_tasks {" query ": " work ", " limit ":\n\n2 5 0 }'
      )
    ).toBe("I tried to delete them . ");
  });

  it("handles nested braces inside the JSON", () => {
    expect(
      stripTextToolCalls(
        '[TOOL_CALLS] update_task {"task_id": "x", "fields": {"status": "done"}}'
      )
    ).toBe("");
  });

  it("strips multiple blocks in one reply", () => {
    expect(
      stripTextToolCalls(
        '[TOOL_CALLS] create_task {"title": "A"}\n[TOOL_CALLS] create_task {"title": "B"}'
      )
    ).toBe("\n");
  });

  it("keeps incomplete blocks so a mid-stream partial never corrupts text", () => {
    expect(stripTextToolCalls('text [TOOL_CALLS] search_tasks {"query": "wo')).toBe(
      'text [TOOL_CALLS] search_tasks {"query": "wo'
    );
    expect(stripTextToolCalls("text [TOOL_CALLS] search_tasks")).toBe(
      "text [TOOL_CALLS] search_tasks"
    );
  });

  it("leaves clean text untouched", () => {
    expect(stripTextToolCalls("no tools here")).toBe("no tools here");
    expect(stripTextToolCalls("")).toBe("");
  });

  it("composes with the markdown normalizer for the exact prod artifact", () => {
    const raw =
      'I tried to delete the\n\n2 work tasks , but both failed because they were not found . I \'ll search again to find the correct tasks to delete . [TOOL_CALLS] search_tasks {" query ": " work ", " limit ":\n\n2 5 0 }';
    expect(normalizeAssistantMarkdown(stripTextToolCalls(raw))).toBe(
      "I tried to delete the\n\n2 work tasks, but both failed because they were not found. I'll search again to find the correct tasks to delete. "
    );
  });
});
