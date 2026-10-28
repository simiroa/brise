import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { t } from "../../i18n/t";
import { IconClose } from "../icons";
import { WindowCloseButton } from "../common/WindowCloseButton";
import { useActiveNotebook } from "./useActiveNotebookName";
import { NotebookChip } from "./NotebookChip";
import { useSettingsStore } from "../../stores/settings";
import { searchSettings, type SettingsSearchResult } from "./searchSettings";
import { SETTINGS_SEARCH_INDEX } from "./settingsSearchIndex";

export type SettingsScope = "notebook" | "app";

const chipStyle = {
  minWidth: 0,
  maxWidth: 240,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  fontSize: "var(--text-xs)",
  color: "var(--muted)",
  border: "1px solid var(--divider)",
  borderRadius: "var(--radius-pill)",
  padding: "0 var(--space-3)",
  lineHeight: "var(--lh-ui)",
} as const;

/**
 * 설정 창 맨 위 한 줄 (PLAN-2026-10-24 D1, B3 → 2026-10-27 개편) — 두 칸을 **패널 그리드에 직접** 내놓는다(프래그먼트):
 * 1행 1열(레일 위) = 범위 칩(노트북별 페이지는 노트북 드롭다운, 앱 전체 페이지는 "앱 전체"), 1행 2열(본문 위) = 검색창 + 닫기.
 * 설정 톱니 아이콘은 뺐다. 검색창의 왼쪽은 레일과 본문 사이 세로 구분선(본문 캔버스의 왼쪽 가장자리)에 맞춘다(2026-10-27 C1).
 * 기본 폭은 좁게 두고(나머지는 창 드래그 자리) 포커스·입력 중에만 넓힌다 — settingsLayout.css 의 .settings-search-box.
 * 창 타이틀 스트립이 없는 이 창(D10 ①)의 드래그 손잡이와 닫기 X 를 맡는다. Tauri 2 는 `data-tauri-drag-region` 을
 * **단 요소 자신**을 눌렀을 때만 끌기를 시작하므로 빈 자리에만 달고 입력·버튼·칩에는 달지 않는다.
 * 높이는 메인 창 스트립과 같은 --row-chrome.
 */
export function SettingsHeader({
  scope,
  busy,
  onClose,
  pages = [],
  aiEnabled = false,
  browser = false,
  onPick,
}: {
  scope: SettingsScope;
  busy: boolean;
  onClose: () => void;
  /** 검색이 돌 페이지(브라우저 모드면 이미 걸러진 목록)와 그 라벨. */
  pages?: ReadonlyArray<{ id: string; label: string }>;
  aiEnabled?: boolean;
  browser?: boolean;
  /** 결과 선택 — SettingsPanel 이 페이지를 바꾸고 앵커로 스크롤·강조한다. */
  onPick?: (page: string, anchor?: string) => void;
}) {
  const { name: notebookName, icon: notebookIcon } = useActiveNotebook();
  const activeWorkspaceId = useSettingsStore((st) => st.activeWorkspaceId); // = 노트북
  const inputRef = useRef<HTMLInputElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const results = useMemo(
    () =>
      searchSettings(query, SETTINGS_SEARCH_INDEX, {
        pageIds: pages.map((p) => p.id),
        aiEnabled,
        browser,
        pageLabel: (id) => pages.find((p) => p.id === id)?.label ?? id,
      }),
    [query, pages, aiEnabled, browser],
  );
  const optionId = (i: number) => `${listboxId}-opt-${i}`;
  const showList = open && query.trim() !== "";

  const close = () => setOpen(false);
  const pick = (r: SettingsSearchResult) => {
    onPick?.(r.entry.page, r.anchor);
    setQuery("");
    setOpen(false);
    inputRef.current?.blur();
  };

  // Ctrl+F / Cmd+F — 설정 창 어디서든 검색창으로. 창 안 에디터(ProseMirror)가 있으면 그쪽 찾기에 양보한다.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "f") return;
      if ((e.target as HTMLElement | null)?.closest?.(".ProseMirror")) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 바깥을 누르면 닫는다.
  useEffect(() => {
    if (!showList) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showList]);

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!results.length) return;
      e.preventDefault();
      setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + results.length) % results.length);
    } else if (e.key === "Enter") {
      const r = showList ? results[active] : undefined;
      if (r) {
        e.preventDefault();
        pick(r);
      }
    } else if (e.key === "Escape") {
      // 첫 Esc = 비우고 닫기, 한 번 더 = 포커스 해제.
      if (query || open) {
        e.preventDefault();
        setQuery("");
        setOpen(false);
      } else inputRef.current?.blur();
    }
  };

  return (
    <>
      {/* 레일 맨 위 칸(그리드 1행 1열) — 노트북 드롭다운이 아래 내비 항목과 같은 폭·결로 선다. 설정 톱니는 뺐다
          (2026-10-27 오너: 상단 라인이 애매하다). 빈 자리는 창 드래그 손잡이다. */}
      <div
        data-tauri-drag-region
        data-testid="settings-scope-slot"
        style={{
          gridColumn: 1,
          gridRow: 1,
          display: "flex",
          alignItems: "center",
          minWidth: 0,
          padding: "0 var(--space-4)",
        }}
      >
        {scope === "app" ? (
          <span
            data-testid="settings-scope-chip"
            data-scope="app"
            title={t("workspace.scope_app_hint")}
            style={chipStyle}
          >
            {t("workspace.scope_app_label")}
          </span>
        ) : (
          notebookName && <NotebookChip name={notebookName} icon={notebookIcon} activeId={activeWorkspaceId} disabled={busy} block />
        )}
      </div>
      {/* 본문 쪽 한 줄(그리드 1행 2열) — 안쪽 열이 아래 본문 열(settings-page-body)과 **같은 좌우 기하**를 쓴다:
          같은 maxWidth·같은 안쪽 여백·같은 캔버스 왼쪽 인셋·같은 스크롤바 자리(--settings-sb-w). 그래서 검색 카드는 정중앙이 아니라
          본문 열의 왼쪽 선에서 시작하고, 창 폭이 바뀌어도 두 줄이 같은 열을 따라 움직인다(settingsLayout.css). */}
      <header
        data-tauri-drag-region
        data-testid="settings-header"
        aria-label={t("settings.title")}
        className="settings-column-host"
        style={{
          gridColumn: 2,
          gridRow: 1,
          height: "var(--row-chrome)",
          position: "relative",
          display: "flex",
          alignItems: "center",
          minWidth: 0,
        }}
      >
        <div data-tauri-drag-region style={{ display: "flex", alignItems: "center", flex: 1, minWidth: 0 }}>
          <div
            ref={boxRef}
            className="settings-search-box"
            data-filled={query ? "" : undefined}
            style={{ position: "relative", minWidth: 0, zIndex: "var(--z-dropdown)" }}
          >
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={showList && results.length ? listboxId : undefined}
          aria-activedescendant={showList && results.length ? optionId(active) : undefined}
          data-testid="settings-search-input"
          placeholder={t("settings.search_placeholder")}
          aria-label={t("settings.search_placeholder")}
          className="field"
          style={{ width: "100%", minWidth: 0, boxSizing: "border-box" }}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => query && setOpen(true)}
          onBlur={close}
          onKeyDown={onInputKey}
        />
        {showList && (
          <div
            className="overlay"
            // 입력이 포커스를 잃지 않게 — 옵션을 눌러도 blur→닫힘이 click 보다 먼저 일어나지 않는다.
            onMouseDown={(e) => e.preventDefault()}
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              right: 0,
              marginTop: "var(--space-1)",
              padding: "var(--space-1)",
              maxHeight: 360,
              overflowY: "auto",
              boxShadow: "var(--shadow-lg)",
            }}
          >
            {results.length ? (
              <div id={listboxId} role="listbox" aria-label={t("settings.search_results_label")}>
                {results.map((r, i) => (
                  <div
                    key={`${r.entry.page}/${r.entry.anchor ?? r.entry.labelKey}`}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    data-selected={i === active}
                    data-testid={`settings-search-result-${r.entry.page}-${r.entry.anchor ?? "page"}`}
                    className="menu-row menu-item"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(r)}
                    style={{ justifyContent: "space-between", gap: "var(--space-4)", userSelect: "none" }}
                  >
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.match ? (
                        <>
                          {r.label.slice(0, r.match[0])}
                          <mark style={{ background: "var(--sel)", color: "inherit", borderRadius: "var(--radius-sm)" }}>
                            {r.label.slice(r.match[0], r.match[1])}
                          </mark>
                          {r.label.slice(r.match[1])}
                        </>
                      ) : (
                        r.label
                      )}
                    </span>
                    {r.label !== r.pageLabel && (
                      <span
                        style={{
                          flex: "none",
                          fontSize: "var(--text-xs)",
                          color: "var(--muted)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {r.group ? `${r.pageLabel} › ${r.group}` : r.pageLabel}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div
                role="status"
                data-testid="settings-search-empty"
                style={{ padding: "var(--space-3) var(--space-4)", fontSize: "var(--text-sm)", color: "var(--muted)" }}
              >
                {t("settings.search_no_results")}
              </div>
            )}
          </div>
        )}
      </div>
        </div>
      <div style={{ position: "absolute", right: "var(--space-4)", top: 0, bottom: 0, display: "flex", alignItems: "center" }}>
        {busy ? (
          // 되돌릴 수 없는 작업 중엔 닫지 못한다 — WindowCloseButton 은 disabled·title 을 받지 않아
          // 같은 클래스·아이콘의 비활성 버튼을 이 자리에만 둔다(ponytail: 그 부품이 disabled 를
          // 받게 되면 이 분기를 지운다).
          <button
            type="button"
            className="icon-btn icon-btn--danger"
            disabled
            title={t("settings.close_blocked_busy")}
            aria-label={`${t("window.close")} — ${t("settings.close_blocked_busy")}`}
            data-testid="settings-window-close"
          >
            <IconClose size={14} strokeWidth={2} />
          </button>
        ) : (
          <WindowCloseButton onClose={onClose} testId="settings-window-close" />
        )}
      </div>
      </header>
    </>
  );
}
