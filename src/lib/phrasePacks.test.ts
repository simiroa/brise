import { describe, it, expect } from "vitest";
import {
  PHRASE_PACK_OFF,
  bundledPhrasePacks,
  defaultPhrasePackId,
  findPack,
  parsePhrasePack,
  parseAiPhraseItems,
  pickPhrase,
} from "./phrasePacks";

describe("parsePhrasePack", () => {
  it("accepts valid schema", () => {
    const p = parsePhrasePack(
      { name: "Test", items: [{ text: "Hello", source: "A" }, { text: "  " }, { text: "World" }] },
      "bundled:test",
      "bundled",
    );
    expect(p).not.toBeNull();
    expect(p!.name).toBe("Test");
    expect(p!.items).toHaveLength(2);
    expect(p!.items[0].source).toBe("A");
  });

  it("soft-skips invalid packs", () => {
    expect(parsePhrasePack(null, "x", "user")).toBeNull();
    expect(parsePhrasePack({ name: "n" }, "x", "user")).toBeNull();
    expect(parsePhrasePack({ name: "n", items: [] }, "x", "user")).toBeNull();
    expect(parsePhrasePack({ name: "n", items: [{ text: "" }] }, "x", "user")).toBeNull();
  });
});

describe("bundled packs", () => {
  it("loads 2 packs with 30+ items each", () => {
    const packs = bundledPhrasePacks();
    expect(packs.length).toBeGreaterThanOrEqual(2);
    for (const p of packs) {
      expect(p.items.length).toBeGreaterThanOrEqual(30);
      expect(p.id.startsWith("bundled:")).toBe(true);
    }
  });

  it("defaultPhrasePackId points at a bundled pack", () => {
    const id = defaultPhrasePackId();
    expect(id).not.toBe(PHRASE_PACK_OFF);
    expect(findPack(bundledPhrasePacks(), id)).not.toBeNull();
  });
});

describe("parseAiPhraseItems", () => {
  it("parses a bare JSON array", () => {
    const items = parseAiPhraseItems('[{"text":"A","source":"S"},{"text":"B"}]');
    expect(items).toEqual([{ text: "A", source: "S" }, { text: "B" }]);
  });

  it("strips code fences and surrounding chatter", () => {
    const raw = 'Here you go!\n```json\n[{"text":" A "},{"text":"B"}]\n```\nHope that helps.';
    expect(parseAiPhraseItems(raw)).toEqual([{ text: "A" }, { text: "B" }]);
  });

  it("accepts an {items:[...]} wrapper and plain strings", () => {
    expect(parseAiPhraseItems('{"items":["A","B"]}')).toEqual([{ text: "A" }, { text: "B" }]);
  });

  it("drops blank / malformed entries and empty sources", () => {
    const items = parseAiPhraseItems('[{"text":"  "},{"text":"A","source":"  "},null,42,{"nope":1}]');
    expect(items).toEqual([{ text: "A" }]);
  });

  it("caps at PHRASE_PACK_MAX_ITEMS", () => {
    const raw = JSON.stringify(Array.from({ length: 250 }, (_, i) => ({ text: `p${i}` })));
    expect(parseAiPhraseItems(raw)).toHaveLength(200);
  });

  it("returns [] on unparseable / empty input", () => {
    expect(parseAiPhraseItems("")).toEqual([]);
    expect(parseAiPhraseItems("sorry, I cannot do that")).toEqual([]);
    expect(parseAiPhraseItems("[{text: broken}")).toEqual([]);
    expect(parseAiPhraseItems("[]")).toEqual([]);
  });
});

describe("pickPhrase", () => {
  it("returns an item from the pack", () => {
    const pack = bundledPhrasePacks()[0];
    const item = pickPhrase(pack);
    expect(pack.items.some((i) => i.text === item.text)).toBe(true);
  });
});
