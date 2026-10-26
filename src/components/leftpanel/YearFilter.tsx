import React, { useEffect, useMemo, useRef } from "react";
import { useNotesStore } from "../../stores/notes";
import { useSearchStore, type YearFilterMode } from "../../stores/search";
import { useSettingsStore, type RosterMode } from "../../stores/settings";
import { t } from "../../i18n/t";
import { useYearBounds, IconModeTree, ROSTER_ICON, ROSTER_LABEL_KEY } from "./yearfilter/shared";
import { FluidHoverHighlight, useFluidHover } from "../common/FluidHover";

export function YearFilter() {
  // Scale quick-win (docs/SCALABILITY.md §Phase 0): read the store's maintained totalNotes
  // counter instead of flattening notesByFolder here — that flatten used to re-run on every
  // notes-store set() (title/body keystrokes included), an O(corpus) scan per keystroke.
  const totalNotes = useNotesStore((s) => s.totalNotes);
  const disabled = totalNotes === 0;

  const yearFrom = useSearchStore((s) => s.yearFrom);
  const yearTo = useSearchStore((s) => s.yearTo);
  const { min: MIN_YEAR, max: MAX_YEAR } = useYearBounds();
  const setYearRange = useSearchStore((s) => s.setYearRange);

  const filterMode = useSearchStore((s) => s.filterMode);
  const setFilterMode = useSearchStore((s) => s.setFilterMode);
  const filterRoster = useSettingsStore((s) => s.filterRoster);
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);

  const stripRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(stripRef, {
    axis: "x",
    itemSelector: "[data-fh-item]",
    from: () => stripRef.current?.querySelector('[data-active="true"]'),
  });

  useEffect(() => {
    if (disabled && (yearFrom !== MIN_YEAR || yearTo !== MAX_YEAR)) {
      setYearRange(MIN_YEAR, MAX_YEAR);
    }
  }, [disabled, yearFrom, yearTo, MIN_YEAR, MAX_YEAR, setYearRange]);

  // Visible roster tabs: chat only when AI is on (plan S4). 브라우저(/app)도 이제 채팅을 쓴다 —
  // 사이드바 채팅 코어 pet_* 가 http:true 가 됐다(오너 결정 2026-10-06, specs/commands/pet.yaml).
  const visibleRoster = useMemo(
    () =>
      filterRoster.filter((r) => {
        if (!r.enabled) return false;
        if (r.mode === "chat" && !aiEnabled) return false;
        return true;
      }),
    [filterRoster, aiEnabled],
  );
  const enabledModes = useMemo(
    () => visibleRoster.map((r) => r.mode),
    [visibleRoster],
  );

  const allVisibleModes = useMemo(
    () => ["tree" as YearFilterMode, ...visibleRoster.map((r) => r.mode as YearFilterMode)],
    [visibleRoster],
  );
  const activeIdx = allVisibleModes.indexOf(filterMode);

  // §2.4: a mode the user just disabled in settings must not stay silently active with no
  // visible tab to select it — same "no dead-end filter" rule §2.2 applies to date clicks.
  // AI off while on chat → fall back to tree.
  useEffect(() => {
    if (filterMode === "tree") return;
    if (filterMode === "chat" && !aiEnabled) {
      setFilterMode("tree");
      return;
    }
    if (!enabledModes.includes(filterMode as RosterMode)) {
      setFilterMode("tree");
    }
  }, [filterMode, enabledModes, aiEnabled, setFilterMode]);

  const seg = (
    mode: YearFilterMode,
    label: string,
    icon: React.ReactNode,
    borderLeft?: boolean,
    segDisabled?: boolean,
  ) => {
    const on = filterMode === mode;
    return (
      <button
        type="button"
        key={mode}
        onClick={() => setFilterMode(mode)}
        disabled={segDisabled}
        title={label}
        aria-label={label}
        aria-pressed={on}
        data-testid={`view-tab-${mode}`}
        data-fh-item="true"
        data-active={on ? "true" : undefined}
        style={{
          position: "relative",
          zIndex: 1,
          flex: "1 1 auto",
          minWidth: 0,
          display: "grid",
          placeItems: "center",
          padding: "var(--space-2) var(--space-1)",
          cursor: segDisabled ? "default" : "pointer",
          border: "none",
          borderLeft: borderLeft ? "1px solid var(--line)" : "none",
          background: "transparent",
          color: on ? "var(--on-accent)" : "var(--muted)",
          opacity: segDisabled ? 0.5 : 1,
          transition: "color var(--dur-fast) ease",
        }}
      >
        {icon}
      </button>
    );
  };

  return (
    <div style={{ position: "relative" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          marginTop: "var(--space-2)",
        }}
      >
        {/* View switcher: tree (always shown) + the enabled subset of the filter roster
            (§2.4 HANDOFF-calendar-onboarding.md), in the user's saved order. `disabled` (no notes
            in the workspace) only dims/blocks the roster tabs — they need notes to be meaningful.
            Tree stays clickable regardless: it's the safe fallback view (shows the "workspace
            empty" state, rows.ts::empty_workspace), and disabling it too would trap a user who's
            sitting on a non-tree tab when the last note is deleted, with no way back (2026-09-03
            owner repro: delete the note you're viewing in Timeline → tree tab stops responding).
            [Design Rule 2026-09-11]: 라인글로우(icon-btn--glow)는 편집·기능 조작 아이콘 레벨에 적용하며,
            이 뷰 스위처처럼 '화면 전환' 수준의 큰 네비게이션 컨트롤에는 이 효과를 적용하지 않고 기존 구조를 유지한다. */}
        <div
          ref={stripRef}
          role="group"
          aria-label={t("search.view_switcher")}
          className="fh-host"
          {...hover.handlers}
          style={{
            position: "relative",
            flex: 1,
            display: "flex",
            flexWrap: "nowrap",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-sm)",
            overflow: "hidden",
          }}
        >
          <FluidHoverHighlight hover={hover} />
          {activeIdx >= 0 && (
            <div
              aria-hidden
              data-testid="view-switcher-indicator"
              className="view-tab-indicator"
              style={{
                width: `${100 / allVisibleModes.length}%`,
                transform: `translateX(${activeIdx * 100}%)`,
              }}
            />
          )}
          {seg("tree", t("search.mode_tree"), <IconModeTree />)}
          {visibleRoster.map((r) =>
            seg(r.mode, t(ROSTER_LABEL_KEY[r.mode]), ROSTER_ICON[r.mode], true, disabled),
          )}
        </div>
      </div>
    </div>
  );
}
