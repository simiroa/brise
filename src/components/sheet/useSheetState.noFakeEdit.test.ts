import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { Section } from "../../lib/commands.gen";

const h = vi.hoisted(() => ({
  updateSectionBody: vi.fn(async (_id: string, _body: string) => {}),
  flushers: [] as Array<() => Promise<void> | void>,
}));

vi.mock("../../lib/invoke", () => ({
  registerFlush: vi.fn((f: () => Promise<void>) => {
    h.flushers.push(f);
    return () => {
      h.flushers = h.flushers.filter((x) => x !== f);
    };
  }),
  emitNotice: vi.fn(),
  call: vi.fn(),
  callSilent: vi.fn(),
}));
vi.mock("../../lib/aiSectionBridge", () => ({ registerSheetTarget: vi.fn(() => () => {}) }));
vi.mock("../../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({ updateSectionBody: h.updateSectionBody, activeNote: null }),
    setState: vi.fn(),
  },
}));

import { useSheetState } from "./useSheetState";
import { emptySheet, serializeSheet, type SheetDoc } from "../../lib/sheet/types";

/**
 * 가짜 편집(2026-10-18) — 시트도 같은 모양이었다: flush 기준선이 DB 원문(section.body_md)이라, 원문이 serializeSheet 의 정규형이
 * 아니면(Rust sheet_set_cells 가 쓴 키 정렬 JSON 등) 손대지 않은 시트가 flushAll(내보내기 모달·pagehide·전환)마다 다시 써졌고,
 * 읽지 못한 본문은 빈 시트로 덮였다. 기준선은 "칠한 문서의 직렬화"다(폰 MobileSheetEditor 의 sentRef 와 같다).
 */

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]))
      : v;

const CANONICAL = serializeSheet({ ...emptySheet(), cells: { A1: { raw: "x" } } } as SheetDoc);
const RUST_STYLE = JSON.stringify(sortKeys(JSON.parse(CANONICAL)));

const section = (body_md: string): Section => ({ id: "sheet-1", name: "Sheet", kind: "sheet", body_md, position: 0 });
const flushAll = async () => {
  for (const f of [...h.flushers]) await f();
};

describe("useSheetState — 손대지 않은 시트는 flush 가 다시 쓰지 않는다", () => {
  beforeEach(() => {
    h.updateSectionBody.mockClear();
    h.flushers = [];
  });

  it("정규형이 아닌(키가 정렬된) 시트 본문", async () => {
    expect(RUST_STYLE).not.toBe(CANONICAL);
    renderHook(() => useSheetState(section(RUST_STYLE)));
    await act(flushAll);
    expect(h.updateSectionBody).not.toHaveBeenCalled();
  });

  it("읽지 못한 본문을 빈 시트로 덮지 않는다", async () => {
    renderHook(() => useSheetState(section("not a sheet")));
    await act(flushAll);
    expect(h.updateSectionBody).not.toHaveBeenCalled();
  });

  it("진짜 편집은 저장된다", async () => {
    const { result } = renderHook(() => useSheetState(section(RUST_STYLE)));
    act(() => {
      result.current.setCell("B2", "7");
    });
    await act(flushAll);
    expect(h.updateSectionBody).toHaveBeenCalledTimes(1);
    expect(h.updateSectionBody.mock.calls[0][1]).toContain('"B2"');
  });
});
