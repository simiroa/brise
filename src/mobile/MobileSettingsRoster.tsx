import { useSettingsStore, type FilterRosterEntry } from "../stores/settings";
import { t } from "../i18n/t";
import { IconCaret } from "../components/icons";
import { ROSTER_ICON, ROSTER_LABEL_KEY } from "../components/leftpanel/yearfilter/shared";
import { isPhoneUnavailableMode } from "./phoneRoster";

/**
 * 설정 tab · 보기 section — 사이드바 구성(`filter_roster`): an on/off switch plus 위/아래 buttons per
 * view. Desktop's FilterRosterStrip (segment strip + drag, `touchAction: "none"`) is deliberately
 * not ported — a phone has no hover and no precise drag (WORKORDER-2026-09-02 W4 §3). Icons and
 * labels come from the single source in leftpanel/yearfilter/shared (ROSTER_ICON/ROSTER_LABEL_KEY).
 * The key is shared with desktop, so a change here shows up there and vice versa.
 */
export function MobileSettingsRoster() {
  const filterRoster = useSettingsStore((s) => s.filterRoster);
  const setFilterRoster = useSettingsStore((s) => s.setFilterRoster);

  // 사이드바 구성(filter_roster) — on/off + 위/아래 이동. "tree"는 로스터 밖의 상시 기본 뷰라
  // 대상이 아니다(stores/settings.ts 주석과 동일한 판단, 데스크톱 FilterRosterStrip과 동일).
  const enabledRosterCount = filterRoster.filter((e) => e.enabled).length;
  const toggleRoster = (entry: FilterRosterEntry) => {
    // 마지막 켜진 항목은 끄지 않는다 — setFilterRoster 자체도 ensureOneEnabled로 한 번 더 막지만,
    // 그건 index 0을 강제로 되살리므로(탭한 행이 아닐 수 있음) 여기서 조용히 막는 편이 낫다.
    // ponytail: 데스크톱 FilterRosterStrip의 shake 애니메이션은 옮기지 않았다 — 이 가드만으로
    // 이미 "마지막 하나는 못 끈다"는 정답 동작은 보장된다. 이유가 안 보이는 게 아쉬우면 그 때
    // 흔들림을 추가.
    if (entry.enabled && enabledRosterCount <= 1) return;
    void setFilterRoster(
      filterRoster.map((e) => (e.mode === entry.mode ? { ...e, enabled: !e.enabled } : e)),
    );
  };
  const moveRoster = (index: number, dir: -1 | 1) => {
    const to = index + dir;
    if (to < 0 || to >= filterRoster.length) return;
    const next = [...filterRoster];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved);
    void setFilterRoster(next);
  };

  return (
    <div className="mobile-settings-section">
      <div className="mobile-settings-section-label label-caps">{t("settings.dashboard_sidebar")}</div>
      <div className="mobile-settings-section-hint">{t("settings.dashboard_sidebar_hint")}</div>
      {filterRoster.map((entry, index) => {
        const label = t(ROSTER_LABEL_KEY[entry.mode]);
        const phoneUnavailable = isPhoneUnavailableMode(entry.mode);
        return (
          <div key={entry.mode}>
            <div
              className="mobile-settings-row"
              data-testid={`mobile-settings-roster-${entry.mode}`}
            >
              <span className="mobile-roster-label">
                {ROSTER_ICON[entry.mode]}
                {label}
              </span>
              <span className="mobile-settings-value">
                <button
                  type="button"
                  className="mobile-icon-btn"
                  disabled={index === 0}
                  aria-label={t("mobile.roster_move_up", { label })}
                  onClick={() => moveRoster(index, -1)}
                >
                  <IconCaret dir="up" size={16} />
                </button>
                <button
                  type="button"
                  className="mobile-icon-btn"
                  disabled={index === filterRoster.length - 1}
                  aria-label={t("mobile.roster_move_down", { label })}
                  onClick={() => moveRoster(index, 1)}
                >
                  <IconCaret dir="down" size={16} />
                </button>
                <input
                  type="checkbox"
                  role="switch"
                  className="mobile-switch"
                  checked={entry.enabled}
                  aria-label={label}
                  onChange={() => toggleRoster(entry)}
                />
              </span>
            </div>
            {phoneUnavailable && (
              <div className="mobile-settings-section-hint" data-testid={`mobile-settings-roster-hint-${entry.mode}`}>
                {t("mobile.roster_unavailable_here")}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
