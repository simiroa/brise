import { describe, it, expect, vi, beforeEach } from "vitest";

const callMock = vi.fn();
const flushAllMock = vi.fn(async () => {});
const reloadActiveMock = vi.fn(async () => {});

vi.mock("./invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: () => flushAllMock(),
}));

vi.mock("../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({ reloadActive: reloadActiveMock }),
  },
}));

const listenMock = vi.fn();
const emitMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
  emit: (...args: unknown[]) => emitMock(...args),
}));

import { handleActivityRestoreSnapshot, listenActivityWindowBridge } from "./activityWindowBridge";

function fire(event: string, payload: unknown): Promise<void> {
  const entry = listenMock.mock.calls.find((c) => c[0] === event);
  if (!entry) throw new Error(`no handler registered for ${event}`);
  return (entry[1] as (e: { payload: unknown }) => void)({ payload }) as unknown as Promise<void>;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("activityWindowBridge", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue({});
    flushAllMock.mockClear();
    reloadActiveMock.mockClear();
    listenMock.mockReset();
    listenMock.mockResolvedValue(vi.fn());
    emitMock.mockClear();
  });

  it("flushAll 다음에 note_snapshot_restore 다음에 reloadActive", async () => {
    const order: string[] = [];
    flushAllMock.mockImplementation(async () => {
      order.push("flush");
    });
    callMock.mockImplementation(async (cmd: string) => {
      order.push(cmd);
      return {};
    });
    reloadActiveMock.mockImplementation(async () => {
      order.push("reload");
    });

    await handleActivityRestoreSnapshot({ id: "s1" });

    // 분리 창이 없으면(section_window_list 가 빈 목록) 스냅샷 조회·창 닫기 없이 바로 복원한다.
    expect(order).toEqual(["flush", "section_window_list", "note_snapshot_restore", "reload"]);
    expect(callMock).toHaveBeenCalledWith("note_snapshot_restore", { id: "s1" });
  });

  // 분리 창이 복원 전 본문을 들고 있다가 다음 자동저장으로 복원을 덮던 결함 — 복원이 다시 쓸 섹션의
  // 분리 창만 **먼저** 닫고(저장·파괴를 기다리는 section_window_close) 그 뒤에 복원한다.
  it("closes detached windows of restored sections before note_snapshot_restore", async () => {
    const order: string[] = [];
    callMock.mockImplementation(async (cmd: string, args?: { section_id?: string }) => {
      order.push(args?.section_id ? `${cmd}:${args.section_id}` : cmd);
      if (cmd === "section_window_list") return { section_ids: ["a", "x"] };
      if (cmd === "note_snapshot_get") return { id: "s9", note_id: "n", taken_at: "", sections: [{ section_id: "a" }, { section_id: "b" }] };
      if (cmd === "section_window_close") return { closed: true };
      return {};
    });

    await handleActivityRestoreSnapshot({ id: "s9" });

    expect(order).toEqual([
      "section_window_list",
      "note_snapshot_get",
      "section_window_close:a", // "x" 는 다른 노트의 분리 창 — 건드리지 않는다
      "note_snapshot_restore",
    ]);
  });

  it("activity-restore-snapshot 을 들으면 복원 흐름을 탄다", async () => {
    listenActivityWindowBridge();
    await flush();
    await fire("activity-restore-snapshot", { id: "s2" });
    await flush();

    expect(flushAllMock).toHaveBeenCalled();
    expect(callMock).toHaveBeenCalledWith("note_snapshot_restore", { id: "s2" });
    expect(reloadActiveMock).toHaveBeenCalled();
  });

  // FINDING 2: 결과를 활동 창에 되돌려줘야 "복원 중" 표시가 실제 완료까지 유지되고, 실패가
  // 가려진 본 창이 아니라 활동 창 자체에 보인다.
  it("복원 성공 시 activity-restore-snapshot-result 를 ok:true 로 emit 한다", async () => {
    listenActivityWindowBridge();
    await flush();
    await fire("activity-restore-snapshot", { id: "s3" });
    await flush();

    expect(emitMock).toHaveBeenCalledWith("activity-restore-snapshot-result", { id: "s3", ok: true });
  });

  it("note_snapshot_restore 실패 시 activity-restore-snapshot-result 를 ok:false + error 로 emit 한다", async () => {
    listenActivityWindowBridge();
    await flush();
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_snapshot_restore") throw { code: "NOT_FOUND", message: "snapshot gone" };
      return {};
    });

    await fire("activity-restore-snapshot", { id: "s4" });
    await flush();

    expect(emitMock).toHaveBeenCalledWith("activity-restore-snapshot-result", {
      id: "s4",
      ok: false,
      error: "snapshot gone",
    });
    expect(reloadActiveMock).not.toHaveBeenCalled();
  });
});
