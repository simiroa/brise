import { useState } from "react";
import { resolveResource } from "@tauri-apps/api/path";
import { openPath } from "@tauri-apps/plugin-opener";
import { t } from "../../i18n/t";
import { isBrowser } from "../../lib/env";
import { MetricTileGroup } from "./MetricTileGroup";
import { IconScale, IconFile, IconWrench, IconArchive, IconExternalLink } from "../icons";
import { IconAction } from "./IconAction";
import summary from "../../lib/noticesSummary.json";
import { SettingsCard } from "./SettingsCard";

/**
 * 설정 > 라이선스 (PLAN-2026-09-01 §1, 오너 결정 D5).
 *
 * 2026-09-02 개정: 전문(`src-tauri/resources/THIRD-PARTY-NOTICES.html`, 2.8MB)을 창 안
 * iframe 으로 렌더하던 것을 걷어냈다. 그 문서는 자기 `<style>` 로 흰 배경을 칠하므로 다크 테마
 * 위에서 **혼자 밝은 판**으로 떴고(오너 지적), 페이지를 열 때마다 2.8MB 를 웹뷰에 물렸으며,
 * 문서 로드 실패는 iframe `onError` 로 잡히지도 않아 폴백이 사실상 죽어 있었다.
 *
 * 대신 요약만 앱 토큰으로 그리고 전문은 OS 기본 브라우저로 넘긴다 — 고지 의무는 "전문을 제공"
 * 하는 것이지 "앱 안에서 렌더"하는 게 아니다. 수치는 `src/lib/noticesSummary.json` 이 SSOT 이고,
 * 전문과 같은 실행(`npm run gen:notices`)에서 함께 쓰여 갈리지 않는다.
 *
 * 오너 R1(2026-09-15): 통계 타일은 카드에 넣지 않는다 — 타일이 카드의 전부였으므로 카드와
 * 그 SectionHeader 는 사라지고(히어로가 이미 페이지를 이름한다), "전문 열기"는 히어로 actions.
 */
export function LicenseSection() {
  const browser = isBrowser();
  const [failed, setFailed] = useState(false);

  const handleOpen = async () => {
    if (browser) return; // 동기화 웹 탭엔 리소스 파일이 없다 — 조용한 무동작(버전/업데이트와 같은 관례).
    try {
      // ponytail: capture.rs 의 extension_dir() 가 이미 문서화한 한계와 동일 — `tauri dev` 에서는
      // resource_dir() 에 bundle.resources 가 아직 안 복사돼 있을 수 있다. 패키지된 설치본에서는
      // 정상 동작한다. 실패는 조용히 삼키지 않고 아래 한 줄로 알린다(예전 iframe 폴백이 죽어
      // 있던 이유가 "조용한 실패"였다).
      await openPath(await resolveResource("THIRD-PARTY-NOTICES.html"));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };

  return (
    <>
      <MetricTileGroup
        testId="settings-license-tiles"
        columns={summary.noTextTotal > 0 ? 3 : 2}
        tiles={[
          { id: "npm", icon: <IconFile size={16} />, value: summary.npmTotal, label: t("settings.license_tile_npm") },
          { id: "rust", icon: <IconWrench size={16} />, value: summary.rustTotal, label: t("settings.license_tile_rust") },
          ...(summary.noTextTotal > 0
            ? [
                {
                  id: "notext",
                  icon: <IconArchive size={16} />,
                  value: summary.noTextTotal,
                  label: t("settings.license_tile_notext"),
                },
              ]
            : []),
        ]}
      />

      {/* 외부 열기 버튼은 카드 제목 줄로(PLAN-2026-10-24 D4). F7(PLAN-2026-09-15): 브라우저 탭엔 리소스 파일이
          없다 — 조용히 아무 일도 안 하던 버튼을 끄고 이유를 툴팁으로 말한다(다른 페이지 관례 그대로). */}
      <SettingsCard
        title={t("settings.page_license")}
        icon={<IconScale size={14} strokeWidth={2} />}
        actions={
          <IconAction
            icon={<IconExternalLink size={16} />}
            label={t("settings.license_open_external")}
            titleOverride={browser ? t("common.desktop_only") : undefined}
            data-testid="settings-open-licenses-btn"
            disabled={browser}
            onClick={() => void handleOpen()}
          />
        }
        testId="settings-license-card"
      >
        {failed && (
          <p
            data-testid="settings-license-open-failed"
            style={{ fontSize: "var(--text-xs)", color: "var(--danger)", margin: 0 }}
          >
            {t("settings.license_open_failed")}
          </p>
        )}
        <p
          data-testid="settings-license-generated"
          style={{ fontSize: "var(--text-xs)", color: "var(--muted)", margin: 0 }}
        >
          {t("settings.license_generated_at", { date: summary.generatedAt })}
        </p>
      </SettingsCard>

      {/* 한컴 공개 문서 고지 — HWPX 가져오기·내보내기가 한컴의 공개 문서를 참고해 만들어졌다는 고지 조건
          (docs/research/doc-format-compat-2026-10-07.md §6.7). ko 문구는 스펙 PDF("글 문서 파일 형식 5.0" 저작권 안내)가 요구한
          문장 그대로이고(테스트가 글자 단위로 고정한다), en/fr 은 그 뜻의 번역이다. */}
      <p
        data-testid="settings-license-hancom"
        style={{ fontSize: "var(--text-xs)", color: "var(--muted)", margin: 0 }}
      >
        {t("settings.license_hancom_notice")}
      </p>
    </>
  );
}
