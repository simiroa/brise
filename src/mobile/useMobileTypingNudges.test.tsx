import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { createMobileSchemaExtensions } from "./mobileEditorExtensions";
import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { loadRegionRegistry } from "../lib/regionRegistry";
import { useMobileTypingNudges, NUDGE_DEBOUNCE_MS } from "./useMobileTypingNudges";

vi.mock("../lib/regionRegistry", () => ({ loadRegionRegistry: vi.fn() }));
vi.mock("../components/home/useNoteWaypoints", () => ({ useNoteWaypoints: () => [] }));
vi.mock("../lib/invoke", () => ({
  call: vi.fn(),
  callSilent: vi.fn(async () => ({ counts: {} })),
  emitNotice: vi.fn(),
  flushAll: vi.fn(),
  registerFlush: vi.fn(() => () => {}),
}));

let editor: Editor;

/** 문단을 통째로 바꾸고 커서를 끝에 둔다 — 타이핑 한 번(update + selectionUpdate). */
function typeParagraph(text: string) {
  act(() => {
    editor.commands.setContent(`<p>${text}</p>`, { emitUpdate: true });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  });
}
const flushTimers = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(loadRegionRegistry).mockResolvedValue([{ name: "경주", lat: 35.8, lng: 129.2 }]);
  useNotesStore.setState({ activeNote: { note: { id: "n1", region: null } } as never, tagCounts: { 회사: 3, 회의: 1, 개인: 2 } });
  useSettingsStore.setState({
    uiLang: "ko",
    dateNudgeEnabled: true,
    dateNudgeAuto: false,
    regionNudgeEnabled: true,
    regionNudgeStrict: false,
  } as never);
  editor = new Editor({ extensions: createMobileSchemaExtensions(), content: "<p></p>" });
});
afterEach(() => {
  editor.destroy();
  vi.useRealTimers();
});

describe("useMobileTypingNudges", () => {
  it("날짜: 700ms 디바운스 뒤에 후보가 나온다(커서가 매치 끝을 지난 상태)", async () => {
    const { result } = renderHook(() => useMobileTypingNudges(editor, "n1", true));
    typeParagraph("내일 오후 3시 치과");
    await flushTimers(NUDGE_DEBOUNCE_MS - 100);
    expect(result.current.state.date).toBeUndefined();
    await flushTimers(200);
    expect(result.current.state.date?.payload.start_time).toBe("15:00");
    expect(result.current.state.date?.label).toContain("15:00");
  });

  it("지역: 등록된 지역 이름을 치면 첫 매치가 나온다", async () => {
    const { result } = renderHook(() => useMobileTypingNudges(editor, "n1", true));
    typeParagraph("주말에 경주 여행");
    await flushTimers(NUDGE_DEBOUNCE_MS + 50);
    expect(result.current.state.region?.name).toBe("경주");
  });

  it("지역: region_nudge_enabled=false 면 감지하지 않는다", async () => {
    useSettingsStore.setState({ regionNudgeEnabled: false } as never);
    const { result } = renderHook(() => useMobileTypingNudges(editor, "n1", true));
    typeParagraph("주말에 경주 여행");
    await flushTimers(NUDGE_DEBOUNCE_MS + 50);
    expect(result.current.state.region).toBeUndefined();
  });

  it("링크: 공백으로 구분된 http URL 토큰을 낸다", async () => {
    const { result } = renderHook(() => useMobileTypingNudges(editor, "n1", true));
    typeParagraph("참고 https://example.com/post/1");
    await flushTimers(NUDGE_DEBOUNCE_MS + 50);
    expect(result.current.state.url).toBe("https://example.com/post/1");
  });

  it("#태그: 디바운스 없이 즉시, 빈도순 일치 + 정확히 일치가 없으면 새 태그", async () => {
    const { result } = renderHook(() => useMobileTypingNudges(editor, "n1", true));
    typeParagraph("메모 #회");
    await flushTimers(0);
    const tag = result.current.state.tag!;
    expect(tag.items.map((i) => i.name)).toEqual(["회사", "회의", "회"]);
    expect(tag.items[2].isNew).toBe(true);
    expect(tag.query.query).toBe("회");
    // 공백으로 토큰이 끝나면 칩이 사라진다
    typeParagraph("메모 #회사 다");
    await flushTimers(0);
    expect(result.current.state.tag).toBeUndefined();
  });

  it("IME 조합 중에는 건너뛰고, 조합이 끝나면 다시 본다", async () => {
    const { result } = renderHook(() => useMobileTypingNudges(editor, "n1", true));
    let composing = true;
    Object.defineProperty(editor.view, "composing", { get: () => composing, configurable: true });
    typeParagraph("내일 오후 3시 치과 #회");
    await flushTimers(NUDGE_DEBOUNCE_MS * 3);
    expect(result.current.state.date).toBeUndefined();
    expect(result.current.state.tag).toBeUndefined();
    composing = false;
    act(() => {
      editor.view.dom.dispatchEvent(new Event("compositionend"));
    });
    await flushTimers(NUDGE_DEBOUNCE_MS + 50);
    expect(result.current.state.tag).toBeDefined();
  });

  it("무시 기억: 같은 텍스트는 다시 안 뜨고, 노트를 바꾸면 초기화된다", async () => {
    const { result, rerender } = renderHook(({ id }) => useMobileTypingNudges(editor, id, true), {
      initialProps: { id: "n1" },
    });
    typeParagraph("주말에 경주 여행");
    await flushTimers(NUDGE_DEBOUNCE_MS + 50);
    expect(result.current.state.region).toBeDefined();
    act(() => result.current.dismiss("region", result.current.state));
    expect(result.current.state.region).toBeUndefined();
    typeParagraph("주말에 경주 여행!");
    await flushTimers(NUDGE_DEBOUNCE_MS + 50);
    expect(result.current.state.region).toBeUndefined();
    // 노트 전환 — 무시 기억이 비워진다
    useNotesStore.setState({ activeNote: { note: { id: "n2", region: null } } as never });
    rerender({ id: "n2" });
    typeParagraph("주말에 경주 여행");
    await flushTimers(NUDGE_DEBOUNCE_MS + 50);
    expect(result.current.state.region?.name).toBe("경주");
  });

  // 문장 위 말풍선(MobileNudgeBubble)의 앵커 — 지역은 자기 paraStart 가 없어서 스캔이 문단 시작을 따로 남긴다.
  it("restParaStart: 날짜·지역이 감지된 문단의 시작 위치를 남긴다(감지 시점의 문단 — 이후 커서 위치가 아니다)", async () => {
    const { result } = renderHook(() => useMobileTypingNudges(editor, "n1", true));
    act(() => {
      editor.commands.setContent("<p>앞 문단</p><p>주말에 경주 여행</p>", { emitUpdate: true });
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    });
    const paraStart = editor.state.selection.$from.start();
    expect(paraStart).toBeGreaterThan(1); // 두 번째 문단이다
    await flushTimers(NUDGE_DEBOUNCE_MS + 50);
    expect(result.current.state.region?.name).toBe("경주");
    expect(result.current.state.restParaStart).toBe(paraStart);
    // 감지 뒤 커서가 첫 문단으로 가도(selectionUpdate 는 지역 감지를 다시 돌리지 않는다) 앵커는 감지한 문단 그대로다.
    act(() => {
      editor.commands.setTextSelection(2);
    });
    await flushTimers(NUDGE_DEBOUNCE_MS + 50);
    expect(result.current.state.restParaStart).toBe(paraStart);
  });

  it("restParaStart: 날짜의 paraStart 와 같은 문단이고, 링크·#태그만 있으면 세우지 않는다", async () => {
    const { result } = renderHook(() => useMobileTypingNudges(editor, "n1", true));
    typeParagraph("내일 오후 3시 치과");
    await flushTimers(NUDGE_DEBOUNCE_MS + 50);
    expect(result.current.state.restParaStart).toBe(result.current.state.date!.paraStart);
    typeParagraph("참고 https://example.com/post/1");
    await flushTimers(NUDGE_DEBOUNCE_MS + 50);
    expect(result.current.state.url).toBeDefined();
    expect(result.current.state.restParaStart).toBeUndefined();
  });

  it("읽기 전용·관계도·시트(enabled=false)에서는 아무것도 감지하지 않는다", async () => {
    const { result } = renderHook(() => useMobileTypingNudges(editor, "n1", false));
    typeParagraph("내일 오후 3시 치과 #회");
    await flushTimers(NUDGE_DEBOUNCE_MS + 50);
    expect(result.current.state).toEqual({});
  });

  it("date_nudge_enabled=false 면 날짜 후보가 없다", async () => {
    useSettingsStore.setState({ dateNudgeEnabled: false } as never);
    const { result } = renderHook(() => useMobileTypingNudges(editor, "n1", true));
    typeParagraph("내일 오후 3시 치과");
    await flushTimers(NUDGE_DEBOUNCE_MS + 50);
    expect(result.current.state.date).toBeUndefined();
  });

  it("에디터가 파괴된 뒤에는 늦게 끝난 스캔이 터지지 않는다", async () => {
    const { result, unmount } = renderHook(() => useMobileTypingNudges(editor, "n1", true));
    typeParagraph("주말에 경주 여행");
    editor.destroy();
    await flushTimers(NUDGE_DEBOUNCE_MS + 50);
    expect(result.current.state.region).toBeUndefined();
    unmount();
  });
  it("화면에 붙기 전 에디터로 열어도 던지지 않고, 붙은 뒤에는 정상으로 제안한다", async () => {
    // 폰에서 노트를 열자마자 ErrorBoundary 로 떨어지던 것(TipTap 3: mount 전 editor.view.dom 접근이 던진다) — 회귀 방지.
    editor.destroy();
    editor = new Editor({ element: null, extensions: createMobileSchemaExtensions(), content: "<p></p>" });
    const { result } = renderHook(() => useMobileTypingNudges(editor, "n1", true)); // 예전엔 여기서 던졌다
    const host = document.createElement("div");
    document.body.appendChild(host);
    act(() => {
      editor.mount(host);
    });
    typeParagraph("내일 오후 3시 치과");
    await flushTimers(NUDGE_DEBOUNCE_MS + 100);
    expect(result.current.state.date?.payload.start_time).toBe("15:00");
    host.remove();
  });
});
