import { useEffect, useMemo } from "react";
import { useSearchStore, type YearFilterMode } from "../stores/search";
import { useSettingsStore } from "../stores/settings";
import { t } from "../i18n/t";
import { IconModeTree, ROSTER_ICON, ROSTER_LABEL_KEY } from "../components/leftpanel/yearfilter/shared";
import { isPhoneUnavailableMode } from "./phoneRoster";
import { preloadIntentProps } from "../lib/lazyPreload";
import { RegionExpanded, WorldMapGL } from "../lazySurfaces";

/**
 * Mobile mirror of leftpanel/YearFilter.tsx's view-switcher segment — same roster
 * (`useSettingsStore.filterRoster`), same order, same icons/labels (ROSTER_ICON/ROSTER_LABEL_KEY,
 * imported not copied — a second copy is exactly what check:clones exists to catch), same
 * `data-testid="view-tab-${mode}"` so anything asserting on the desktop testid works here too.
 *
 * Excluded modes (chat D7, region D6) live in phoneRoster.ts — Settings reads the same set.
 */
export function MobileViewSwitcher() {
  const filterRoster = useSettingsStore((s) => s.filterRoster);
  const filterMode = useSearchStore((s) => s.filterMode);
  const setFilterMode = useSearchStore((s) => s.setFilterMode);
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);

  const visibleRoster = useMemo(
    () => filterRoster.filter((r) => r.enabled && !isPhoneUnavailableMode(r.mode, aiEnabled)),
    [filterRoster, aiEnabled],
  );

  // A shared filterMode the phone can't show (excluded, or chat with AI off) would otherwise render
  // the unavailable notice with no tab to leave it.
  useEffect(() => {
    if (isPhoneUnavailableMode(filterMode, aiEnabled)) setFilterMode("tree");
  }, [filterMode, setFilterMode, aiEnabled]);

  const seg = (mode: YearFilterMode, label: string, icon: React.ReactNode) => {
    const on = filterMode === mode;
    return (
      <button
        key={mode}
        type="button"
        className="mobile-view-switcher-tab"
        data-active={on}
        onClick={() => setFilterMode(mode)}
        title={label}
        aria-label={label}
        aria-pressed={on}
        data-testid={`view-tab-${mode}`}
        // 지역 보기만 지연 로드다 — 그 안의 지도(WorldMapGL)도 자기 경계라 같이 받는다(폰은 유휴 미리 받기가 없다).
        {...(mode === "region" ? preloadIntentProps(RegionExpanded, WorldMapGL) : {})}
      >
        {icon}
      </button>
    );
  };

  return (
    <div className="mobile-view-switcher scroll" role="group" aria-label={t("search.view_switcher")}>
      {seg("tree", t("search.mode_tree"), <IconModeTree />)}
      {visibleRoster.map((r) => seg(r.mode, t(ROSTER_LABEL_KEY[r.mode]), ROSTER_ICON[r.mode]))}
    </div>
  );
}
