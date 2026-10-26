import { beforeEach, describe, expect, it } from "vitest";
import { clear, list, push, readRecentPreset, remove, stripRelativeRefs, writeRecentPreset } from "./askAiHistory";
import type { ComposerDoc } from "../components/ai/composer/types";

const KEY = "brise.askAiHistory.v1";

const doc = (text: string): ComposerDoc => [{ t: "text", v: text }];
const base = { where: "section" as const, targetKind: "note" as const, noteTitle: "노트 A", refs: [] };

beforeEach(() => {
  localStorage.clear();
});

describe("askAiHistory", () => {
  it("pushes to the front, dedupes by sentence, and caps at 30", () => {
    push({ ...base, doc: doc("첫째") });
    push({ ...base, doc: doc("둘째") });
    expect(list().map((e) => e.doc[0])).toEqual([{ t: "text", v: "둘째" }, { t: "text", v: "첫째" }]);

    // 같은 문장 → 한 건으로 합쳐 맨 앞
    push({ ...base, doc: doc("첫째"), noteTitle: "노트 B" });
    const l = list();
    expect(l).toHaveLength(2);
    expect(l[0].doc[0]).toEqual({ t: "text", v: "첫째" });
    expect(l[0].noteTitle).toBe("노트 B");

    for (let i = 0; i < 40; i++) push({ ...base, doc: doc(`n${i}`) });
    expect(list()).toHaveLength(30);
    expect(list()[0].doc[0]).toEqual({ t: "text", v: "n39" });
  });

  it("strips relative refs to body (or selection for selection targets), keeps absolute ones", () => {
    const refs = [
      { k: "section", id: "s1" },
      { k: "body" },
      { k: "note", id: "n9" },
      { k: "file", name: "a.md" },
      { k: "folder", id: "f1" },
      { k: "weather" },
    ] as const;
    // 두 상대 참조가 같은 body 로 접히면 한 줄로 합쳐진다.
    expect(stripRelativeRefs([...refs], "section")).toEqual([
      { k: "body" },
      { k: "note", id: "n9" },
      { k: "file", name: "a.md" },
      { k: "folder", id: "f1" },
      { k: "weather" },
    ]);
    expect(stripRelativeRefs([{ k: "section", id: "s1" }], "selection")).toEqual([{ k: "selection" }]);

    const saved = push({ ...base, doc: doc("요약"), refs: [...refs], targetKind: "section" });
    expect(saved.refs[0]).toEqual({ k: "body" });
    expect(JSON.parse(localStorage.getItem(KEY)!)[0].refs[0]).toEqual({ k: "body" });
  });

  it("round-trips absolute refs verbatim through storage", () => {
    push({ ...base, doc: doc("이 폴더 요약"), refs: [{ k: "folder", id: "f1" }, { k: "weather" }] });
    expect(list()[0].refs).toEqual([{ k: "folder", id: "f1" }, { k: "weather" }]);
  });

  it("dedupes by sentence regardless of which section it ran on", () => {
    push({ ...base, doc: doc("요약"), refs: [{ k: "section", id: "s1" }], targetKind: "section" });
    push({ ...base, doc: doc("요약"), refs: [{ k: "section", id: "s2" }], targetKind: "section" });
    expect(list()).toHaveLength(1);
  });

  it("remove / clear", () => {
    const a = push({ ...base, doc: doc("a") });
    push({ ...base, doc: doc("b") });
    remove(a.id);
    expect(list().map((e) => e.doc[0])).toEqual([{ t: "text", v: "b" }]);
    clear();
    expect(list()).toEqual([]);
  });

  it("corrupt or malformed storage reads as empty; pre-refs entries read as refs: []", () => {
    localStorage.setItem(KEY, "{not json");
    expect(list()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify([{ id: 1 }, { id: "x", at: 1, doc: [{ t: "bogus" }], where: "section", targetKind: "note", noteTitle: "" }]));
    expect(list()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify([{ id: "ok", at: 1, doc: [{ t: "text", v: "hi" }], where: "section", targetKind: "note", noteTitle: "T" }]));
    expect(list()).toHaveLength(1);
    expect(list()[0].refs).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify([{ id: "ok", at: 1, doc: [{ t: "text", v: "hi" }], refs: [{ k: "nope" }], where: "section", targetKind: "note", noteTitle: "T" }]));
    expect(list()).toEqual([]);
  });

  it("recent preset keeps the legacy key and shape", () => {
    localStorage.setItem("brise.askAiRecentChip.v1", JSON.stringify({ "section:diagram": "diagram_align" }));
    expect(readRecentPreset("section:diagram")).toBe("diagram_align");
    expect(readRecentPreset("note")).toBeNull();
    writeRecentPreset("note", "summarize");
    expect(JSON.parse(localStorage.getItem("brise.askAiRecentChip.v1")!)).toEqual({
      "section:diagram": "diagram_align",
      note: "summarize",
    });
  });

  // 이전 결과 참조(`result`, 이어서 다듬기)는 그 모달 안에서만 뜻이 있다 — 저장하지 않는다. 남기면 읽는
  // 쪽이 모르는 종류라 그 기록 한 줄이 통째로 버려진다(2026-09-27).
  it("never stores a result ref — and the entry itself survives", () => {
    push({
      doc: [{ t: "text", v: "더 짧게" }],
      refs: [{ k: "body" }, { k: "result", key: "req-1" }],
      where: "section",
      targetKind: "note",
      noteTitle: "N",
    });
    const [entry] = list();
    expect(entry).toBeTruthy();
    expect(entry.refs).toEqual([{ k: "body" }]);
  });
});
