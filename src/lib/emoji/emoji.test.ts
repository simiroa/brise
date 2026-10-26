import { describe, it, expect } from "vitest";
import { emojiKey, bundledKeyFor, addRecentEmoji } from "./emojiCore";
import { emojiByKey, EMOJI, EMOJI_GROUPS } from "./emojiManifest";
import bundled from "./bundled.json";

describe("emojiKey", () => {
  it("keys a single-codepoint emoji as lowercased hex", () => {
    expect(emojiKey("😀")).toBe("1f600");
  });
  it("keys a VS16-qualified emoji with the selector", () => {
    expect(emojiKey("❤️")).toBe("2764-fe0f");
  });
  it("keys a ZWJ sequence with all codepoints hyphen-joined", () => {
    // eye in speech bubble: 1f441 fe0f 200d 1f5e8 fe0f
    expect(emojiKey("👁️‍🗨️")).toBe("1f441-fe0f-200d-1f5e8-fe0f");
  });
});

describe("bundledKeyFor", () => {
  const list = bundled as string[];
  it("resolves a glyph whose exact key is bundled", () => {
    // pick any bundled single-codepoint entry and round-trip it through a real glyph
    const single = list.find((k) => !k.includes("-"))!;
    const glyph = String.fromCodePoint(parseInt(single, 16));
    expect(bundledKeyFor(glyph)).toBe(single);
  });
  it("returns null for a non-bundled / non-emoji char", () => {
    expect(bundledKeyFor("A")).toBeNull();
  });
  it("tolerates a bare vs FE0F-qualified mismatch when a stripped key is bundled", () => {
    const stripped = list.find((k) => !k.includes("-"));
    if (stripped) {
      // adding a spurious FE0F must still resolve back to the bundled bare key
      const glyph = String.fromCodePoint(parseInt(stripped, 16)) + "️";
      expect(bundledKeyFor(glyph)).toBe(stripped);
    }
  });
});

describe("addRecentEmoji", () => {
  it("puts a new key at the front", () => {
    expect(addRecentEmoji(["1f601"], "1f600")).toEqual(["1f600", "1f601"]);
  });
  it("dedupes — re-picking an existing key moves it to the front instead of duplicating", () => {
    expect(addRecentEmoji(["1f601", "1f600", "1f602"], "1f600")).toEqual(["1f600", "1f601", "1f602"]);
  });
  it("caps at max, dropping the oldest", () => {
    const list = ["a", "b", "c"];
    expect(addRecentEmoji(list, "d", 3)).toEqual(["d", "a", "b"]);
  });
});

describe("emojiManifest", () => {
  it("loads manifest entries and groups", () => {
    expect(EMOJI.length).toBeGreaterThan(0);
    expect(EMOJI_GROUPS.length).toBeGreaterThan(0);
  });
  it("looks up entry by unicode key", () => {
    const grinning = emojiByKey("1f600");
    expect(grinning).toBeDefined();
    expect(grinning?.g).toBe("😀");
  });
});

