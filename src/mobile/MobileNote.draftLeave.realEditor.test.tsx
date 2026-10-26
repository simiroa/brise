/**
 * 입력 화면 **초안**(아직 노트가 아닌 상태)을 서버가 안 될 때 떠나는 두 길을 진짜 MobileNote + 진짜 Tiptap + 진짜 스토어 액션으로 확인한다.
 * (가짜는 call 하나와 ensureMaterialized — 서버가 죽었다/살아났다를 흉내 내는 곳이 그 둘뿐이다.)
 *
 *  1) 가져온 초안의 저장하기가 실패한 뒤 나가기 — 가져온 본문은 쓰기를 한 번도 시도하지 않아 flush 가 "이미 같음" 으로 건너뛰므로,
 *     MobileApp 이 `markDraftUnsent` 로 알려 주지 않으면 V5 관문(저장 못 한 글 → 막고 보관)을 못 지나고 초안이 경고 없이 버려졌다.
 *  2) 사용자가 친 글이 저장 실패한 초안에서 [그래도 나가기] — 보관본이 유일한 사본인데 초안이 그대로 남으면 다음 입력 화면이 같은 글을
 *     에디터에 다시 칠하고(newNote 는 열린 초안을 안 바꾼다) 복구 배너도 같은 글로 떠서 [새 섹션으로 넣기]가 글을 두 번 넣었다.
 *
 * 하네스는 mobileImport.realEditor.test.tsx 를 따른다(가짜 타이머 + 한 인스턴스). 가짜 타이머 아래에서는 testing-library 의
 * waitFor/findBy 가 멈추므로(vitest 타이머를 모른다) 전부 `settle()` 로 시간을 밀고 동기 쿼리로 확인한다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { createRef } from "react";
import type { Editor } from "@tiptap/core";

const hoisted = vi.hoisted(() => ({ emitNoticeMock: vi.fn() }));
const callMock = vi.fn(async (cmd: string, args?: any) => {
  if (cmd === "workspace_status_list") return { statuses: [] };
  if (cmd === "section_create_with_body") return { id: "rec1", name: args.name, body_md: args.body_md, position: 1, kind: args.kind };
  return {};
});
vi.mock("../lib/invoke", () => ({
  call: (...a: unknown[]) => callMock(a[0] as string, a[1]),
  callSilent: vi.fn(async (cmd: string) => (cmd === "workspace_status_list" ? { statuses: [] } : { counts: {} })),
  emitNotice: hoisted.emitNoticeMock,
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(() => () => {}),
}));
vi.mock("../lib/noteSummaries", () => ({ fetchNoteSummary: vi.fn() }));
vi.mock("../lib/regionRegistry", () => ({ loadRegionRegistry: vi.fn(async () => []) }));
vi.mock("../components/home/useNoteWaypoints", () => ({ useNoteWaypoints: () => [] }));
vi.mock("../lib/tauriListen", () => ({ listenMany: () => () => {} }));
vi.mock("../components/diagram/DiagramSection", () => ({ DiagramSection: () => null }));
vi.mock("./MobileSheetEditor", () => ({ MobileSheetEditor: () => null }));

import { t } from "../i18n/t";
import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { useAiStore } from "../stores/ai";
import { usePresetsStore } from "../stores/presets";
import { MobileNote, type MobileNoteHandle } from "./MobileNote";
import { canonicalImportBody } from "./mobileImportBody";
import { fillCaptureDraft } from "./mobileImportSession";
import { stashesForNote } from "./unsavedStash";

const liveEditor = (): Editor => (document.querySelector(".ProseMirror") as any).editor;
const settle = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

function draft() {
  return {
    note: {
      id: "__draft__",
      folder_id: "inbox1",
      title: "Untitled Note",
      year: 2026,
      month: 10,
      day: 7,
      is_favorite: false,
      exported_at: null,
      has_image: false,
      tag_names: [],
      region: null,
      status: null,
      icon: null,
      lat: null,
      lng: null,
      created_at: "",
      updated_at: "",
    },
    sections: [{ id: "draft_sec", name: "Overview", body_md: "", position: 0, kind: "text" }],
    sources: [],
    attachments: [],
  } as any;
}

// 서버가 죽어 있는 동안 ensureMaterialized 는 던진다(call 이 토스트하고 다시 던지는 것과 같다). 살아나면 초안을 실제 노트로 바꾼다.
let serverUp = false;
const ensureMock = vi.fn();
function installEnsure() {
  ensureMock.mockReset().mockImplementation(async () => {
    if (!serverUp) throw { code: "IO", message: "server down" };
    const n = useNotesStore.getState().activeNote as any;
    useNotesStore.setState({
      activeNote: { ...n, note: { ...n.note, id: "real1" }, sections: n.sections.map((s: any) => ({ ...s, id: "sec1" })) },
      activeDraft: false,
    } as any);
    return "real1";
  });
  useNotesStore.setState({ ensureMaterialized: ensureMock } as any);
}

/** 실패 배너의 [그래도 나가기] — 나가기를 막은 상태(showLeaveBlocked)에서 누른다. */
async function leaveAnyway(ref: { current: MobileNoteHandle | null }) {
  const proceed = vi.fn();
  act(() => ref.current!.showLeaveBlocked(proceed));
  await act(async () => {
    fireEvent.click(screen.getByText(t("mobile.save_leave_anyway")));
  });
  await settle();
  return proceed;
}

const sectionWrites = () => callMock.mock.calls.filter((c) => c[0] === "section_update");
const createCalls = () => callMock.mock.calls.filter((c) => c[0] === "section_create_with_body");

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  callMock.mockClear();
  hoisted.emitNoticeMock.mockClear();
  serverUp = false;
  useSettingsStore.setState({ aiEnabled: false, uiLang: "en", dateNudgeEnabled: false } as any);
  useAiStore.setState({ aiReachable: false, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
  usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
  useNotesStore.setState({ activeNote: draft(), activeDraft: true, activeBodyEmpty: true, savedState: "saved", saveConflict: null } as any);
  installEnsure();
});
afterEach(() => {
  vi.useRealTimers();
  useNotesStore.setState({ activeNote: null, activeDraft: false } as any);
});

function mount() {
  const ref = createRef<MobileNoteHandle>();
  const view = render(<MobileNote ref={ref} capture onBack={() => {}} onOpenNote={() => {}} />);
  return { ref, view };
}

describe("가져온 초안의 저장하기가 실패한 뒤 나가기 (V5 관문)", () => {
  const TEXT = "오늘의 메모\n두 번째 줄";

  async function mountImported() {
    const c = canonicalImportBody(TEXT);
    expect(fillCaptureDraft(c.bodyMd, "재미있는 기사")).toBe(true);
    const m = mount();
    await settle();
    return m;
  }

  it("대조: 표시가 없으면 손대지 않은 가져온 초안은 flush 가 건너뛴다 — 노트 만들기를 시도하지도, 나가기를 막지도 않는다(버그의 모양)", async () => {
    const { ref } = await mountImported();
    await act(async () => {
      await ref.current!.flushAndMeasure();
    });
    expect(ensureMock).not.toHaveBeenCalled();
    expect(ref.current!.hasUnsavedFailure()).toBe(false);
  });

  it("markDraftUnsent 뒤: 다음 flush 가 노트 만들기를 다시 시도하고, 또 실패하면 나가기를 막고 배너를 띄운다", async () => {
    const { ref } = await mountImported();
    act(() => ref.current!.markDraftUnsent());
    await act(async () => {
      await ref.current!.flushAndMeasure(); // 뒤로·탭·하드웨어 뒤로가 모두 부르는 flush
    });
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(ref.current!.hasUnsavedFailure()).toBe(true);
    expect(screen.getByTestId("mobile-save-failed")).toBeTruthy();
  });

  it("[그래도 나가기]: 가져온 글이 이 기기에 보관되고(제목은 복구 섹션 이름으로) 초안이 버려지며, 나가는 길의 flush 가 사라진 섹션에 쓰지 않는다", async () => {
    const { ref, view } = await mountImported();
    act(() => ref.current!.markDraftUnsent());
    await act(async () => {
      await ref.current!.flushAndMeasure();
    });
    const proceed = await leaveAnyway(ref);
    expect(proceed).toHaveBeenCalledTimes(1);

    const kept = stashesForNote("__draft__");
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ kind: "text", sectionName: "재미있는 기사" });
    expect(kept[0].bodyMd).toContain("오늘의 메모");
    expect(kept[0].bodyMd).toContain("두 번째 줄");
    expect(hoisted.emitNoticeMock).toHaveBeenCalledWith(t("mobile.save_stashed"));
    expect(useNotesStore.getState().activeDraft).toBe(false);
    expect(useNotesStore.getState().activeNote).toBeNull();

    // 나가는 길: navigate 의 flushAll·언마운트 정리·남은 타이머 — 사라진 초안의 섹션 id 로 section_update 가 나가면 오류 토스트가 뜬다.
    await act(async () => {
      await ref.current!.flushAndMeasure();
    });
    view.unmount();
    await settle(2000);
    expect(sectionWrites()).toEqual([]);
  });

  it("서버가 돌아와 있으면 같은 flush 가 노트를 만든다(사용자가 이미 저장하기를 눌렀던 뜻) — 막지 않는다", async () => {
    const { ref } = await mountImported();
    act(() => ref.current!.markDraftUnsent());
    serverUp = true;
    await act(async () => {
      await ref.current!.flushAndMeasure();
    });
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(useNotesStore.getState().activeDraft).toBe(false);
    expect(ref.current!.hasUnsavedFailure()).toBe(false);
  });

  it("초안이 아니면(이미 노트가 된 뒤 사진만 실패) 표시하지 않는다 — flush 는 건너뛴다", async () => {
    const { ref } = await mountImported();
    useNotesStore.setState({ activeDraft: false } as any);
    act(() => ref.current!.markDraftUnsent());
    await act(async () => {
      await ref.current!.flushAndMeasure();
    });
    expect(ensureMock).not.toHaveBeenCalled();
    expect(ref.current!.hasUnsavedFailure()).toBe(false);
  });
});

describe("저장 실패한 입력 초안에서 [그래도 나가기] → 다시 입력 화면 (같은 글이 두 번 들어가지 않는다)", () => {
  async function typeAndFail() {
    const m = mount();
    await settle();
    act(() => {
      liveEditor().commands.insertContent("typed text");
    });
    await settle(800); // 자동 저장 → 초안 쓰기 → ensureMaterialized 실패
    expect(ensureMock).toHaveBeenCalled();
    expect(m.ref.current!.hasUnsavedFailure()).toBe(true);
    return m;
  }

  it("글은 보관본에만 남고 초안은 버려진다. 다음 입력 화면은 비어 있고 복구 배너가 한 번 뜨며, 넣으면 글이 한 번만 들어간다", async () => {
    const { ref, view } = await typeAndFail();
    const proceed = await leaveAnyway(ref);
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(stashesForNote("__draft__").map((s) => s.bodyMd)).toEqual(["typed text"]);
    expect(useNotesStore.getState().activeDraft).toBe(false);

    // 나가는 길의 flush·언마운트 정리가 사라진 초안의 섹션에 쓰지 않는다
    view.unmount();
    await settle(2000);
    expect(sectionWrites()).toEqual([]);

    // 다시 입력 화면 — enterCapture 가 하는 newNote(). 예전엔 열린 초안이 그대로라 early-return 해서 옛 글이 에디터에 되살아났다.
    await act(async () => {
      await useNotesStore.getState().newNote();
    });
    installEnsure();
    serverUp = true;
    const second = mount();
    await settle();
    expect(liveEditor().getText()).toBe(""); // 에디터에는 글이 없다
    expect(screen.getAllByTestId("mobile-stash-recovery")).toHaveLength(1);
    expect(screen.getByTestId("mobile-stash-recovery").textContent).toContain(t("mobile.stash_found"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("mobile-stash-insert"));
    });
    await settle();
    expect(createCalls()).toHaveLength(1);
    expect(createCalls()[0][1]).toMatchObject({ note_id: "real1", body_md: "typed text" });
    expect(screen.queryByTestId("mobile-stash-recovery")).toBeNull();
    expect(stashesForNote("__draft__")).toEqual([]);
    // 첫 섹션(기본 본문)에는 글이 없다 — 복구 섹션에만 한 번 들어갔다
    expect(useNotesStore.getState().activeNote?.sections[0].body_md).toBe("");
    second.view.unmount();
  });

  it("보관에 실패하고 클립보드만 성공했을 때는 초안을 남긴다(그쪽이 더 안전한 사본이다)", async () => {
    const { ref } = await typeAndFail();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    try {
      const proceed = await leaveAnyway(ref);
      expect(proceed).toHaveBeenCalledTimes(1);
      expect(stashesForNote("__draft__")).toEqual([]);
      expect(useNotesStore.getState().activeDraft).toBe(true);
      expect(useNotesStore.getState().activeNote?.sections[0].body_md).toBe("typed text");
    } finally {
      setItem.mockRestore();
      delete (navigator as any).clipboard;
    }
  });
});
