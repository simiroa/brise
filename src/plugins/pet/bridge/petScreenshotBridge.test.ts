import { describe, it, expect, vi, beforeEach } from "vitest";

const callMock = vi.fn();
vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

const appendMock = vi.fn();
const createInboxMock = vi.fn();
vi.mock("../../../lib/noteActions", () => ({
  appendSectionWithBody: (...args: unknown[]) => appendMock(...args),
  createInboxMemo: (...args: unknown[]) => createInboxMock(...args),
}));

const listenMock = vi.fn();
const emitMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
  emit: (...args: unknown[]) => emitMock(...args),
}));

import {
  listenPetScreenshotBridge,
  routeCapture,
  screenshotBody,
  shotCardPayload,
} from "./petScreenshotBridge";

/** petClipboardBridge.test.ts 와 같은 모양 — listen() 에 등록된 핸들러를 이름으로 꺼내 쏜다. */
function fire(event: string, payload: unknown): Promise<void> {
  const entry = listenMock.mock.calls.find((c) => c[0] === event);
  if (!entry) throw new Error(`no handler registered for ${event}`);
  return (entry[1] as (e: { payload: unknown }) => void)({ payload }) as unknown as Promise<void>;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function shot(
  over: Partial<{
    title: string;
    name: string;
    data_base64: string;
    summary: string;
    ai_summary_status: "generated" | "disabled" | "unsupported_or_failed" | "timeout";
  }> = {},
) {
  return {
    title: "메모장 - 회의록.txt",
    name: "screenshot-20260809-142530.png",
    data_base64: "UE5H",
    summary: "",
    // 사유 문구가 본문에 섞이지 않는 기본값 — 요약 없음을 보고 싶은 테스트만 명시로 덮는다.
    ai_summary_status: "generated" as const,
    ...over,
  };
}

function reset() {
  callMock.mockReset();
  appendMock.mockReset();
  createInboxMock.mockReset();
  listenMock.mockReset();
  listenMock.mockResolvedValue(vi.fn());
  emitMock.mockReset();
  emitMock.mockResolvedValue(undefined);
}

describe("screenshotBody", () => {
  it("요약이 있으면 요약 + 출처 줄", () => {
    expect(screenshotBody("메모장", "회의 일정 정리.", "generated")).toBe(
      "회의 일정 정리.\n\n화면 캡처: 메모장",
    );
  });

  it("요약이 없으면(AI OFF/실패 강등) 출처 줄만 남는다 — 이미지가 본체다", () => {
    expect(screenshotBody("메모장", "   ")).toBe("화면 캡처: 메모장");
  });

  it("창 제목까지 없으면 자리를 채운다", () => {
    expect(screenshotBody("", "")).toBe("화면 캡처: 제목 없는 창");
  });

  /** 백엔드가 사유를 정확히 주는데 아무 데도 안 뜨면 "요약이 그냥 안 나옴"으로 보인다. */
  it("요약이 없는 사유를 출처 줄에 남긴다 — 노트 본문에도 카드에도 같은 한 줄", () => {
    expect(screenshotBody("메모장", "", "disabled")).toBe("화면 캡처: 메모장 · AI 요약 꺼짐");
    expect(screenshotBody("메모장", "", "timeout")).toBe("화면 캡처: 메모장 · AI 요약 시간 초과");
    expect(screenshotBody("메모장", "", "unsupported_or_failed")).toBe("화면 캡처: 메모장 · AI 요약 실패");
  });
});

describe("routeCapture", () => {
  beforeEach(reset);

  it("요약으로 유사 노트 1건을 병합 후보로 담는다", async () => {
    callMock.mockResolvedValue({ results: [{ id: "n1", title: "회의 노트", snippet: "" }] });

    const plan = await routeCapture(shot({ summary: "8월 회의 일정." }));

    expect(callMock).toHaveBeenCalledWith("search_notes", { query: "8월 회의 일정." });
    expect(plan).toMatchObject({
      body: "8월 회의 일정.\n\n화면 캡처: 메모장 - 회의록.txt",
      name: "screenshot-20260809-142530.png",
      dataBase64: "UE5H",
      targetNoteId: "n1",
      targetTitle: "회의 노트",
    });
  });

  it("요약이 없으면 창 제목으로 검색한다", async () => {
    callMock.mockResolvedValue({ results: [] });
    const plan = await routeCapture(shot());
    expect(callMock).toHaveBeenCalledWith("search_notes", { query: "메모장 - 회의록.txt" });
    expect(plan.targetNoteId).toBeNull();
  });

  it("AI 요약이 시간 초과돼도 상태를 보존하고 이미지는 계속 저장 계획에 남긴다", async () => {
    callMock.mockResolvedValue({ results: [] });

    const plan = await routeCapture(shot({ ai_summary_status: "timeout" }));

    expect(plan.aiSummaryStatus).toBe("timeout");
    expect(plan.dataBase64).toBe("UE5H");
    expect(plan.body).toBe("화면 캡처: 메모장 - 회의록.txt · AI 요약 시간 초과");
  });

  it("요약도 제목도 없으면 검색을 아예 돌리지 않는다", async () => {
    const plan = await routeCapture(shot({ title: "", summary: "" }));
    expect(callMock).not.toHaveBeenCalled();
    expect(plan.targetNoteId).toBeNull();
  });

  it("검색이 실패해도 저장은 막히지 않는다", async () => {
    callMock.mockRejectedValue(new Error("db"));
    const plan = await routeCapture(shot({ summary: "무언가" }));
    expect(plan.targetNoteId).toBeNull();
    expect(plan.dataBase64).toBe("UE5H");
  });

  it("긴 요약은 질의 300자 · 미리보기 180자로 잘라 보낸다", async () => {
    callMock.mockResolvedValue({ results: [] });
    const plan = await routeCapture(shot({ summary: "가".repeat(500) }));
    expect((callMock.mock.calls[0][1] as { query: string }).query).toHaveLength(300);
    expect(shotCardPayload(plan).preview).toHaveLength(180);
  });
});

describe("listenPetScreenshotBridge", () => {
  beforeEach(reset);

  /** 캡처 → 검색 → 카드까지만. 저장은 확인 뒤에만 일어난다. */
  function mockCaptureFlow(over?: Parameters<typeof shot>[0], hit?: { id: string; title: string }) {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "pet_screenshot_capture") return Promise.resolve(shot(over));
      if (cmd === "search_notes") {
        return Promise.resolve({ results: hit ? [{ ...hit, snippet: "" }] : [] });
      }
      return Promise.resolve({ ok: true });
    });
  }

  it("확인 카드만 띄운다 — 확인 전에는 아무것도 저장하지 않는다", async () => {
    mockCaptureFlow({ summary: "요약본" }, { id: "n1", title: "노트 A" });

    listenPetScreenshotBridge();
    await flush();
    await fire("pet-screenshot-capture", {});
    await flush();

    expect(appendMock).not.toHaveBeenCalled();
    expect(createInboxMock).not.toHaveBeenCalled();
    expect(callMock.mock.calls.some((c) => c[0] === "attachment_add_bytes")).toBe(false);
    const clip = callMock.mock.calls.find((c) => c[0] === "pet_bubble_clip");
    expect(JSON.parse((clip?.[1] as { payload: string }).payload)).toEqual({
      // kind:"shot" 이 수락 이벤트를 가른다 — 클립보드 카드와 섞이면 이중 저장이 된다.
      kind: "shot",
      preview: "요약본\n\n화면 캡처: 메모장 - 회의록.txt",
      target_title: "노트 A",
      is_link: false,
    });
    // 카드 표시 성공 직후 펫 창에 task-done 신호를 쏜다.
    expect(emitMock).toHaveBeenCalledWith("pet-signal", { kind: "task-done" });
  });

  it("append 를 고르면 제안된 노트에 섹션을 붙이고 이미지를 같은 노트에 첨부한다", async () => {
    mockCaptureFlow({ summary: "요약본" }, { id: "n1", title: "노트 A" });

    listenPetScreenshotBridge();
    await flush();
    await fire("pet-screenshot-capture", {});
    await flush();
    await fire("pet-screenshot-accept", { choice: "append" });
    await flush();

    expect(appendMock).toHaveBeenCalledWith("n1", "메모장 - 회의록.txt", "요약본\n\n화면 캡처: 메모장 - 회의록.txt");
    expect(createInboxMock).not.toHaveBeenCalled();
    expect(callMock).toHaveBeenCalledWith("attachment_add_bytes", {
      note_id: "n1",
      name: "screenshot-20260809-142530.png",
      data_base64: "UE5H",
    });
    // 수락 처리 시작에 work-start, 첨부 저장 성공 뒤 success.
    expect(emitMock).toHaveBeenCalledWith("pet-signal", { kind: "work-start" });
    expect(emitMock).toHaveBeenCalledWith("pet-signal", { kind: "success" });
  });

  it("AI OFF(요약 없음)이면 이미지만 인박스 메모로 가고, 본문에 사유가 남는다", async () => {
    mockCaptureFlow({ ai_summary_status: "disabled" });
    createInboxMock.mockResolvedValue({ note_id: "n2", title: "화면 캡처: 메모장 - 회의록.txt" });

    listenPetScreenshotBridge();
    await flush();
    await fire("pet-screenshot-capture", {});
    await flush();

    // 카드 미리보기(본문 앞 180자)에도 같은 사유가 보인다 — 예전엔 상태가 어디에도 안 떴다.
    const clip = callMock.mock.calls.find((c) => c[0] === "pet_bubble_clip");
    expect(JSON.parse((clip?.[1] as { payload: string }).payload).preview).toBe(
      "화면 캡처: 메모장 - 회의록.txt · AI 요약 꺼짐",
    );

    await fire("pet-screenshot-accept", { choice: "new" });
    await flush();

    expect(createInboxMock).toHaveBeenCalledWith(
      "화면 캡처: 메모장 - 회의록.txt · AI 요약 꺼짐",
      "메모장 - 회의록.txt",
    );
    expect(callMock).toHaveBeenCalledWith("attachment_add_bytes", {
      note_id: "n2",
      name: "screenshot-20260809-142530.png",
      data_base64: "UE5H",
    });
  });

  it("한 번 수락한 계획은 소비된다 — 같은 확인이 두 번 와도 두 번 저장하지 않는다", async () => {
    mockCaptureFlow();
    createInboxMock.mockResolvedValue({ note_id: "n2", title: "t" });

    listenPetScreenshotBridge();
    await flush();
    await fire("pet-screenshot-capture", {});
    await flush();
    await fire("pet-screenshot-accept", { choice: "new" });
    await flush();
    await fire("pet-screenshot-accept", { choice: "new" });
    await flush();

    expect(createInboxMock).toHaveBeenCalledTimes(1);
  });

  /** 캡처+비전 요약은 최대 75초라 그 사이 메뉴를 다시 누르기 쉽다. 두 캡처가 겹치면 화면에 뜬
   *  카드와 저장될 계획이 어긋날 수 있다(A 의 카드를 보고 수락했는데 B 가 저장됨). */
  it("진행 중인 캡처가 있으면 재요청을 버린다", async () => {
    let release: (v: unknown) => void = () => {};
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "pet_screenshot_capture") return new Promise((r) => (release = r));
      if (cmd === "search_notes") return Promise.resolve({ results: [] });
      return Promise.resolve({ ok: true });
    });

    listenPetScreenshotBridge();
    await flush();
    void fire("pet-screenshot-capture", {});
    await flush();
    void fire("pet-screenshot-capture", {});
    await flush();

    expect(callMock.mock.calls.filter((c) => c[0] === "pet_screenshot_capture")).toHaveLength(1);

    release(shot());
    await flush();
    expect(callMock.mock.calls.filter((c) => c[0] === "pet_bubble_clip")).toHaveLength(1);
  });

  /** 회귀: 노트 생성·섹션 추가가 끝난 뒤 첨부만 실패해도 "저장하지 못했어요"가 떴다 —
   *  노트는 멀쩡히 저장돼 있는데 사용자는 없는 줄 알고 다시 찍는다. */
  it("첨부만 실패하면 노트는 저장됐다고 사실대로 알린다", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "pet_screenshot_capture") return Promise.resolve(shot());
      if (cmd === "search_notes") return Promise.resolve({ results: [] });
      if (cmd === "attachment_add_bytes") return Promise.reject(new Error("disk"));
      return Promise.resolve({ ok: true });
    });
    createInboxMock.mockResolvedValue({ note_id: "n2", title: "노트 B" });

    listenPetScreenshotBridge();
    await flush();
    await fire("pet-screenshot-capture", {});
    await flush();
    await fire("pet-screenshot-accept", { choice: "new" });
    await flush();

    expect(callMock).toHaveBeenCalledWith("pet_bubble_notice", {
      text: "「노트 B」에 저장했지만 이미지 첨부에 실패했어요.",
      note_id: "n2",
    });
    expect(callMock).not.toHaveBeenCalledWith("pet_bubble_notice", {
      text: "저장하지 못했어요.",
      note_id: null,
    });
  });

  /** 캡처 실패(설정 OFF · 찍을 창 없음)는 침묵하지 않고 말풍선 한 줄로 끝난다. */
  it("캡처가 실패하면 카드 대신 알림을 띄우고 계획을 남기지 않는다", async () => {
    callMock.mockImplementation((cmd: string) =>
      cmd === "pet_screenshot_capture" ? Promise.reject(new Error("off")) : Promise.resolve({ ok: true }),
    );

    listenPetScreenshotBridge();
    await flush();
    await fire("pet-screenshot-capture", {});
    await flush();

    expect(callMock.mock.calls.some((c) => c[0] === "pet_bubble_clip")).toBe(false);
    expect(callMock).toHaveBeenCalledWith("pet_bubble_notice", {
      text: "화면을 저장하지 못했어요.",
      note_id: null,
    });
    expect(emitMock).toHaveBeenCalledWith("pet-signal", { kind: "failure" });

    // 남은 계획이 없으므로 뒤늦은 수락이 와도 아무것도 저장되지 않는다.
    await fire("pet-screenshot-accept", { choice: "new" });
    await flush();
    expect(createInboxMock).not.toHaveBeenCalled();
  });
});
