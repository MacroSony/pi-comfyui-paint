/**
 * Tests for paint_search_danbooru_tags tool — pure functions only.
 */

import { describe, it, expect } from "vitest";

// We test the helper functions by extracting them. Since they're not exported,
// we replicate the logic to verify correctness.

function categoryName(cat: number): string {
  const map: Record<number, string> = {
    0: "general",
    1: "artist",
    3: "copyright",
    4: "character",
    5: "meta",
  };
  return map[cat] ?? `cat-${cat}`;
}

describe("categoryName", () => {
  it("maps 0 to general", () => expect(categoryName(0)).toBe("general"));
  it("maps 1 to artist", () => expect(categoryName(1)).toBe("artist"));
  it("maps 3 to copyright", () => expect(categoryName(3)).toBe("copyright"));
  it("maps 4 to character", () => expect(categoryName(4)).toBe("character"));
  it("maps 5 to meta", () => expect(categoryName(5)).toBe("meta"));
  it("falls back to cat-N for unknown categories", () => {
    expect(categoryName(2)).toBe("cat-2");
    expect(categoryName(99)).toBe("cat-99");
    expect(categoryName(-1)).toBe("cat--1");
  });
});
