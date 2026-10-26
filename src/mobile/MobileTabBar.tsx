import { t } from "../i18n/t";
import { IconFolder, IconNote, IconSettings } from "../components/icons";
import type { Screen, TabScreen } from "./mobileScreens";
import { preloadIntentProps } from "../lib/lazyPreload";
import { MobileNote } from "../lazySurfaces";

interface MobileTabBarProps {
  /** The screen currently shown (tab or pushed). */
  screen: Screen;
  onTabClick: (tab: TabScreen) => void;
}

/**
 * Bottom tab bar: 노트(home) · 입력(capture) · 설정(settings). Pure presentation — every tap goes to
 * MobileApp's `onTabClick`, which owns the flush/leave-guard/history logic.
 * 2026-10-07 오너: 글자 라벨 없이 아이콘만(세 탭이라 아이콘으로 충분, 세로 공간을 본문에). 이름은
 * aria-label·title 로 남겨 화면 낭독기와 길게 누르기 툴팁이 그대로 읽는다.
 * 2026-10-16 오너: 가운데(입력)는 ＋가 아니라 노트 아이콘 — ＋는 목록의 둥근 추가 버튼과 겹쳤다.
 * 그래서 왼쪽(노트 목록 = 트리)은 폴더 아이콘으로 옮겼다.
 */
export function MobileTabBar({ screen, onTabClick }: MobileTabBarProps) {
  return (
    <div className="mobile-tabbar overlay">
      {/* "note" marks 노트 active too — the note screen is reached FROM the feed and lives under the
          same tab bar, so leaving it unlit would read as "no tab selected". Internal screen id
          stays "home". */}
      <button
        type="button"
        className="mobile-tab"
        data-active={screen === "home" || screen === "note"}
        onClick={() => onTabClick("home")}
        aria-label={t("mobile.tab_filter")}
        title={t("mobile.tab_filter")}
      >
        <span className="mobile-tab-icon">
          <IconFolder size={26} strokeWidth={2} />
        </span>
      </button>
      <button
        type="button"
        className="mobile-tab"
        data-active={screen === "capture"}
        {...preloadIntentProps(MobileNote)}
        onClick={() => onTabClick("capture")}
        aria-label={t("mobile.tab_capture")}
        title={t("mobile.tab_capture")}
      >
        <span className="mobile-tab-icon">
          <IconNote size={26} strokeWidth={2} />
        </span>
      </button>
      <button
        type="button"
        className="mobile-tab"
        data-active={screen === "settings"}
        onClick={() => onTabClick("settings")}
        aria-label={t("mobile.tab_settings")}
        title={t("mobile.tab_settings")}
      >
        <span className="mobile-tab-icon">
          <IconSettings size={26} strokeWidth={2} />
        </span>
      </button>
    </div>
  );
}
