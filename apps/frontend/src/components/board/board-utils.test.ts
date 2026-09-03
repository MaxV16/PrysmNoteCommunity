import { describe, it, expect, beforeEach } from "vitest";
import {
  MUTED_PALETTE,
  BOARD_CARD_WIDTHS,
  BOARD_COLOR_KEY,
  hashString,
  isWideCard,
  cardColor,
  defaultCardColor,
  cardWidth,
  cardTopOffset,
  pickDecoration,
  getBoardColor,
  setBoardColor,
} from "./board-utils";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("board-utils", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("hashString is stable for the same input", () => {
    expect(hashString(UUID)).toBe(hashString(UUID));
    expect(hashString(UUID)).toBe(hashString(UUID));
  });

  it("hashString differs across inputs", () => {
    const ids = Array.from({ length: 8 }, (_, i) => `00000000-0000-0000-0000-00000000000${i}`);
    const hashes = new Set(ids.map(hashString));
    expect(hashes.size).toBe(ids.length);
  });

  it("cardColor returns an override when set, otherwise a deterministic palette member", () => {
    expect(cardColor(UUID, {})).toBe(defaultCardColor(UUID));
    expect(MUTED_PALETTE).toContain(cardColor(UUID, {}));
    expect(cardColor(UUID, { [UUID]: "#abcdef" })).toBe("#abcdef");
  });

  it("cardWidth returns one of the allowed widths deterministically", () => {
    const w = cardWidth(UUID);
    expect(BOARD_CARD_WIDTHS).toContain(w);
    expect(cardWidth(UUID)).toBe(w);
  });

  it("cardTopOffset is deterministic and within range", () => {
    const o = cardTopOffset(UUID);
    expect(o).toBeGreaterThanOrEqual(0);
    expect(o).toBeLessThan(48);
    expect(cardTopOffset(UUID)).toBe(o);
  });

  it("pickDecoration is deterministic and one of the known kinds", () => {
    const kinds = ["blob", "dots", "arc", "waves", "none"];
    const d = pickDecoration(UUID);
    expect(kinds).toContain(d);
    expect(pickDecoration(UUID)).toBe(d);
  });

  it("isWideCard is deterministic and yields both wide and standard cards across ids", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `00000000-0000-0000-0000-0000000000${i}`);
    for (const id of ids) {
      expect(isWideCard(id)).toBe(isWideCard(id));
    }
    const seen = new Set(ids.map(isWideCard));
    expect(seen.has(true)).toBe(true);
    expect(seen.has(false)).toBe(true);
  });

  it("setBoardColor/getBoardColor round-trip via localStorage", () => {
    setBoardColor(UUID, "#123456");
    expect(getBoardColor(UUID)).toBe("#123456");
    expect(JSON.parse(localStorage.getItem(BOARD_COLOR_KEY) as string)[UUID]).toBe("#123456");
  });

  it("loadColorOverrides tolerates corrupt storage", () => {
    localStorage.setItem(BOARD_COLOR_KEY, "not json");
    expect(getBoardColor(UUID)).toBe(defaultCardColor(UUID));
  });
});
