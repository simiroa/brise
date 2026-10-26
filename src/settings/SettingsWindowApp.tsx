import { SettingsPanel } from "../components/SettingsPanel";
import { AuxWindowChrome, closeCurrentAuxWindow } from "../components/AuxWindowChrome";
import { ErrorBoundary } from "../components/common/ErrorBoundary";
import { t } from "../i18n/t";

/**
 * 설정 창(#/settings)의 루트. 별도 OS 창인 이유는 src-tauri/src/aux_window.rs 참고.
 *
 * 풀 설정 스토어를 그대로 부팅한다 — 설정 화면 자체가 그 스토어의 소비자이자 생산자다.
 * 노트 트리·에디터·동기화 클라이언트는 부팅하지 않는다(main.tsx 가 이 분기에서 App 을
 * 동적 import 하지 않는다).
 */
export function SettingsWindowApp() {
  return (
    // PLAN-2026-09-15 D10: 타이틀 스트립 없음 — 제목은 SettingsNav 맨 위, 닫기는 SettingsPanel 본문 우상단.
    <AuxWindowChrome title={t("settings.title")} closeTestId="settings-window-close" hideHeader>
      {/* W13: boundary sits outside SettingsPanel — this window's ONLY content is settings, so
          without it any render crash inside a section leaves a blank OS window with just chrome
          around it and no way to tell what happened. */}
      <ErrorBoundary fallbackTitle={t("common.boundary_settings")}>
        <SettingsPanel onClose={closeCurrentAuxWindow} />
      </ErrorBoundary>
    </AuxWindowChrome>
  );
}
