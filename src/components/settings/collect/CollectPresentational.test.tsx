import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettingsStore } from "../../../stores/settings";
import type { CollectSource } from "../../../lib/commands.gen";
import { CollectSourceRow } from "./CollectSourceRow";
import { CollectDryRunModal, type DryRunPreview } from "./CollectDryRunModal";
import { LocalImportPanel } from "./LocalImportPanel";
import type { LocalCandidate } from "./useLocalImport";

// 행·드라이런 모달·유령 행은 상태를 갖지 않는 표시 컴포넌트다 — props 만으로 그려지고 콜백만 부른다.
// (이 파일은 lib/invoke 를 쓰지 않으므로 mock 하지 않는다.)

const source = (over: Partial<CollectSource> = {}) =>
  ({
    id: "s1",
    kind: "rss",
    name: "Example Feed",
    config: JSON.stringify({ url: "https://e.com/feed.xml" }),
    enabled: true,
    last_run_at: null,
    last_status: null,
    last_error: null,
    dry_run: false,
    ...over,
  }) as unknown as CollectSource;

function renderRow(over: Partial<React.ComponentProps<typeof CollectSourceRow>> = {}) {
  const handlers = {
    onDryRun: vi.fn(),
    onRunNow: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onToggle: vi.fn(),
  };
  render(<CollectSourceRow source={source()} isLast={false} busy={false} dryBusy={false} {...handlers} {...over} />);
  return handlers;
}

describe("CollectSourceRow", () => {
  beforeEach(() => {
    useSettingsStore.setState({ uiLang: "en" } as any);
  });

  it("이름·주소·상태를 그리고 행 동작 버튼이 각자 콜백을 부른다", async () => {
    const h = renderRow();
    expect(screen.getByText("Example Feed")).toBeTruthy();
    expect(screen.getByText("Not run yet")).toBeTruthy();
    expect(screen.getByTestId("collect-address-s1").textContent).toContain("https://e.com/feed.xml");

    await userEvent.click(screen.getByTestId("collect-dry-run-s1"));
    await userEvent.click(screen.getByTestId("collect-run-s1"));
    await userEvent.click(screen.getByTestId("collect-edit-s1"));
    await userEvent.click(screen.getByTestId("collect-delete-s1"));
    await userEvent.click(screen.getByTestId("collect-enabled-s1"));

    expect(h.onDryRun).toHaveBeenCalledTimes(1);
    expect(h.onRunNow).toHaveBeenCalledTimes(1);
    expect(h.onEdit).toHaveBeenCalledTimes(1);
    expect(h.onDelete).toHaveBeenCalledTimes(1);
    expect(h.onToggle).toHaveBeenCalledWith(false);
  });

  it("실행 중(busy)이면 드라이런·실행 버튼이 잠긴다", async () => {
    const h = renderRow({ busy: true });
    expect((screen.getByTestId("collect-dry-run-s1") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("collect-run-s1") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId("collect-run-s1"));
    expect(h.onRunNow).not.toHaveBeenCalled();
  });

  it("드라이런 소스는 지금 실행 버튼이 잠기고 뱃지가 붙는다", () => {
    renderRow({ source: source({ dry_run: true } as Partial<CollectSource>) });
    expect((screen.getByTestId("collect-run-s1") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("collect-row-s1").textContent).toContain("Dry Run");
  });

  it("마지막 실행이 오류면 잘린 오류 문구를 뱃지로, 꺼진 소스는 행을 흐리게 하고 안내 title 을 준다", () => {
    renderRow({
      source: source({ last_status: "error", last_error: "x".repeat(90), enabled: false } as Partial<CollectSource>),
    });
    const badge = screen.getByTestId("collect-status-badge-s1").textContent ?? "";
    expect(badge).toContain("x".repeat(60) + "…");
    expect(badge).not.toContain("x".repeat(61));
    const row = screen.getByTestId("collect-row-s1");
    expect(row.getAttribute("style") ?? "").toContain("dim-disabled");
    expect(row.getAttribute("title")).toBeTruthy();
  });
});

describe("CollectDryRunModal", () => {
  const items = [
    { guid: "g1", title: "Article 1", link: "", seen: false, preview: "Summary 1" },
    { guid: "g2", title: "Article 2", link: "", seen: true, preview: "" },
  ];
  const preview = (over: Partial<DryRunPreview> = {}): DryRunPreview => ({
    sourceName: "Feed",
    sourceKind: "rss",
    outcome: { ok: true, items, total_found: 2, new_count: 1, seen_count: 1, error: null } as any,
    confirmSource: null,
    confirmKey: null,
    ...over,
  });

  beforeEach(() => {
    useSettingsStore.setState({ uiLang: "en" } as any);
  });

  it("항목과 새것/이미 본 것 요약을 그리고, 일반 모드에선 닫기 버튼만 있다", async () => {
    const onClose = vi.fn();
    render(<CollectDryRunModal result={preview()} confirmBusy={false} onClose={onClose} onConfirm={vi.fn()} />);

    expect(screen.getByText("Article 1")).toBeTruthy();
    expect(screen.getByText("Article 2")).toBeTruthy();
    expect(screen.getByText("New")).toBeTruthy();
    expect(screen.getByText("Already Seen")).toBeTruthy();
    expect(screen.queryByTestId("collect-dry-run-confirm-btn")).toBeNull();

    await userEvent.click(screen.getByTestId("collect-dry-run-close-btn"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("confirm 모드(confirmSource 있음)에서만 '이대로 가져오기' 버튼이 나오고 busy 면 잠긴다", async () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <CollectDryRunModal
        result={preview({ confirmSource: source(), confirmKey: "k" })}
        confirmBusy={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    await userEvent.click(screen.getByTestId("collect-dry-run-confirm-btn"));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    rerender(
      <CollectDryRunModal
        result={preview({ confirmSource: source(), confirmKey: "k" })}
        confirmBusy
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    expect((screen.getByTestId("collect-dry-run-confirm-btn") as HTMLButtonElement).disabled).toBe(true);
  });

  it("browser_history 는 열린 탭 안내를, 항목이 없으면 빈 문구를 보여준다", () => {
    render(
      <CollectDryRunModal
        result={preview({ sourceKind: "browser_history", outcome: { ok: true, items: [], error: null } as any })}
        confirmBusy={false}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("Open tabs are only recorded after you close them.")).toBeTruthy();
    expect(screen.getByText("No sources yet.")).toBeTruthy();
  });
});

describe("LocalImportPanel", () => {
  const cand = (key: string): LocalCandidate => ({
    key,
    kind: "claude_prompts",
    label: `label-${key}`,
    detail: `detail-${key}`,
    recent_count: 1,
    last_seen_at: null,
    source_id: null,
    config: "{}",
  });

  beforeEach(() => {
    useSettingsStore.setState({ uiLang: "en" } as any);
  });

  it("후보마다 유령 행을 그리고 가져오기를 누르면 그 후보로 콜백한다", async () => {
    const onImport = vi.fn();
    render(<LocalImportPanel ghostCandidates={[cand("a"), cand("b")]} importingKey={null} onImport={onImport} />);

    expect(screen.getByTestId("collect-detect-trust-hint")).toBeTruthy();
    expect(screen.getByText("label-a")).toBeTruthy();
    expect(screen.getByText("detail-b")).toBeTruthy();

    await userEvent.click(screen.getByTestId("collect-ghost-import-b"));
    expect(onImport).toHaveBeenCalledWith(expect.objectContaining({ key: "b" }));
  });

  it("가져오는 동안엔 모든 가져오기 버튼이 잠긴다", () => {
    render(<LocalImportPanel ghostCandidates={[cand("a"), cand("b")]} importingKey="a" onImport={vi.fn()} />);
    expect((screen.getByTestId("collect-ghost-import-a") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("collect-ghost-import-b") as HTMLButtonElement).disabled).toBe(true);
  });

  it("후보가 없어도 신뢰 문구는 먼저 보이고 빈 결과 문구가 따라온다", () => {
    render(<LocalImportPanel ghostCandidates={[]} importingKey={null} onImport={vi.fn()} />);
    expect(screen.getByTestId("collect-detect-trust-hint")).toBeTruthy();
    expect(screen.getByText("No local sources detected.")).toBeTruthy();
  });
});
