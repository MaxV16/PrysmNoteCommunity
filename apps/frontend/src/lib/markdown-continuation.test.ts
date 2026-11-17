import { describe, expect, it } from "vitest";
import { continueMarkdownList } from "./markdown-continuation";

const at = (value: string) => continueMarkdownList(value, value.length);

describe("continueMarkdownList", () => {
  it("starts the next checklist item", () => {
    expect(at("- [ ] buy milk")).toEqual({
      value: "- [ ] buy milk\n- [ ] ",
      caret: "- [ ] buy milk\n- [ ] ".length,
    });
  });

  it("always starts the next checklist unchecked", () => {
    expect(at("- [x] shipped")).toEqual({
      value: "- [x] shipped\n- [ ] ",
      caret: "- [x] shipped\n- [ ] ".length,
    });
  });

  it("continues a checked box written with an asterisk", () => {
    expect(at("* [X] one")).toEqual({
      value: "* [X] one\n* [ ] ",
      caret: "* [X] one\n* [ ] ".length,
    });
  });

  it("increments an ordered list instead of repeating the marker", () => {
    expect(at("1. first")).toEqual({
      value: "1. first\n2. ",
      caret: "1. first\n2. ".length,
    });
    expect(at("9) ninth")).toEqual({
      value: "9) ninth\n10) ",
      caret: "9) ninth\n10) ".length,
    });
  });

  it("keeps the bullet character the user chose", () => {
    expect(at("+ one")).toEqual({ value: "+ one\n+ ", caret: "+ one\n+ ".length });
    expect(at("* one")).toEqual({ value: "* one\n* ", caret: "* one\n* ".length });
  });

  it("keeps indentation so nested lists stay nested", () => {
    expect(at("  - [ ] nested")).toEqual({
      value: "  - [ ] nested\n  - [ ] ",
      caret: "  - [ ] nested\n  - [ ] ".length,
    });
  });

  it("keeps a blockquote marker", () => {
    expect(at("> a quoted line")).toEqual({
      value: "> a quoted line\n> ",
      caret: "> a quoted line\n> ".length,
    });
  });

  it("ends the list when the current item is empty", () => {
    expect(at("- [ ] ")).toEqual({ value: "", caret: 0 });
    expect(at("1. ")).toEqual({ value: "", caret: 0 });
    expect(at("> ")).toEqual({ value: "", caret: 0 });
  });

  it("handles an empty nested item without leaving the indent behind", () => {
    expect(at("  - [ ] ")).toEqual({ value: "  ", caret: 2 });
  });

  it("ignores plain paragraphs, selections and unknown markers", () => {
    expect(at("just a sentence")).toBeNull();
    expect(at("# heading")).toBeNull();
    expect(at("plain\n- item")).not.toBeNull();
    expect(continueMarkdownList("- [ ] one", 3, 6)).toBeNull();
  });

  it("splits the item at the caret instead of only appending", () => {
    const value = "- [ ] alpha beta";
    const result = continueMarkdownList(value, 11);
    expect(result).toEqual({
      value: "- [ ] alpha\n- [ ] beta",
      caret: "- [ ] alpha\n- [ ] ".length,
    });
  });
});
