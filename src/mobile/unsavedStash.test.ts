import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/diag", () => ({ reportFallback: vi.fn() }));

import { reportFallback } from "../lib/diag";
import {
  MAX_STASHES,
  listStashes,
  putStash,
  putStashes,
  removeStash,
  stashesForNote,
  type NewUnsavedStash,
  type StashStorage,
} from "./unsavedStash";

const entry = (over: Partial<NewUnsavedStash> = {}): NewUnsavedStash => ({
  noteId: "n1",
  sectionId: "s1",
  sectionName: "Overview",
  kind: "text",
  bodyMd: "hello",
  ...over,
});

/** 진짜 저장소를 흉내 내되 던지거나 조용히 무시하게 만들 수 있다. */
function fakeStorage(mode: "ok" | "set-throws" | "get-throws" | "set-noop" = "ok", seed?: string): StashStorage & { raw: () => string | null } {
  let value: string | null = seed ?? null;
  return {
    getItem: () => {
      if (mode === "get-throws") throw new Error("blocked");
      return value;
    },
    setItem: (_k: string, v: string) => {
      if (mode === "set-throws") throw new DOMException("full", "QuotaExceededError");
      if (mode === "set-noop") return;
      value = v;
    },
    raw: () => value,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(reportFallback).mockClear();
});

describe("unsavedStash — 보관·조회", () => {
  it("본문·섹션·노트 id 를 그대로 되돌려 주고, 이 노트 것만 최신이 앞으로 준다", () => {
    expect(putStash(entry({ bodyMd: "one" }))).toBe(true);
    expect(putStash(entry({ bodyMd: "two", sectionId: "s2", sectionName: "Notes" }))).toBe(true);
    expect(putStash(entry({ noteId: "other", bodyMd: "elsewhere" }))).toBe(true);

    const mine = stashesForNote("n1");
    expect(mine.map((s) => s.bodyMd)).toEqual(["two", "one"]);
    expect(mine[0]).toMatchObject({ noteId: "n1", sectionId: "s2", sectionName: "Notes", kind: "text" });
    expect(Number.isNaN(Date.parse(mine[0].savedAt))).toBe(false);
    expect(new Set(listStashes().map((s) => s.id)).size).toBe(3); // 항목마다 고유 id
    expect(stashesForNote("nobody")).toEqual([]);
  });

  it("같은 (노트·섹션·종류·본문)을 다시 보관하면 하나로 합친다", () => {
    putStash(entry());
    putStash(entry());
    expect(listStashes()).toHaveLength(1);
    putStash(entry({ bodyMd: "edited" })); // 본문이 다르면 별개
    expect(listStashes()).toHaveLength(2);
  });

  it("putStashes 는 전부 아니면 전무 — 쓰기가 던지면 하나도 안 남고 false", () => {
    const storage = fakeStorage("set-throws");
    expect(putStashes([entry(), entry({ sectionId: "s2", bodyMd: "b" })], storage)).toBe(false);
    expect(storage.raw()).toBeNull();
    expect(reportFallback).toHaveBeenCalledWith("mobile-save", "stash_write_failed");
  });

  it("setItem 이 조용히 무시되는 저장소는 읽어 보고 실패로 본다", () => {
    expect(putStash(entry(), fakeStorage("set-noop"))).toBe(false);
  });

  it("저장소가 없으면(null) false 이고 기록한다", () => {
    expect(putStash(entry(), null)).toBe(false);
    expect(reportFallback).toHaveBeenCalledWith("mobile-save", "stash_unavailable");
  });

  it("빈 목록을 넣는 건 할 일이 없으니 true", () => {
    expect(putStashes([], fakeStorage("set-throws"))).toBe(true);
  });
});

describe("unsavedStash — 상한", () => {
  it(`${MAX_STASHES}개를 넘으면 가장 오래된 것부터 버리고 개수만 기록한다(본문 없음)`, () => {
    for (let i = 0; i < MAX_STASHES + 5; i++) putStash(entry({ bodyMd: `secret-body-${i}` }));
    const all = listStashes();
    expect(all).toHaveLength(MAX_STASHES);
    expect(all[0].bodyMd).toBe("secret-body-5"); // 0~4 가 밀려났다
    expect(all[all.length - 1].bodyMd).toBe(`secret-body-${MAX_STASHES + 4}`);

    const dropped = vi.mocked(reportFallback).mock.calls.filter((c) => c[1] === "stash_dropped");
    expect(dropped).toHaveLength(5); // 쓸 때마다 하나씩
    expect(dropped.every((c) => c[0] === "mobile-save" && c[2] === "1")).toBe(true);
    // 진단 로그에는 본문·이름이 절대 안 들어간다.
    expect(JSON.stringify(vi.mocked(reportFallback).mock.calls)).not.toContain("secret-body");
    expect(JSON.stringify(vi.mocked(reportFallback).mock.calls)).not.toContain("Overview");
  });

  it("한 번에 상한을 넘겨 넣어도 최신 쪽이 남는다", () => {
    const many = Array.from({ length: MAX_STASHES + 3 }, (_, i) => entry({ bodyMd: `b${i}`, sectionId: `s${i}` }));
    expect(putStashes(many)).toBe(true);
    const all = listStashes();
    expect(all).toHaveLength(MAX_STASHES);
    expect(all[0].bodyMd).toBe("b3");
    expect(vi.mocked(reportFallback)).toHaveBeenCalledWith("mobile-save", "stash_dropped", "3");
  });
});

describe("unsavedStash — 지우기", () => {
  it("id 로 하나만 지운다(같은 노트의 다른 보관본은 남는다)", () => {
    putStash(entry({ bodyMd: "a" }));
    putStash(entry({ bodyMd: "b", sectionId: "s2" }));
    const [first, second] = listStashes();
    expect(removeStash(first.id)).toBe(true);
    expect(listStashes().map((s) => s.id)).toEqual([second.id]);
  });

  it("이미 없는 id 는 true(멱등), 쓰기 실패는 false 이고 항목이 남는다", () => {
    expect(removeStash("ghost")).toBe(true);

    const storage = fakeStorage("ok");
    putStash(entry(), storage);
    const [only] = listStashes(storage);
    const failing: StashStorage = { getItem: storage.getItem, setItem: () => { throw new Error("full"); } };
    expect(removeStash(only.id, failing)).toBe(false);
    expect(listStashes(storage)).toHaveLength(1);
    expect(reportFallback).toHaveBeenCalledWith("mobile-save", "stash_remove_failed");
  });
});

describe("unsavedStash — 읽기 실패", () => {
  it("getItem 이 던지면 [] 이고 기록한다", () => {
    expect(listStashes(fakeStorage("get-throws"))).toEqual([]);
    expect(reportFallback).toHaveBeenCalledWith("mobile-save", "stash_read_failed");
  });

  it("깨진 JSON·배열이 아닌 값은 [] 이고 기록한다", () => {
    expect(listStashes(fakeStorage("ok", "{not json"))).toEqual([]);
    expect(listStashes(fakeStorage("ok", '{"a":1}'))).toEqual([]);
    expect(vi.mocked(reportFallback).mock.calls.filter((c) => c[1] === "stash_corrupt")).toHaveLength(2);
  });

  it("모양이 틀린 항목만 걸러내고 나머지는 살린다", () => {
    const good = { id: "x", noteId: "n1", sectionId: "s1", sectionName: "A", kind: "text", bodyMd: "ok", savedAt: "2026-10-07T00:00:00.000Z" };
    const bad = { id: "y", noteId: "n1", kind: "other" };
    const storage = fakeStorage("ok", JSON.stringify([bad, good, null, 3]));
    expect(listStashes(storage)).toEqual([good]);
  });
});
