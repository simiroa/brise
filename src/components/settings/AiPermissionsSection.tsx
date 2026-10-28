import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";
import { SubGroup } from "./SubGroup";
import { Toggle } from "./Toggle";
import { SwitchGrid, type SwitchGridItem } from "./SwitchGrid";
import { AiOffLink } from "./AiOffLink";
import { IconShield } from "../icons";
import { SettingsCard } from "./SettingsCard";

/**
 * 설정 > AI > 권한 (PLAN-2026-09-12 D8 — 권한 6종의 **유일한 거처**).
 *
 * 전에는 같은 키가 두 페이지에 그려졌다: `chat_write_enabled` 와 `collect_chat_register` 가
 * 여기와 "AI 채팅"의 "챗봇 권한" 카드에 각각 한 벌씩 있어서, 한쪽에서 끄고 다른 쪽을 열면
 * 같은 설정이 두 번 물어보는 것처럼 보였다. 이제 읽기 2 · 쓰기 2 · 안전장치 2 전부가 여기에만
 * 있고, "AI 채팅" 페이지는 페르소나·이름·사이드바 노출·대화 기억만 갖는다.
 *
 * **왜 한 격자가 아니라 하위 그룹 셋인가**(D3 의 "3개 이상이면 그리드"와 부딪히는 지점):
 * 여섯 개는 위험도가 같지 않다. 읽기는 되돌릴 게 없고, 쓰기는 노트를 실제로 바꾸며,
 * 안전장치는 그 쓰기를 감시하는 메타 스위치다. 이것들을 한 격자에 6칸으로 늘어놓으면 "적용 전
 * 확인"이 "파일 읽기" 옆에 같은 무게로 서서, 끄면 안 되는 것과 켜도 그만인 것이 구분되지 않는다.
 * 처음엔 카드 셋으로 갈랐으나 오너 QA(2026-09-15 R2 — "요소보다 타이틀이 많으면 묶어라")로
 * **카드 하나 안의 SubGroup 셋**이 됐다: 층은 하위 그룹의 제목·구분선이 지키고, 각 그룹 안에서는
 * 여전히 SwitchGrid 를 쓴다 — 오너 QA 가 지적한 "토글이 많은데 좌우로 시선이 분산된다"는
 * 격자가 아니라 우측 정렬이 만드는 문제라, 그룹이 2개짜리여도 같은 부품을 쓰는 쪽이 옳다.
 *
 * 마스터 스위치(`ai_enabled`)는 AI 제공자 페이지 첫 줄에만 있다(PLAN-2026-10-24 D7) — 이 페이지는
 * 꺼져 있을 때 거기로 가는 링크 한 줄(AiOffLink)만 보인다.
 *
 * 제목 줄 우측은 "외부 전송 N" 칩에서 **전체 토글**로 바뀌었다(2026-10-28 — 칩이 무엇을 세는지 알 수 없었다).
 */
interface AiPermissionsSectionProps {
  /** 꺼짐 링크(AiOffLink)가 AI 제공자 페이지로 가는 길. */
  onNavigate?: (page: string) => void;
}

/**
 * WCAG 2.5.3 (Label in Name) — **화면에 보이는 라벨은 접근 이름 안에 반드시 들어간다.**
 *
 * 격자 셀의 라벨을 짧게 줄이고 `ariaLabel` 로 원문을 따로 주면, 음성 제어 사용자가 화면에서
 * 읽은 그 단어("Register collect sources")로 컨트롤을 부를 수 없다 — 접근 이름이 전혀 다른
 * 문장이기 때문이다. 한국어 번역은 짧은 쪽이 긴 쪽의 부분 문자열이라 우연히 통과했고, en/fr
 * 에서만 깨져 있었다(예: "Log prompt text" ⊄ "Record prompt/response text in the AI call log").
 *
 * 그래서 접근 이름을 짧은 라벨 **접두**로 시작시켜 둘을 잇는다. 번역이 이미 화면 라벨을 품고
 * 있으면(ko) 그대로 두어 중복 낭독을 만들지 않는다.
 *
 * ponytail: 이 규칙의 제자리는 `SwitchGrid` 다 — 거기서 한 번 강제하면 모든 호출부가 지나간다.
 * 이번 웨이브에서 그 파일이 이 레인 밖이라 호출부에 둔다. 두 번째 사용처가 생기면 옮길 것.
 */
function nameWithVisibleLabel(visible: string, full: string): string {
  return full.includes(visible) ? full : `${visible} — ${full}`;
}

export function AiPermissionsSection({ onNavigate }: AiPermissionsSectionProps = {}) {
  const chatReadHistory = useSettingsStore((s) => s.chatReadHistory);
  const setChatReadHistory = useSettingsStore((s) => s.setChatReadHistory);
  const chatReadFiles = useSettingsStore((s) => s.chatReadFiles);
  const setChatReadFiles = useSettingsStore((s) => s.setChatReadFiles);
  const chatWriteEnabled = useSettingsStore((s) => s.chatWriteEnabled);
  const setChatWriteEnabled = useSettingsStore((s) => s.setChatWriteEnabled);
  const collectChatRegister = useSettingsStore((s) => s.collectChatRegister);
  const setCollectChatRegister = useSettingsStore((s) => s.setCollectChatRegister);
  const aiConfirmBeforeApply = useSettingsStore((s) => s.aiConfirmBeforeApply);
  const setAiConfirmBeforeApply = useSettingsStore((s) => s.setAiConfirmBeforeApply);
  const aiDebugVerbose = useSettingsStore((s) => s.aiDebugVerbose);
  const setAiDebugVerbose = useSettingsStore((s) => s.setAiDebugVerbose);
  const setSimplePrefs = useSettingsStore((s) => s.setSimplePrefs);

  // 전체 토글(2026-10-28): 읽기 2 + 쓰기 2 만 한꺼번에 켜고 끈다. 안전장치(적용 전 확인·로그 본문)는 권한이 아니라
  // 감시 스위치라 일괄 대상이 아니다 — 끄는 쪽이 위험한 것을 일괄로 켜지 않는다. 일부만 켜져 있으면 꺼진 쪽으로 보인다.
  const allGranted = chatReadHistory && chatReadFiles && chatWriteEnabled && collectChatRegister;
  // 키 넷을 한 번에 — IPC 한 번(settings_set { entries })·롤백 한 번(예전엔 각각 4번이었다).
  const setAllGranted = (next: boolean) =>
    setSimplePrefs({ chatReadHistory: next, chatReadFiles: next, chatWriteEnabled: next, collectChatRegister: next });

  /** 읽기 — AI 가 답을 만들기 전에 열어 보는 것. */
  const readItems: SwitchGridItem[] = [
    {
      id: "chat_read_history",
      anchor: "perm_chat_read_history",
      label: t("settings.chat_perm_read_history"),
      hint: t("settings.chat_perm_read_history_hint"),
      checked: chatReadHistory,
      onChange: (next) => void setChatReadHistory(next),
    },
    {
      id: "chat_read_files",
      anchor: "perm_chat_read_files",
      label: t("settings.chat_perm_read_files"),
      hint: t("settings.chat_perm_read_files_hint"),
      checked: chatReadFiles,
      onChange: (next) => void setChatReadFiles(next),
    },
  ];

  /** 쓰기 — AI 가 스스로 만들거나 바꿀 수 있는 것. 되돌리기가 읽기보다 비싸다. */
  const writeItems: SwitchGridItem[] = [
    {
      id: "chat_write_enabled",
      anchor: "perm_chat_write_enabled",
      label: t("settings.chat_perm_write_notes"),
      hint: t("settings.chat_perm_write_notes_hint"),
      checked: chatWriteEnabled,
      onChange: (next) => void setChatWriteEnabled(next),
    },
    {
      // 격자 셀은 좁다(본문 760px 기준 셀당 ≈301px = 영문 48자쯤). 라벨은 이제 잘리지 않고 줄바꿈하지만
      // (SwitchGrid, 2026-10-18) 원문은 서너 줄로 늘어나 격자의 행 높이를 흔들므로 화면에는 짧은 쪽을 쓴다.
      // 원문은 버리지 않고 접근 이름으로 잇는다 — 다만 **짧은 라벨을 접두로** 두어야 음성 제어가 동작한다.
      id: "collect_chat_register",
      anchor: "perm_collect_chat_register",
      label: t("settings.ai_perm_collect_register_short"),
      ariaLabel: nameWithVisibleLabel(
        t("settings.ai_perm_collect_register_short"),
        t("settings.chat_perm_collect_register"),
      ),
      hint: t("settings.chat_perm_collect_register_hint"),
      checked: collectChatRegister,
      onChange: (next) => void setCollectChatRegister(next),
    },
  ];

  /** 안전장치 — 위 둘이 한 일을 확인·기록하는 메타 스위치. */
  const safetyItems: SwitchGridItem[] = [
    {
      // PLAN-2026-09-05 §2 B-4: 어시스트 결과 프리뷰 게이트 킬 스위치.
      id: "ai_confirm_before_apply",
      anchor: "perm_ai_confirm_before_apply",
      label: t("settings.ai_confirm_before_apply"),
      hint: t("settings.ai_confirm_before_apply_hint"),
      checked: aiConfirmBeforeApply,
      onChange: (next) => void setAiConfirmBeforeApply(next),
    },
    {
      // PLAN-2026-09-05 §3 C-3: 호출 로그 본문 동봉 — 노트 내용이 로그 파일에 남는다. 기본 OFF.
      id: "ai_debug_verbose",
      anchor: "perm_ai_debug_verbose",
      label: t("settings.ai_perm_debug_verbose_short"),
      ariaLabel: nameWithVisibleLabel(
        t("settings.ai_perm_debug_verbose_short"),
        t("settings.ai_debug_verbose"),
      ),
      hint: t("settings.ai_debug_verbose_hint"),
      checked: aiDebugVerbose,
      onChange: (next) => void setAiDebugVerbose(next),
    },
  ];

  return (
    <>
      <AiOffLink onNavigate={onNavigate} />

      {/* R2 (오너 QA 2026-09-15): 카드 셋 → 카드 하나 + SubGroup 셋. 위험도 층은 하위 그룹의
          제목·구분선이 지킨다. 카드는 페이지 최상위 형제라 페이지 간격이 그대로 먹는다. */}
      <SettingsCard
        title={t("settings.page_ai_permissions")}
        hint={t("settings.ai_perm_master_hint")}
        icon={<IconShield size={14} strokeWidth={2} />}
        actions={
          <Toggle
            checked={allGranted}
            onChange={(next) => void setAllGranted(next)}
            aria-label={t("settings.ai_perm_master")}
            data-testid="ai-permissions-master"
          />
        }
        testId="settings-ai-permissions"
      >
        {/* 외부 전송 요약은 첫 카드 제목 줄의 Badge 하나로(PLAN-2026-09-15 W3, D4). 개별 스위치는
            AiCapabilityCatalog 에 있다 — 이 숫자는 "지금 밖으로 나가는 채널이 총 몇 개인가"의 한 줄 요약이다. */}


        <SubGroup
          title={t("settings.ai_perm_read_title")}
          hint={t("settings.ai_perm_read_hint")}
          data-testid="settings-ai-permissions-read"
        >
          <SwitchGrid
            items={readItems}
            aria-label={t("settings.ai_perm_read_title")}
            data-testid="ai-permissions-read-grid"
          />
        </SubGroup>

        <SubGroup
          title={t("settings.ai_perm_write_title")}
          hint={t("settings.ai_perm_write_hint")}
          divider
          data-testid="settings-ai-permissions-write"
        >
          <SwitchGrid
            items={writeItems}
            aria-label={t("settings.ai_perm_write_title")}
            data-testid="ai-permissions-write-grid"
          />
        </SubGroup>

        <SubGroup
          title={t("settings.ai_perm_safety_title")}
          hint={t("settings.ai_perm_safety_hint")}
          divider
          data-testid="settings-ai-permissions-safety"
        >
          <SwitchGrid
            items={safetyItems}
            aria-label={t("settings.ai_perm_safety_title")}
            data-testid="ai-permissions-safety-grid"
          />
        </SubGroup>
      </SettingsCard>
    </>
  );
}
