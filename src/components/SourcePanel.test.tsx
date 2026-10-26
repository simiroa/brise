import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Attachment, NoteDetail, NoteSummary } from "../lib/commands.gen";
import { useNotesStore } from "../stores/notes";

// SourcePanel's own job (P30 preset-visibility rule) is the decision of which child to render —
// PresetList vs PreviewAttachment. Both are heavy siblings (map/attachment preview trees) with
// no bearing on that decision, so they're stubbed to a single identifiable testid each, same
// mocking shape as AttachmentsBar.test.tsx uses for its own heavy children.
// PLAN-2026-09-21 W1: SourcePanel 이 PresetList 대신 AssistPanel 을 그린다 — 스텁 대상만 바뀐다.
vi.mock("./assist/AssistPanel", () => ({
  AssistPanel: () => <div data-testid="preset-list-stub" />,
}));
vi.mock("./PreviewAttachment", () => ({
  PreviewAttachment: () => <div data-testid="preview-attachment-stub" />,
}));

let autoRelatedResult: NoteSummary[] = [];
vi.mock("./attachments/useAutoRelated", () => ({
  useAutoRelated: () => autoRelatedResult,
}));

import { useUiStore } from "../stores/ui";
import { SourcePanel } from "./SourcePanel";
import { t } from "../i18n/t";

// SourcePanel now measures its own width (useElementSize, owner 2026-09-19: header title hides
// instead of wrapping when too narrow) — jsdom has no ResizeObserver, so every test needs a stub.
// Same synchronous-notify shape as useElementSize.test.tsx's own stub. Default width (999) is
// "always wide enough" so none of the pre-existing tests below have to know this exists; only the
// dedicated describe block at the bottom overrides it to exercise the narrow case.
let resizeObserverBoxWidth = 999;
beforeEach(() => {
  resizeObserverBoxWidth = 999;
  global.ResizeObserver = class {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(target: Element) {
      this.cb(
        [
          {
            target,
            contentRect: {
              width: resizeObserverBoxWidth,
              height: 0,
              top: 0,
              left: 0,
              right: resizeObserverBoxWidth,
              bottom: 0,
              x: 0,
              y: 0,
            },
          } as unknown as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  };
});

function summary(id: string): NoteSummary {
  return {
    id, folder_id: "f1", title: "Note", year: 2024, is_favorite: false, exported_at: null,
    has_image: false, tag_names: [], region: null, region_names: [], status: null, icon: null,
    lat: null, lng: null,
    created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z", month: null, day: null,
  };
}

function detail(bodyMd: string, attachments: Attachment[] = []): NoteDetail {
  return {
    note: summary("n1"),
    sections: [{ id: "sec1", name: "Overview", body_md: bodyMd, position: 0, kind: "text" }],
    sources: [],
    attachments,
  };
}

const attachment = (id: string): Attachment => ({
  id, name: `${id}.png`, kind: "image", rel_path: `n1/${id}.png`, url: null, size_bytes: 1, position: 0,
});

describe("SourcePanel — preset-visibility rule (P30)", () => {
  beforeEach(() => {
    autoRelatedResult = [];
    useUiStore.setState({
      previewItem: null,
      previewPast: [],
      previewFuture: [],
      previewCollapsed: false,
      previewExpanded: false,
    });
    useNotesStore.setState({
      activeNote: null,
      activeDraft: false,
      activeBodyEmpty: true,
    });
  });

  it("shows presets for a fresh draft (baseline, unchanged)", () => {
    useNotesStore.setState({
      activeNote: detail(""),
      activeDraft: true,
      activeBodyEmpty: true,
    });
    render(<SourcePanel />);
    expect(screen.getByTestId("preset-list-stub")).toBeDefined();
    expect(screen.queryByTestId("preview-attachment-stub")).toBeNull();
  });

  it("shows presets for an emptied SAVED (materialized) note — body cleared, no attachments, no related", () => {
    useNotesStore.setState({
      activeNote: detail(""),
      activeDraft: false,
      activeBodyEmpty: true,
    });
    autoRelatedResult = [];

    render(<SourcePanel />);

    expect(screen.getByTestId("preset-list-stub")).toBeDefined();
    expect(screen.queryByTestId("preview-attachment-stub")).toBeNull();
  });

  // OWNER RULE (2026-07-31): "본문이 비었고 미리보기란에 다른 게 안 떠 있으면 처음처럼".
  // 첨부의 "존재"는 조건이 아니다 — 아무것도 고르지 않았다면 미리보기 칸은 "선택하세요" 힌트만
  // 띄우고 있고, 그 자리는 프리셋의 자리다. 이 케이스는 예전 규칙("첨부가 있으면 숨김")을
  // 그대로 뒤집은 것이다.
  it("shows presets when an attachment exists but NOTHING is selected in the preview", () => {
    useNotesStore.setState({
      activeNote: detail("", [attachment("a1")]),
      activeDraft: false,
      activeBodyEmpty: true,
    });

    render(<SourcePanel />);

    expect(screen.getByTestId("preset-list-stub")).toBeDefined();
    expect(screen.queryByTestId("preview-attachment-stub")).toBeNull();
  });

  it("hides presets once that attachment is actually selected", () => {
    useNotesStore.setState({
      activeNote: detail("", [attachment("a1")]),
      activeDraft: false,
      activeBodyEmpty: true,
    });
    useUiStore.setState({ previewItem: { kind: "attachment", id: "a1" } });

    render(<SourcePanel />);

    expect(screen.getByTestId("preview-attachment-stub")).toBeDefined();
    expect(screen.queryByTestId("preset-list-stub")).toBeNull();
  });

  // previewItem 은 노트를 바꿔도 살아남는다(useUiStore). A노트에서 고른 첨부 id 가 남은 채
  // 빈 B노트를 열면 previewItem 은 non-null 이지만 이 노트에서는 아무것도 해석되지 않는다 —
  // null 검사로 짜면 여기서 프리셋이 사라진다.
  it("shows presets when a STALE previewItem from another note can't resolve here", () => {
    useNotesStore.setState({
      activeNote: detail("", [attachment("a1")]),
      activeDraft: false,
      activeBodyEmpty: true,
    });
    useUiStore.setState({ previewItem: { kind: "attachment", id: "from-another-note" } });

    render(<SourcePanel />);

    expect(screen.getByTestId("preset-list-stub")).toBeDefined();
    expect(screen.queryByTestId("preview-attachment-stub")).toBeNull();
  });

  it("hides presets when a resolved preview item exists (e.g. previewing a related note), even with empty body and no attachments", () => {
    useNotesStore.setState({
      activeNote: detail(""),
      activeDraft: false,
      activeBodyEmpty: true,
    });
    useUiStore.setState({ previewItem: { kind: "note", id: "related-1" } });

    render(<SourcePanel />);

    expect(screen.getByTestId("preview-attachment-stub")).toBeDefined();
    expect(screen.queryByTestId("preset-list-stub")).toBeNull();
  });

  // 2026-08-02 규칙 변경: 예전엔 "본문에 내용이 생기면 프리셋을 숨긴다"였다. 그 결과 본문은 있는데
  // 첨부에서 아무것도 고르지 않은 상태에서 빈 미리보기가 떴다(오너 신고: 새 노트 직후 / 본문 빈
  // 노트 / 아무것도 선택 안 한 상태 — 셋이 같은 상황인데 마지막만 화면이 달랐다).
  // 이제 조건은 "지금 미리보기가 실제로 무언가를 그리는가" 하나뿐이고, 본문 유무는 무관하다.
  it("keeps presets when the body has content but nothing is actually being previewed", () => {
    useNotesStore.setState({
      activeNote: detail("real content"),
      activeDraft: false,
      activeBodyEmpty: false,
    });

    render(<SourcePanel />);

    expect(screen.getByTestId("preset-list-stub")).toBeDefined();
    expect(screen.queryByTestId("preview-attachment-stub")).toBeNull();
  });

  it("shows presets for an emptied note that still has a non-default title (title doesn't count)", () => {
    const d = detail("");
    d.note.title = "My Trip";
    useNotesStore.setState({ activeNote: d, activeDraft: false, activeBodyEmpty: true });
    autoRelatedResult = [];

    render(<SourcePanel />);

    expect(screen.getByTestId("preset-list-stub")).toBeDefined();
  });
});

// Regression (owner 2026-07-31, N1-4): the 28px rail branch was deleted in favor of "shrink
// height to the header row only", while App.tsx kept collapsing the source column to width:auto
// and hiding the resize grip on the SAME previewCollapsed flag — one contract split across two
// files, and restoring only SourcePanel's half reproduced the bug (card shrank to title width,
// no way to resize back). App.tsx is untouched here (owner: don't touch it) — this pins
// SourcePanel's half of the contract so the next person who "simplifies" the collapse branch
// breaks a test immediately instead of shipping a silent regression.
describe("SourcePanel — collapse/width contract (N1-4)", () => {
  beforeEach(() => {
    autoRelatedResult = [];
    useUiStore.setState({
      previewItem: null,
      previewCollapsed: false,
      previewExpanded: false,
      previewPast: [],
      previewFuture: [],
    });
    useNotesStore.setState({ activeNote: null, activeDraft: false, activeBodyEmpty: true });
  });

  it("collapsed: renders the 28px rail, not PresetList/PreviewAttachment content", () => {
    useNotesStore.setState({ activeNote: detail(""), activeDraft: true, activeBodyEmpty: true });
    useUiStore.setState({ previewCollapsed: true });

    const { container } = render(<SourcePanel />);

    const rail = container.querySelector('[data-testid="source-panel-collapsed-rail"]') as HTMLElement | null;
    expect(rail).not.toBeNull();
    expect(rail?.style.width).toBe("28px");
    expect(screen.getByRole("button", { name: t("sources.expand_card") })).toBeDefined();
    expect(screen.queryByTestId("preset-list-stub")).toBeNull();
    expect(screen.queryByTestId("preview-attachment-stub")).toBeNull();
  });

  it("expanded (not collapsed): the card fills the column's width, not its content width", () => {
    useNotesStore.setState({ activeNote: detail(""), activeDraft: true, activeBodyEmpty: true });
    useUiStore.setState({ previewCollapsed: false });

    const { container } = render(<SourcePanel />);

    const card = container.querySelector('[data-testid="source-panel-drop-target"]') as HTMLElement | null;
    expect(card).not.toBeNull();
    // Both halves of the contract SourcePanel's own comment names: "flex:none + width:100% 가
    // 빠지면 카드가 내용 너비로 쪼그라들어" — pinning width alone would still pass if someone
    // dropped flex:"none" and reintroduced the shrink-to-content bug via the flex algorithm.
    // jsdom normalizes the "none" shorthand to its longhand ("0 0 auto") on readback.
    expect(card?.style.flex).toBe("0 0 auto");
    expect(card?.style.width).toBe("100%");
    expect(screen.getByTestId("preset-list-stub")).toBeDefined();
  });

  it("expanded card exposes the file drop target (Part A)", () => {
    useNotesStore.setState({ activeNote: detail(""), activeDraft: true, activeBodyEmpty: true });
    useUiStore.setState({ previewCollapsed: false });
    render(<SourcePanel />);
    expect(screen.getByTestId("source-panel-drop-target")).toBeDefined();
  });
});

// Wave 3 L1 Part B: session-only back/forward on the preview selection. Controls stay quiet
// (hidden with empty stacks) and only appear once there is somewhere to step.
describe("SourcePanel — preview history (Part B)", () => {
  beforeEach(() => {
    autoRelatedResult = [];
    useUiStore.setState({
      previewItem: null,
      previewPast: [],
      previewFuture: [],
      previewCollapsed: false,
      previewExpanded: false,
    });
    useNotesStore.setState({
      activeNote: detail("", [attachment("a1"), attachment("a2")]),
      activeDraft: false,
      activeBodyEmpty: true,
    });
  });

  it("hides back/forward until history has entries", () => {
    useUiStore.setState({ previewItem: { kind: "attachment", id: "a1" } });
    render(<SourcePanel />);
    expect(screen.queryByTestId("preview-history-back")).toBeNull();
    expect(screen.queryByTestId("preview-history-forward")).toBeNull();
  });

  it("back steps to the previous preview selection", () => {
    useUiStore.getState().setPreviewItem({ kind: "attachment", id: "a1" });
    useUiStore.getState().setPreviewItem({ kind: "attachment", id: "a2" });
    render(<SourcePanel />);

    expect(useUiStore.getState().previewItem).toEqual({ kind: "attachment", id: "a2" });
    expect(screen.getByTestId("preview-history-back")).toBeDefined();
    screen.getByTestId("preview-history-back").click();
    expect(useUiStore.getState().previewItem).toEqual({ kind: "attachment", id: "a1" });
  });

  it("forward restores after back", () => {
    useUiStore.getState().setPreviewItem({ kind: "attachment", id: "a1" });
    useUiStore.getState().setPreviewItem({ kind: "attachment", id: "a2" });
    useUiStore.getState().previewHistoryBack();
    render(<SourcePanel />);

    expect(useUiStore.getState().previewItem).toEqual({ kind: "attachment", id: "a1" });
    screen.getByTestId("preview-history-forward").click();
    expect(useUiStore.getState().previewItem).toEqual({ kind: "attachment", id: "a2" });
  });

  it("caps past stack at PREVIEW_HISTORY_CAP (20)", async () => {
    const { PREVIEW_HISTORY_CAP } = await import("../stores/ui");
    for (let i = 0; i < PREVIEW_HISTORY_CAP + 5; i++) {
      useUiStore.getState().setPreviewItem({ kind: "attachment", id: `x${i}` });
    }
    expect(useUiStore.getState().previewPast.length).toBe(PREVIEW_HISTORY_CAP);
  });
});

// Regression (owner 2026-09-19): dragging the split narrower used to wrap the header title onto
// a second line and bust the fixed-height header row. Below HEADER_TITLE_MIN_W the title hides
// entirely (icon-only) instead of wrapping or truncating — owner explicitly preferred no-text
// over an ellipsis.
describe("SourcePanel — header title hides instead of wrapping when narrow", () => {
  beforeEach(() => {
    autoRelatedResult = [];
    useUiStore.setState({
      previewItem: null,
      previewPast: [],
      previewFuture: [],
      previewCollapsed: false,
      previewExpanded: false,
    });
    useNotesStore.setState({ activeNote: detail(""), activeDraft: true, activeBodyEmpty: true });
  });

  it("shows the title once the panel is wide enough", () => {
    resizeObserverBoxWidth = 300;
    render(<SourcePanel />);
    expect(screen.getByText(t("presets.pane_assist"))).toBeDefined();
  });

  it("hides the title (icon-only header) when the panel is narrower than the min width", () => {
    resizeObserverBoxWidth = 150;
    render(<SourcePanel />);
    expect(screen.queryByText(t("presets.pane_assist"))).toBeNull();
  });
});
