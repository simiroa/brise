import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, act } from "@testing-library/react";
import { useSettingsStore } from "../../stores/settings";
import { EditorSection } from "./EditorSection";

const callMock = vi.fn();
const callSilentMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

// 2026-09-18 신설(오너: "일반-에디터 페이지 신설해서, 날짜 자동등록, 지역 제한, 드롭 정책 등
// 관련 내용을 모으는 게 좋아 보임") — GeneralSection 에 있던 세 행(날짜 자동등록·지역 제안
// 엄격도·원본 처리)을 옮기고, 예전엔 에디터 툴바에서만 바꿀 수 있던 두 행(전체 너비·맞춤법
// 검사)의 첫 설정 창 노출을 더했다.
//
// 2026-09-20 오너 결정("1, 2, 3번 넣어줘") — 날짜·지역 제안을 토글 두 개에서 3단 세그먼트
// (off/suggest/auto, off/strict/loose)로 바꾸고, 붙여넣기 자동 동작 토글 3종 + 마크다운 자동
// 서식 토글(새 "입력" 카드)을 더했다. 옛 토글 testid(`…-toggle`)는 토글 자체가 사라지며 함께
// 없앴고, 행 testid 도 `settings-date-nudge-auto`/`settings-region-nudge-strict` 에서
// `settings-date-nudge-mode`/`settings-region-nudge-mode` 로 바꿨다 — "auto"/"strict" 라는
// 이름이 이제는 세 값 중 하나일 뿐이라 행 전체를 대표하는 이름으로는 misleading 해서다
// (GeneralSection.test.tsx 는 이 두 testid 의 **부재**만 확인하므로 이름을 바꿔도 안 흔들린다).
//
// 같은 날 후속 웨이브(오너: "4~7번도 넣어봐, 보고 이상하면 지울게") — **실험적** 설정 4종을
// 더하며 카드가 넷에서 다섯으로 늘었다: 입력 카드에 링크 열기 행, 입력과 표시 사이에 새 "새 노트"
// 카드(기본 날짜·첫 섹션 이름), 표시 카드에 본문 폭·글자 수 표시 행.
describe("EditorSection — 에디터 (2026-09-18 신설, 2026-09-20 3단 제안·붙여넣기·입력 확장 + 실험적 4종)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callMock.mockResolvedValue({});
    callSilentMock.mockResolvedValue({});
    useSettingsStore.setState({
      uiLang: "ko",
      dateNudgeEnabled: true,
      dateNudgeAuto: false,
      regionNudgeEnabled: true,
      regionNudgeStrict: true,
      sourceOriginalPolicy: "ask",
      pasteLinkNudge: true,
      pastePathInlineCode: true,
      pasteTableSheetSuggest: true,
      editorMdAutoformat: true,
      editorFullWidth: false,
      spellcheckEnabled: false,
      linkOpenOnClick: false,
      editorWidth: "normal",
      editorWordCount: true,
      newNoteDatePrecision: "day",
      newNoteSectionName: "",
    } as any);
  });

  it("자동 제안·붙여넣기·드롭·입력·새 노트·표시 다섯 카드가 이 순서로 선다", () => {
    const { container } = render(<EditorSection />);

    const cards = container.querySelectorAll(".card");
    expect(Array.from(cards).map((c) => c.getAttribute("data-testid"))).toEqual([
      "settings-editor-auto-suggest",
      "settings-editor-paste-drop",
      "settings-editor-input",
      "settings-editor-new-note",
      "settings-editor-display",
    ]);
  });

  it("날짜 제안 선택기가 enabled·auto 네 조합 모두에서 옳은 옵션을 선택 상태로 보여준다", () => {
    const combos: Array<[boolean, boolean, string]> = [
      [false, false, "끄기"],
      [false, true, "끄기"], // enabled=false 면 auto 값과 무관하게 항상 off (dateNudgeModeOf 규약)
      [true, false, "제안만"],
      [true, true, "자동 등록"],
    ];
    for (const [enabled, auto, expectedLabel] of combos) {
      useSettingsStore.setState({ dateNudgeEnabled: enabled, dateNudgeAuto: auto } as any);
      const { unmount } = render(<EditorSection />);
      const group = screen.getByRole("radiogroup", { name: "날짜 제안" });
      expect(within(group).getByRole("radio", { name: expectedLabel }).getAttribute("aria-checked")).toBe("true");
      unmount();
    }
  });

  it("지역 제안 선택기가 enabled·strict 네 조합 모두에서 옳은 옵션을 선택 상태로 보여준다", () => {
    const combos: Array<[boolean, boolean, string]> = [
      [false, false, "끄기"],
      [false, true, "끄기"],
      [true, false, "느슨"],
      [true, true, "엄격"],
    ];
    for (const [enabled, strict, expectedLabel] of combos) {
      useSettingsStore.setState({ regionNudgeEnabled: enabled, regionNudgeStrict: strict } as any);
      const { unmount } = render(<EditorSection />);
      const group = screen.getByRole("radiogroup", { name: "지역 제안" });
      expect(within(group).getByRole("radio", { name: expectedLabel }).getAttribute("aria-checked")).toBe("true");
      unmount();
    }
  });

  it("날짜 제안 선택기에서 옵션을 고르면 setDateNudgeMode 가 한 settings_set 호출로 두 키를 같이 바꾼다", () => {
    useSettingsStore.setState({ dateNudgeEnabled: false, dateNudgeAuto: false } as any);
    render(<EditorSection />);
    const group = screen.getByRole("radiogroup", { name: "날짜 제안" });

    act(() => {
      fireEvent.click(within(group).getByRole("radio", { name: "제안만" }));
    });
    expect(useSettingsStore.getState().dateNudgeEnabled).toBe(true);
    expect(useSettingsStore.getState().dateNudgeAuto).toBe(false);
    expect(callMock).toHaveBeenLastCalledWith("settings_set", { entries: { date_nudge_enabled: true, date_nudge_auto: false } });

    act(() => {
      fireEvent.click(within(group).getByRole("radio", { name: "자동 등록" }));
    });
    expect(useSettingsStore.getState().dateNudgeAuto).toBe(true);
    expect(callMock).toHaveBeenLastCalledWith("settings_set", { entries: { date_nudge_enabled: true, date_nudge_auto: true } });

    // off 로 갈 때는 date_nudge_auto 를 entries 에서 아예 뺀다(이전 선택 보존, setDateNudgeMode 주석).
    act(() => {
      fireEvent.click(within(group).getByRole("radio", { name: "끄기" }));
    });
    expect(useSettingsStore.getState().dateNudgeEnabled).toBe(false);
    expect(callMock).toHaveBeenLastCalledWith("settings_set", { entries: { date_nudge_enabled: false } });
  });

  it("지역 제안 선택기에서 옵션을 고르면 setRegionNudgeMode 가 한 settings_set 호출로 두 키를 같이 바꾼다", () => {
    useSettingsStore.setState({ regionNudgeEnabled: false, regionNudgeStrict: true } as any);
    render(<EditorSection />);
    const group = screen.getByRole("radiogroup", { name: "지역 제안" });

    act(() => {
      fireEvent.click(within(group).getByRole("radio", { name: "느슨" }));
    });
    expect(useSettingsStore.getState().regionNudgeEnabled).toBe(true);
    expect(useSettingsStore.getState().regionNudgeStrict).toBe(false);
    expect(callMock).toHaveBeenLastCalledWith("settings_set", { entries: { region_nudge_enabled: true, region_nudge_strict: false } });

    act(() => {
      fireEvent.click(within(group).getByRole("radio", { name: "엄격" }));
    });
    expect(useSettingsStore.getState().regionNudgeStrict).toBe(true);
    expect(callMock).toHaveBeenLastCalledWith("settings_set", { entries: { region_nudge_enabled: true, region_nudge_strict: true } });

    act(() => {
      fireEvent.click(within(group).getByRole("radio", { name: "끄기" }));
    });
    expect(useSettingsStore.getState().regionNudgeEnabled).toBe(false);
    expect(callMock).toHaveBeenLastCalledWith("settings_set", { entries: { region_nudge_enabled: false } });
  });

  it("source_original_policy 셀렉트가 붙여넣기·드롭 카드에 있고 고르면 settings_set 을 부른다", async () => {
    render(<EditorSection />);

    const card = screen.getByTestId("settings-editor-paste-drop");
    const trigger = screen.getByLabelText("파일 드롭 시 원본 처리");
    expect(card.contains(trigger)).toBe(true);
    expect(trigger.textContent).toContain("놓을 때마다 묻기");

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByText("원본 보관"));

    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { source_original_policy: "keep" } });
  });

  it("붙여넣기 제안 토글 세 개가 붙여넣기·드롭 카드에 있고 클릭하면 각자의 스토어 값과 settings_set 을 함께 바꾼다", () => {
    render(<EditorSection />);

    const card = screen.getByTestId("settings-editor-paste-drop");
    const linkToggle = screen.getByTestId("settings-paste-link-nudge-toggle");
    const pathToggle = screen.getByTestId("settings-paste-path-inline-code-toggle");
    const tableToggle = screen.getByTestId("settings-paste-table-sheet-suggest-toggle");
    expect(card.contains(linkToggle)).toBe(true);
    expect(card.contains(pathToggle)).toBe(true);
    expect(card.contains(tableToggle)).toBe(true);

    act(() => {
      fireEvent.click(linkToggle);
    });
    expect(useSettingsStore.getState().pasteLinkNudge).toBe(false);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { paste_link_nudge: false } });

    act(() => {
      fireEvent.click(pathToggle);
    });
    expect(useSettingsStore.getState().pastePathInlineCode).toBe(false);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { paste_path_inline_code: false } });

    act(() => {
      fireEvent.click(tableToggle);
    });
    expect(useSettingsStore.getState().pasteTableSheetSuggest).toBe(false);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { paste_table_sheet_suggest: false } });
  });

  it("마크다운 자동 서식 토글이 입력 카드에 있고 클릭하면 스토어 값과 settings_set 을 함께 바꾼다", () => {
    render(<EditorSection />);

    const card = screen.getByTestId("settings-editor-input");
    const toggle = screen.getByTestId("settings-editor-md-autoformat-toggle");
    expect(card.contains(toggle)).toBe(true);

    act(() => {
      fireEvent.click(toggle);
    });
    expect(useSettingsStore.getState().editorMdAutoformat).toBe(false);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { editor_md_autoformat: false } });
  });

  // 예전엔 에디터 툴바(FixedToolbar.tsx)에서만 켤 수 있던 두 토글의 첫 설정 창 노출.
  it("editor_full_width·spellcheck_enabled 토글이 표시 카드에 있고 클릭하면 각자의 스토어 setter 를 부른다", async () => {
    render(<EditorSection />);

    const card = screen.getByTestId("settings-editor-display");
    const widthToggle = screen.getByTestId("settings-editor-full-width-toggle");
    const spellToggle = screen.getByTestId("settings-spellcheck-enabled-toggle");
    expect(card.contains(widthToggle)).toBe(true);
    expect(card.contains(spellToggle)).toBe(true);

    act(() => {
      fireEvent.click(widthToggle);
    });
    expect(useSettingsStore.getState().editorFullWidth).toBe(true);

    act(() => {
      fireEvent.click(spellToggle);
    });
    expect(useSettingsStore.getState().spellcheckEnabled).toBe(true);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { spellcheck_enabled: true } });
  });

  it("모든 키가 노트북별 설정이라 '앱 전체' 칩이 붙지 않는다", () => {
    render(<EditorSection />);
    expect(screen.queryByTestId("settings-app-scope")).toBeNull();
  });

  // ── 실험적 4종(2026-09-20 후속 웨이브, "4~7번도 넣어봐") ─────────────────────────────────

  it("링크 열기 세그먼트가 입력 카드에 있고 linkOpenOnClick 을 반영하며 고르면 setLinkOpenOnClick 을 부른다", () => {
    render(<EditorSection />);

    const card = screen.getByTestId("settings-editor-input");
    const group = screen.getByRole("radiogroup", { name: "링크 열기" });
    expect(card.contains(group)).toBe(true);
    expect(within(group).getByRole("radio", { name: "Ctrl+클릭" }).getAttribute("aria-checked")).toBe("true");

    act(() => {
      fireEvent.click(within(group).getByRole("radio", { name: "클릭" }));
    });
    expect(useSettingsStore.getState().linkOpenOnClick).toBe(true);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { link_open_on_click: true } });
  });

  it("새 노트 카드가 입력과 표시 사이에 있고 기본 날짜 세그먼트가 newNoteDatePrecision 을 반영한다", () => {
    useSettingsStore.setState({ newNoteDatePrecision: "month" } as any);
    const { container } = render(<EditorSection />);

    const cards = Array.from(container.querySelectorAll(".card")).map((c) => c.getAttribute("data-testid"));
    expect(cards.indexOf("settings-editor-input")).toBeLessThan(cards.indexOf("settings-editor-new-note"));
    expect(cards.indexOf("settings-editor-new-note")).toBeLessThan(cards.indexOf("settings-editor-display"));

    const card = screen.getByTestId("settings-editor-new-note");
    const group = screen.getByRole("radiogroup", { name: "기본 날짜" });
    expect(card.contains(group)).toBe(true);
    expect(within(group).getByRole("radio", { name: "연·월" }).getAttribute("aria-checked")).toBe("true");

    act(() => {
      fireEvent.click(within(group).getByRole("radio", { name: "연도만" }));
    });
    expect(useSettingsStore.getState().newNoteDatePrecision).toBe("year");
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { new_note_date_precision: "year" } });
  });

  it("첫 섹션 이름 입력이 blur/Enter 에서만 커밋되고 매 키 입력마다는 커밋하지 않으며, 40자로 잘리고, ×가 비운다", () => {
    useSettingsStore.setState({ newNoteSectionName: "" } as any);
    render(<EditorSection />);

    const input = screen.getByTestId("settings-new-note-section-name-input") as HTMLInputElement;
    // 비워두면 쓰이는 이름 — UI 언어(ko)별 기본 이름, Rust default_section_name_for_lang 과 같다.
    expect(input.placeholder).toBe("개요");
    expect(input.maxLength).toBe(40);
    // × 는 비어 있는 동안 안 보인다.
    expect(screen.queryByTestId("settings-new-note-section-name-clear")).toBeNull();

    act(() => {
      fireEvent.change(input, { target: { value: "할 일" } });
    });
    // 타이핑만으로는 커밋하지 않는다.
    expect(callMock).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().newNoteSectionName).toBe("");

    act(() => {
      fireEvent.blur(input);
    });
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { new_note_section_name: "할 일" } });
    expect(useSettingsStore.getState().newNoteSectionName).toBe("할 일");

    // Enter 는 blur 를 트리거해 커밋한다(직접 커밋하지 않는다 — userName 과 같은 패턴). 실제
    // DOM 포커스가 있어야 `element.blur()` 가 진짜 blur 이벤트를 낸다(jsdom) — fireEvent.focus
    // 는 activeElement 를 바꾸지 않으므로 여기서는 진짜 .focus() 를 부른다.
    input.focus();
    act(() => {
      fireEvent.change(input, { target: { value: "회의록" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { new_note_section_name: "회의록" } });

    // × 버튼이 이제 보이고, 누르면 즉시 비우고 커밋한다(blur 를 기다리지 않는다).
    const clearBtn = screen.getByTestId("settings-new-note-section-name-clear");
    act(() => {
      fireEvent.click(clearBtn);
    });
    expect((screen.getByTestId("settings-new-note-section-name-input") as HTMLInputElement).value).toBe("");
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { new_note_section_name: "" } });
  });

  it("첫 섹션 이름 placeholder 는 UI 언어를 따른다", () => {
    useSettingsStore.setState({ uiLang: "fr" } as any);
    const { unmount } = render(<EditorSection />);
    expect((screen.getByTestId("settings-new-note-section-name-input") as HTMLInputElement).placeholder).toBe("Aperçu");
    unmount();
    useSettingsStore.setState({ uiLang: "en" } as any);
    render(<EditorSection />);
    expect((screen.getByTestId("settings-new-note-section-name-input") as HTMLInputElement).placeholder).toBe("Overview");
  });

  it("첫 섹션 이름: Escape 는 편집을 취소하고 커밋하지 않는다", () => {
    useSettingsStore.setState({ newNoteSectionName: "개요2" } as any);
    render(<EditorSection />);
    const input = screen.getByTestId("settings-new-note-section-name-input") as HTMLInputElement;
    input.focus();
    act(() => {
      fireEvent.change(input, { target: { value: "버릴 이름" } });
      fireEvent.keyDown(input, { key: "Escape" });
    });
    expect(input.value).toBe("개요2");
    expect(callMock).not.toHaveBeenCalled();
    // 취소 뒤의 편집은 다시 정상적으로 커밋된다(건너뛰기는 한 번뿐).
    input.focus();
    act(() => {
      fireEvent.change(input, { target: { value: "회의록" } });
      fireEvent.blur(input);
    });
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { new_note_section_name: "회의록" } });
  });

  it("첫 섹션 이름: 공백뿐인 값은 빈 값(기본 이름)으로 저장하고 ×도 숨긴다", () => {
    useSettingsStore.setState({ newNoteSectionName: "회의록" } as any);
    render(<EditorSection />);
    const input = screen.getByTestId("settings-new-note-section-name-input") as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: "   " } });
    });
    expect(screen.queryByTestId("settings-new-note-section-name-clear")).toBeNull();
    act(() => {
      fireEvent.blur(input);
    });
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { new_note_section_name: "" } });
    expect(input.value).toBe("");
  });

  it("본문 폭 행: 잠긴 동안 사유는 툴팁(disabledReason)으로만 말하고 힌트는 평소 문장이다", () => {
    useSettingsStore.setState({ editorFullWidth: true } as any);
    render(<EditorSection />);
    const row = screen.getByTestId("settings-editor-width");
    const reason = row.getAttribute("data-disabled-reason");
    expect(reason).toBeTruthy();
    // 사유 문구는 화면에 상주하지 않는다 — DOM 에 있는 건 aria-describedby 가 가리키는 화면 밖 텍스트 하나뿐.
    const describedBy = document.getElementById(row.getAttribute("aria-describedby") ?? "");
    expect(describedBy?.textContent).toBe(reason);
    expect(describedBy?.style.position).toBe("absolute");
    expect(describedBy?.style.overflow).toBe("hidden");
    expect((row.textContent ?? "").split(reason!).length - 1).toBe(1);
  });

  it("본문 폭 세그먼트가 표시 카드에 있고 전체 너비가 켜지면 잠긴다", () => {
    useSettingsStore.setState({ editorWidth: "wide", editorFullWidth: false } as any);
    const { rerender } = render(<EditorSection />);

    const card = screen.getByTestId("settings-editor-width");
    const group = within(card).getByRole("radiogroup", { name: "본문 폭" });
    expect(within(group).getByRole("radio", { name: "넓게" }).getAttribute("aria-checked")).toBe("true");
    expect(card.getAttribute("aria-disabled")).toBeNull();

    act(() => {
      fireEvent.click(within(group).getByRole("radio", { name: "좁게" }));
    });
    expect(useSettingsStore.getState().editorWidth).toBe("narrow");
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { editor_width: "narrow" } });

    useSettingsStore.setState({ editorFullWidth: true } as any);
    rerender(<EditorSection />);
    const disabledCard = screen.getByTestId("settings-editor-width");
    expect(disabledCard.getAttribute("aria-disabled")).toBe("true");
    const disabledGroup = within(disabledCard).getByRole("radiogroup", { name: "본문 폭" });
    for (const opt of ["좁게", "보통", "넓게"]) {
      expect(within(disabledGroup).getByRole("radio", { name: opt }).getAttribute("aria-disabled")).toBe("true");
    }

    callMock.mockClear();
    act(() => {
      fireEvent.click(within(disabledGroup).getByRole("radio", { name: "좁게" }));
    });
    // 잠긴 동안은 클릭해도 값이 바뀌지 않는다.
    expect(useSettingsStore.getState().editorWidth).toBe("narrow");
    expect(callMock).not.toHaveBeenCalled();
  });

  it("글자 수 표시 토글이 표시 카드에 있고 클릭하면 스토어 값과 settings_set 을 함께 바꾼다", () => {
    render(<EditorSection />);

    const card = screen.getByTestId("settings-editor-display");
    const toggle = screen.getByTestId("settings-editor-word-count-toggle");
    expect(card.contains(toggle)).toBe(true);

    act(() => {
      fireEvent.click(toggle);
    });
    expect(useSettingsStore.getState().editorWordCount).toBe(false);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { editor_word_count: false } });
  });

  it("표시 카드의 행 순서가 전체 너비 → 본문 폭 → 글자 수 표시 → 맞춤법 검사다", () => {
    const { container } = render(<EditorSection />);
    const card = container.querySelector('[data-testid="settings-editor-display"]') as HTMLElement;
    const rowTestIds = [
      "settings-editor-full-width",
      "settings-editor-width",
      "settings-editor-word-count",
      "settings-spellcheck-enabled",
    ];
    // querySelectorAll 순서는 문서 순서와 같다 — 네 행의 testid 가 이 순서로 나타나는지만 본다.
    const seen = Array.from(card.querySelectorAll("[data-testid]"))
      .map((el) => el.getAttribute("data-testid"))
      .filter((id): id is string => !!id && rowTestIds.includes(id));
    expect(seen).toEqual(rowTestIds);
  });
});
