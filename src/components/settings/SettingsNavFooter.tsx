import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { t } from "../../i18n/t";
import { isBrowser } from "../../lib/env";

/**
 * 설정 좌측 레일 하단 상주 블록 — 버전만 (PLAN-2026-10-24 D2).
 *
 * 예전엔 여기에 [업데이트] 버튼과 [자동] 칩이 함께 있었다(PLAN-2026-09-12 E9). 둘은 일반 페이지 맨 위
 * 제품·업데이트 카드(ProductUpdateCard)로 이사했다 — 이름·버전·업데이트 상태·변경 요약·자동 확인이
 * 한 덩어리로 읽히고, 이 좁은 레일(168px)에서 칩이 두 줄로 접히던 문제도 사라진다. 업데이트가 있다는
 * 신호는 레일 "일반" 항목의 점이 맡는다. 버전은 앱의 신원이라 계속 레일에 상주한다.
 *
 * 동기화 웹 탭(isBrowser)에서는 `getVersion()` 이 의미가 없어 부르지 않는다 — 버전 줄은 비어 있다.
 */
export function SettingsNavFooter() {
  const [appVersion, setAppVersion] = useState("");
  const browser = isBrowser();

  useEffect(() => {
    if (browser) return;
    // silent-ok: 버전 표시는 선택적 — 못 읽으면 줄이 빈다.
    void getVersion().then(setAppVersion).catch(() => {});
  }, [browser]);

  return (
    <div
      data-testid="settings-nav-footer"
      aria-label={t("settings.version")}
      style={{
        marginTop: "auto",
        paddingTop: "var(--space-4)",
        fontSize: "var(--text-xs)",
        textAlign: "center",
        lineHeight: 1.4,
        color: "var(--muted)",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {appVersion ? `v${appVersion}` : null}
    </div>
  );
}
