import { describe, it, expect, beforeEach } from "vitest";
import { getLedgerEntry, recordLedger, removeLedger, resetLedgerForTest, updateLedgerFiles } from "./mobileImportLedger";
import type { ImportFile } from "./mobileImport";

const f = (idx: number): ImportFile => ({ idx, name: `p${idx}.jpg`, mime: "image/jpeg", size: 3, url: `/__shell/import/i1/${idx}` });

describe("mobileImportLedger — importId→노트 내구 기록", () => {
  beforeEach(() => resetLedgerForTest());

  it("기록·줄이기·지우기", () => {
    recordLedger("i1", "n1", [f(0), f(1)]);
    expect(getLedgerEntry("i1")).toMatchObject({ noteId: "n1" });
    updateLedgerFiles("i1", [f(1)]);
    expect(getLedgerEntry("i1")?.files.map((x) => x.idx)).toEqual([1]);
    removeLedger("i1");
    expect(getLedgerEntry("i1")).toBeUndefined();
  });

  it("페이지를 새로 읽어도(메모리 사본이 사라져도) 저장소에서 되살아난다. 항목이 없으면 줄이기는 아무것도 만들지 않는다", () => {
    recordLedger("i1", "n1", [f(0)]);
    const raw = window.localStorage.getItem("brise.importLedger.v1");
    resetLedgerForTest();
    window.localStorage.setItem("brise.importLedger.v1", raw!);
    expect(getLedgerEntry("i1")?.noteId).toBe("n1");
    updateLedgerFiles("none", [f(0)]);
    expect(getLedgerEntry("none")).toBeUndefined();
  });
});
