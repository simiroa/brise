// PLAN-2026-09-11 사이드바 W1 D5 — createNoteForRange 의 IPC 순서. replacePrimaryDate 자체는
// stores/notes.smoke.test.ts 가 이미 본다.
import { describe, it, expect, vi, beforeEach } from "vitest";

const callMock = vi.fn();
vi.mock("./invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

const loadTreeMock = vi.fn(async () => {});
const ensureInboxIdMock = vi.fn(async () => "inbox-ensured");
let inboxId: string | null = "inbox";
vi.mock("../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({ inboxId, ensureInboxId: ensureInboxIdMock, loadTree: loadTreeMock }),
  },
}));

const bumpMock = vi.fn();
vi.mock("./noteQuery", () => ({ bumpNoteQueryVersion: () => bumpMock() }));

import { createNoteForRange } from "./primaryDate";

const NOTE = { year: 2026, month: 9, day: 11, end_year: null, end_month: null, end_day: null };

function wireCalls() {
  callMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "note_create") return { note: { id: "n1", ...NOTE } };
    if (cmd === "note_get") return { note: { id: args.id, ...NOTE } };
    if (cmd === "note_dates_list") return { dates: [{ id: "d0", position: 0, ...NOTE }] };
    return undefined;
  });
}

const calls = () => callMock.mock.calls.map((c) => c[0] as string);

describe("createNoteForRange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inboxId = "inbox";
    wireCalls();
  });

  it("ⓐ 하루면 note_create 만 — 종료 트리플을 붙이지 않는다", async () => {
    const id = await createNoteForRange("2026-09-11", "2026-09-11", { title: "  x  " });
    expect(id).toBe("n1");
    expect(calls()).toEqual(["note_create"]);
    expect(callMock.mock.calls[0][1]).toEqual({
      folder_id: "inbox",
      title: "x",
      year: 2026,
      month: 9,
      day: 11,
    });
  });

  it("ⓑ 기간이면 note_create 뒤 replacePrimaryDate 로 end 트리플 (역순 입력도 정렬)", async () => {
    const id = await createNoteForRange("2026-09-13", "2026-09-11");
    expect(id).toBe("n1");
    expect(calls()).toEqual(["note_create", "note_get", "note_dates_list", "note_date_update", "note_get"]);
    const update = callMock.mock.calls.find((c) => c[0] === "note_date_update")![1] as Record<string, unknown>;
    expect(update).toMatchObject({ id: "d0", year: 2026, month: 9, day: 11, end_year: 2026, end_month: 9, end_day: 13 });
  });

  it("ⓒ 성공하면 loadTree 와 bumpNoteQueryVersion 을 부른다; inbox 없으면 ensureInboxId", async () => {
    inboxId = null;
    await createNoteForRange("2026-09-11", "2026-09-11");
    expect(ensureInboxIdMock).toHaveBeenCalledTimes(1);
    expect(callMock.mock.calls[0][1]).toMatchObject({ folder_id: "inbox-ensured" });
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
    expect(bumpMock).toHaveBeenCalledTimes(1);
  });

  it("ⓓ note_create 실패면 null — replacePrimaryDate·loadTree·bump 는 안 부른다, throw 도 없다", async () => {
    callMock.mockRejectedValueOnce(new Error("boom"));
    await expect(createNoteForRange("2026-09-11", "2026-09-13")).resolves.toBeNull();
    expect(calls()).toEqual(["note_create"]);
    expect(loadTreeMock).not.toHaveBeenCalled();
    expect(bumpMock).not.toHaveBeenCalled();
  });

  it("잘못된 ISO 는 IPC 없이 null", async () => {
    await expect(createNoteForRange("nope", "2026-09-11")).resolves.toBeNull();
    expect(callMock).not.toHaveBeenCalled();
  });
});
