/**
 * 오너 규칙 "받은 내용은 사용자가 저장해야 노트가 된다"를 **진짜 MobileNote + 진짜 Tiptap + 진짜 스토어 액션**으로 확인한다.
 * MobileApp.import.test.tsx 는 MobileNote 를 스텁으로 바꾸고 ensureMaterialized 를 가짜로 둬서 출구 흐름만 본다 — 그 스텁이
 * 가리는 것(노트 로드 효과가 초안을 칠하는지, 라이브 에디터의 flush 가 칠한 문자열과 다르게 직렬화해 쓰기를 내는지)이 여기 대상이다.
 *
 * 하네스는 MobileNote.realEditor.test.tsx 를 따른다(가짜 타이머 + 한 인스턴스).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { createRef } from "react";
import type { Editor } from "@tiptap/core";

const callMock = vi.fn(async (cmd: string) => {
  if (cmd === "workspace_status_list") return { statuses: [] };
  return {};
});
vi.mock("../lib/invoke", () => ({
  call: (...a: unknown[]) => callMock(a[0] as string),
  callSilent: vi.fn(async (cmd: string) => (cmd === "workspace_status_list" ? { statuses: [] } : { counts: {} })),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(() => () => {}),
}));
vi.mock("../lib/noteSummaries", () => ({ fetchNoteSummary: vi.fn() }));
vi.mock("../lib/regionRegistry", () => ({ loadRegionRegistry: vi.fn(async () => []) }));
vi.mock("../components/home/useNoteWaypoints", () => ({ useNoteWaypoints: () => [] }));
vi.mock("../lib/tauriListen", () => ({ listenMany: () => () => {} }));
vi.mock("../components/diagram/DiagramSection", () => ({ DiagramSection: () => null }));
vi.mock("./MobileSheetEditor", () => ({ MobileSheetEditor: () => null }));

import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { useAiStore } from "../stores/ai";
import { usePresetsStore } from "../stores/presets";
import { MobileNote, type MobileNoteHandle } from "./MobileNote";
import { canonicalImportBody } from "./mobileImportBody";
import { fillCaptureDraft } from "./mobileImportSession";

const liveEditor = (): Editor => (document.querySelector(".ProseMirror") as any).editor;
const settle = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

function draft() {
  return {
    note: {
      id: "__draft__",
      folder_id: "",
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

const writes = () => callMock.mock.calls.map((c) => c[0]).filter((c) => c === "note_create" || c === "section_update" || c === "note_update");

beforeEach(() => {
  vi.useFakeTimers();
  callMock.mockClear();
  useSettingsStore.setState({ aiEnabled: false, uiLang: "en", dateNudgeEnabled: false } as any);
  useAiStore.setState({ aiReachable: false, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
  usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
  // 스토어 액션은 진짜다(updateSectionBody → ensureMaterialized → call("note_create")). 가짜는 call 하나뿐.
  useNotesStore.setState({ activeNote: draft(), activeDraft: true, activeBodyEmpty: true, savedState: "saved" } as any);
});
afterEach(() => {
  vi.useRealTimers();
  useNotesStore.setState({ activeNote: null, activeDraft: false } as any);
});

async function mountImported(text: string, title: string | null) {
  const c = canonicalImportBody(text);
  expect(fillCaptureDraft(c.bodyMd, title)).toBe(true);
  const ref = createRef<MobileNoteHandle>();
  const view = render(<MobileNote ref={ref} capture onBack={() => {}} onOpenNote={() => {}} />);
  await settle();
  return { c, ref, view };
}

describe("가져온 초안 × 진짜 MobileNote — 손대지 않으면 노트가 만들어지지 않는다", () => {
  const STABLE = [
    ["일반 글", "오늘의 메모\n두 번째 줄"],
    ["URL 하나(Chrome 공유)", "https://example.com/post/42"],
    ["제목 + URL", "재미있는 기사\nhttps://example.com/post/42"],
    ["별표·밑줄·꺾쇠", "*foo* snake_case 5 < 6 & 7"],
    // 에디터가 스스로 링크로 읽는 글 — 날것으로 칠하면 첫 flush 가 `[..](mailto:..)` 로 다시 써 노트가 생겼다(고정점 쫓기로 해결).
    ["이메일 주소", "contact foo@example.com"],
    ["한글 문장 속 이메일", "문의는 홍길동 foo@example.com 으로 주세요"],
    ["밑줄이 든 이메일", "mail me at foo_bar@example.com"],
    ["www 주소", "www.example.com/page"],
    ["이메일 + www 한 줄", "a@b.co and www.x.org"],
    ["유튜브 URL(`_`·`&`)", "https://youtu.be/abc_DEF?si=Zx_9&t=10s"],
    ["UTM URL", "https://x.com/?utm_source=x&utm_medium=y"],
  ] as const;

  for (const [name, text] of STABLE) {
    it(`${name}: 칠해지고, flush·타이머·언마운트에도 쓰기(note_create/section_update)가 0 이다`, async () => {
      const { c, ref, view } = await mountImported(text, "제목");
      expect(c.stable).toBe(true);
      // 노트 로드 효과가 스토어의 초안을 에디터에 칠했다
      expect(liveEditor().getText().replace(/\n+/g, "\n")).toBe(text.replace(/\n+/g, "\n"));
      expect(document.querySelector(".mobile-readonly-banner")).toBeNull(); // 편집 가능하게 열렸다
      // 나가기 경로의 flush(뒤로·탭·하드웨어 뒤로가 모두 부른다) + 디바운스 타이머 + 언마운트 정리
      await ref.current!.flushAndMeasure();
      await settle(2000);
      view.unmount();
      await settle(2000);
      expect(writes()).toEqual([]);
      const s = useNotesStore.getState();
      expect(s.activeDraft).toBe(true);
      expect(s.activeNote?.note.id).toBe("__draft__");
    });
  }

  it("사용자가 한 글자라도 치면 그때 자동 저장이 노트를 만든다(가져온 본문 전체와 함께)", async () => {
    await mountImported("오늘의 메모", "제목");
    expect(writes()).toEqual([]);
    act(() => {
      liveEditor().commands.insertContentAt(liveEditor().state.doc.content.size, " 추가");
    });
    await settle(800);
    // 만들어지는 노트의 제목·본문은 ensureMaterialized 가 초안에서 옮긴다(note_create 응답 모양은 이 하네스가 가짜라 보지 않는다).
    expect(writes()).toContain("note_create");
  });
});

describe("고정점이 없는 글(URL 안의 백틱)", () => {
  // canonicalImportBody 가 고정점을 못 찾는 글은 stable=false 로 남는다 — 칠한 문자열과 다시 직렬화한 문자열이 다르다.
  // 예전엔 그래서 첫 flush 가 쓰기를 내 오너 규칙이 이 글에만 안 지켜졌다(알려진 한계로 못 박아 두었던 테스트). 2026-10-18 부터
  // 저장 경로는 "칠한 문서에서 바뀐 게 없나"로 본다(useSectionEditor.unchangedSinceLoad) — 고정점이 없어도 손대지 않은 초안은 쓰지 않는다.
  it("손대지 않은 초안은 flush 해도 노트가 만들어지지 않는다(stable=false 여도)", async () => {
    const text = "https://x.com/a`b";
    const { c, ref, view } = await mountImported(text, null);
    expect(c.stable).toBe(false);
    await ref.current!.flushAndMeasure();
    await settle(2000);
    view.unmount();
    await settle(2000);
    expect(writes()).toEqual([]);
    expect(useNotesStore.getState().activeDraft).toBe(true);
  });

  it("나가며 노트로 만든 뒤(초안 → 실노트 id 교체)의 flush 도 본문을 다시 쓰지 않는다", async () => {
    const text = "https://x.com/a`b";
    const real = draft();
    real.note.id = "real-note";
    real.note.folder_id = "inbox1";
    real.sections = [{ id: "real-sec", name: "Overview", body_md: "", position: 0, kind: "text" }];
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "workspace_status_list") return { statuses: [] };
      if (cmd === "note_create") return real;
      if (cmd === "section_update") return { section_updated_at: "t1", updated_at: "t1" };
      return {};
    });
    useNotesStore.setState({ ensureInboxId: async () => "inbox1", loadTree: vi.fn(async () => {}) } as any);
    const { ref } = await mountImported(text, null);
    await ref.current!.flushAndMeasure();
    // MobileApp.leaveCapture 의 settle 이 하는 것 — 초안 본문(가져온 원문)으로 노트를 만든다.
    await act(async () => {
      await useNotesStore.getState().ensureMaterialized();
    });
    await settle();
    expect(useNotesStore.getState().activeNote?.note.id).toBe("real-note");
    const before = writes().filter((c) => c === "section_update").length; // 만들 때의 본문 쓰기 1번
    await ref.current!.flushAndMeasure();
    await settle(2000);
    expect(writes().filter((c) => c === "section_update").length).toBe(before);
  });
});
