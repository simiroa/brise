import { useState, useEffect } from "react";
import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";
import { groupCardStyle, SETTINGS_CTRL_WIDTH } from "./shared";
import { SubGroup } from "./SubGroup";
import { SettingsRow } from "./SettingsRow";
import { Toggle } from "./Toggle";
import { ChatMemorySection } from "./ChatMemorySection";
import { PetPersonaSection } from "./PetPersonaSection";
import { AiOffLink } from "./AiOffLink";

/**
 * 설정 > AI > 채팅
 * 어시스턴트 프로필, 사이드바 노출 여부, 권한 링크, 대화 기억.
 *
 * 권한 토글은 여기 두지 않는다 — 'AI 권한 열기' 링크가 AI > 권한(ai_permissions) 한 곳으로 보낸다.
 * 히어로엔 배지를 두지 않는다 — 페르소나·사이드바 노출은 바로 아래 행이 이미 보여 준다(같은 값을 두 번
 * 그리지 않는다).
 */

export interface AiChatSectionProps {
  onNavigate?: (page: string) => void;
}

export function AiChatSection({ onNavigate }: AiChatSectionProps = {}) {
  const userName = useSettingsStore((s) => s.userName);
  const setUserName = useSettingsStore((s) => s.setUserName);

  const filterRoster = useSettingsStore((s) => s.filterRoster);
  const setFilterRoster = useSettingsStore((s) => s.setFilterRoster);
  const isSidebarChatEnabled = filterRoster.find((r) => r.mode === "chat")?.enabled ?? true;

  const [nameInput, setNameInput] = useState(userName);

  useEffect(() => {
    setNameInput(userName);
  }, [userName]);

  const saveUserName = () => {
    if (nameInput !== userName) {
      void setUserName(nameInput);
    }
  };

  const toggleSidebarChat = (enabled: boolean) => {
    const next = filterRoster.map((r) => (r.mode === "chat" ? { ...r, enabled } : r));
    void setFilterRoster(next);
  };

  return (
    <>

      <AiOffLink onNavigate={onNavigate} />

      {/* 오너 R1(2026-09-15): 최상위 블록은 fragment 형제 — 페이지 간격은 SettingsPanel 이 준다. */}
      {/* 1. 어시스턴트 / 프로필 — SubGroup 2개 (PLAN-2026-09-15 W3). 카드 제목은 두지 않는다 —
          페이지 아이콘은 히어로가 들고, "페르소나" 글자는 첫 SubGroup 안의 행 라벨 한 번뿐이다. */}
      <div className="card" style={groupCardStyle} data-testid="settings-ai-chat-persona-card">
        <PetPersonaSection />

        <SubGroup title={t("settings.chat_group_profile")} divider data-testid="settings-ai-chat-profile">
          <SettingsRow
            anchor="user_name"
            label={t("settings.user_name")}
            hint={t("settings.chat_user_name_hint")}
            control={
              <input
                type="text"
                className="field"
                style={{ width: SETTINGS_CTRL_WIDTH, textAlign: "right" }}
                placeholder={t("settings.user_name_placeholder")}
                maxLength={64}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onBlur={saveUserName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
            }
          />

          <SettingsRow
            anchor="ai_chat_sidebar_visible"
            label={t("settings.ai_chat_sidebar_visible")}
            hint={t("settings.ai_chat_sidebar_visible_hint")}
            control={
              <Toggle
                checked={isSidebarChatEnabled}
                onChange={toggleSidebarChat}
                aria-label={t("settings.ai_chat_sidebar_visible")}
                data-testid="settings-ai-chat-sidebar-toggle"
              />
            }
          />
        </SubGroup>
      </div>

      {/* 2. 권한 링크 — 챗봇 권한 설정은 AI > 권한 페이지로 안내 */}
      {onNavigate && (
        <div className="card" style={groupCardStyle} data-testid="settings-ai-chat-permissions-card">
          <SettingsRow
            anchor="chat_permissions"
            label={t("settings.chat_permissions")}
            hint={t("settings.chat_permissions_hint")}
            control={
              <button
                type="button"
                className="btn"
                data-testid="settings-ai-chat-permissions-link"
                onClick={() => onNavigate("ai_permissions")}
              >
                {t("settings.chat_permissions_open")}
              </button>
            }
          />
        </div>
      )}

      {/* 3. 대화 기억 — 제목 행 / 컨트롤 카드 / 게이지 / 표를 스스로 fragment 로 돌려준다. */}
      <ChatMemorySection />
    </>
  );
}
