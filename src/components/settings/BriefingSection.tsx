import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";
import { SettingsRow } from "./SettingsRow";
import { Badge } from "./Badge";
import { PageLead } from "./PageLead";
import { Toggle } from "./Toggle";
import { ScheduleWhenSection } from "./briefing/ScheduleWhenSection";
import { HabitsEditor } from "./briefing/HabitsEditor";
import { PhrasePacksSection } from "./PhrasePacksSection";

/**
 * 설정 > 브리핑(PLAN-2026-09-30-briefing W4, 펫 아래 플러그인 그룹 → PLAN-2026-10-19-briefing-rewrite §8).
 * 순서: ① 표시 시점 ② **문구**(대시보드 머리줄에서 브리핑 창 머리줄로 옮긴 문구의 팩 선택 — GRILL-2026-10-19
 * R4, 설정 › 대시보드에서 이사) ③ 습관. (반복 일정 표는 달력 및 일정 페이지에만 둔다.)
 *
 * 옛 "화면 구성은 브리핑 창의 편집에서…" 카드와 [편집으로 열기] 버튼은 블록 격자 편집기와 함께 사라졌다
 * (`briefing_window_open` 의 `edit` 인자도 은퇴, §9.1).
 *
 * 브라우저 모드 분기는 없다: 이 페이지 자체가 브라우저(태블릿) 목록에 없다(remoteSettingsPolicy
 * BROWSER_SETTINGS_PAGES, 창·습관 커맨드가 데스크톱 전용) — 그래서 `phrase_pack_save`(http:false) 의 AI 저장도
 * 여기선 언제나 동작한다.
 *
 * 반복 일정 표는 2026-10-28(PLAN-2026-10-27 §1) 에 이 페이지에서 뺐다 — "달력 및 일정" 페이지 한 곳에서만 편집한다
 * (같은 `timeline_routines` 를 달력의 하루 축이 읽는다).
 *
 * **브리핑이 꺼져 있으면** 브리핑에서만 쓰는 설정 — 표시 시점 카드의 행들과 문구 팩 행 — 은
 * `disabled` + 이유 툴팁("브리핑을 켜면…")으로 막는다. 습관·반복 일정 표는 막지 않는다: 반복 일정은
 * 달력의 하루 축이 함께 쓰고, 습관은 켜기 전에 미리 채워 둘 수 있는 데이터다.
 * 표 블록(습관)은 카드 밖 TableSection — 달력 및 일정 페이지와 같은 처리(R1).
 */
export function BriefingSection() {
  const enabled = useSettingsStore((s) => s.briefingEnabled);
  const setEnabled = useSettingsStore((s) => s.setBriefingEnabled);

  return (
    <>
      {/* 마스터 스위치는 페이지 첫 줄 설정 행(PLAN-2026-10-24 D4). */}
      <PageLead testId="settings-briefing-master-card">
        <SettingsRow
          anchor="briefing_enable"
          label={
            <>
              {t("settings.briefing_enable")} <Badge>{t("settings.sync_beta_badge")}</Badge>
            </>
          }
          control={
            <Toggle
              checked={enabled}
              onChange={(next) => void setEnabled(next)}
              aria-label={t("settings.briefing_enable")}
              data-testid="briefing-enabled-toggle"
            />
          }
        />
      </PageLead>
      <ScheduleWhenSection />
      <PhrasePacksSection disabled={!enabled} disabledReason={enabled ? undefined : t("settings.briefing_off_reason")} />
      <HabitsEditor />
      {/* 반복 일정 표는 2026-10-28(PLAN-2026-10-27 §1) 에 뺐다 — 달력 및 일정 페이지가 같은 데이터를 편집한다. */}
    </>
  );
}
