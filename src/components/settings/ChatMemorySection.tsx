import { useState } from "react";
import { useSettingsStore, CHAT_MEMORY_MAX_ITEMS } from "../../stores/settings";
import { emitNotice } from "../../lib/invoke";
import { t } from "../../i18n/t";
import { IconHistory, IconPlus, IconTrash } from "../icons";
import { IconAction } from "./IconAction";
import { groupCardStyle } from "./shared";
import { SectionHeader } from "./SectionHeader";
import { SettingsRow } from "./SettingsRow";
import { Toggle } from "./Toggle";
import { SettingsTable, SettingsTableRow } from "./SettingsTable";
import { StorageGauge } from "./StorageGauge";
import { useFeatureBriefTrigger } from "../../lib/useFeatureBrief";
import { formatRelativeTime } from "../../lib/dateUtils";

/**
 * 챗봇 대화 기억 (chat_memory) 및 자동 추출 통합 섹션.
 * 챗 메모리 자동 추출 토글, 직접 기억 추가, 표 형태의 기억 목록을 일체화하여 제공.
 *
 * 오너 R1(2026-09-15): 카드는 컨트롤(토글·추가 입력)만 담는다. 용량 게이지와 목록 표는 카드
 * 밖 페이지 최상위 형제로 두고, 제목 행(SectionHeader)은 이 영역 전체를 이름한다.
 * 최상위 블록을 fragment 로 돌려주므로 부모(AiChatSection)의 페이지 간격이 그대로 먹는다.
 */
export function ChatMemorySection() {
  const chatMemory = useSettingsStore((s) => s.chatMemory);
  const addChatMemory = useSettingsStore((s) => s.addChatMemory);
  const removeChatMemory = useSettingsStore((s) => s.removeChatMemory);
  const lang = useSettingsStore((s) => s.uiLang);

  const aiChatMemory = useSettingsStore((s) => s.aiChatMemory);
  const setAiChatMemory = useSettingsStore((s) => s.setAiChatMemory);
  const notifyFeatureBrief = useFeatureBriefTrigger();

  const [inputText, setInputText] = useState("");

  const handleAdd = async () => {
    const trimmed = inputText.trim();
    if (!trimmed) return;
    const added = await addChatMemory(trimmed);
    if (added) {
      setInputText("");
      return;
    }
    // F8(PLAN-2026-09-15): 같은 문장이면 스토어가 false 를 돌려준다 — 아무 말도 없으면 버튼이
    // 고장난 것처럼 보인다. 입력은 그대로 두고(고쳐 쓰라고) 이유만 한 줄 띄운다.
    emitNotice(t("settings.chat_memory_duplicate"));
  };

  const atCapacity = chatMemory.length >= CHAT_MEMORY_MAX_ITEMS;
  // PLAN-2026-09-15 W3: 용량 게이지 — 마지막 추가 시각은 created_at 최댓값(목록 순서에 기대지 않는다).
  const lastAdded = chatMemory.reduce<string | null>(
    (acc, m) => (m.created_at && (!acc || m.created_at > acc) ? m.created_at : acc),
    null,
  );

  return (
    <>
      <div className="card" style={groupCardStyle} data-testid="settings-chat-memory-section">
        <SectionHeader
          title={t("settings.chat_memory_title")}
          hint={t("settings.chat_memory_hint")}
          icon={<IconHistory size={14} strokeWidth={2} />}
        />
        {/* 1. 자동 기억 추출 토글 */}
        <SettingsRow
          anchor="ai_chat_memory"
          label={t("aiCapabilities.ai_chat_memory_name")}
          hint={t("aiCapabilities.ai_chat_memory_reads")}
          control={
            <Toggle
              checked={aiChatMemory}
              onChange={(next) => {
                notifyFeatureBrief("ai_chat_memory", aiChatMemory, next);
                void setAiChatMemory(next);
              }}
              aria-label={t("aiCapabilities.ai_chat_memory_name")}
              data-testid="settings-ai-chat-memory-toggle"
            />
          }
        />

        {/* 2. 기억 추가 입력 바 — 자동 추출 토글 ↔ 직접 추가는 카드 안의 서로 다른 하위 그룹이다.
            D2 가 남긴 선 하나(`--divider`)를 쓴다. */}
        <div
          style={{
            display: "flex",
            gap: "var(--space-2)",
            marginTop: "var(--space-4)",
            paddingTop: "var(--space-4)",
            borderTop: "1px solid var(--divider)",
          }}
        >
          <input
            type="text"
            className="field"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              // 한글 조합 중의 Enter 는 글자를 확정하는 키다 — 그때 추가하면 마지막 글자가 빠지거나 두 번 들어간다.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void handleAdd();
              }
            }}
            placeholder={t("settings.chat_memory_placeholder")}
            maxLength={200}
            disabled={atCapacity}
            aria-describedby={atCapacity ? "settings-chat-memory-full" : undefined}
            data-testid="settings-chat-memory-input"
            style={{ flex: 1, minWidth: 0 }}
          />
          <IconAction
            icon={<IconPlus size={16} />}
            label={t("settings.chat_memory_add")}
            size="lg"
            onClick={() => void handleAdd()}
            disabled={!inputText.trim() || atCapacity}
            data-testid="settings-chat-memory-add-btn"
          />
        </div>
        {/* 가득 차면 입력이 잠긴다 — 왜 잠겼는지, 어떻게 풀리는지를 그 아래 한 줄로 말한다. */}
        {atCapacity && (
          <div
            id="settings-chat-memory-full"
            role="status"
            data-testid="settings-chat-memory-full"
            style={{ marginTop: "var(--space-2)", fontSize: "var(--text-xs)", color: "var(--muted)" }}
          >
            {t("settings.chat_memory_full_reason", { max: CHAT_MEMORY_MAX_ITEMS })}
          </div>
        )}
      </div>

      {/* ponytail: StorageGauge 는 바이트 게이지라 개수를 usedBytes/totalBytes 에 넣고 ratioText 로 표기를
          덮는다(비율만 같으면 막대는 맞다). 개수용 게이지가 두 번째로 필요해지면 그 부품에 count 모드를 둔다. */}
      <StorageGauge
        testId="settings-chat-memory-gauge"
        usedBytes={chatMemory.length}
        totalBytes={CHAT_MEMORY_MAX_ITEMS}
        ratioText={`${chatMemory.length} / ${CHAT_MEMORY_MAX_ITEMS}`}
        breakdownText={
          lastAdded
            ? t("settings.chat_gauge_caption", { when: formatRelativeTime(lastAdded, lang) || lastAdded })
            : ""
        }
      />

      {/* 3. 기억 목록 (SettingsTable 재사용 컴포넌트 적용, D9) — 카드 밖 페이지 최상위. */}
      <SettingsTable
        columns="minmax(180px, 1fr) 140px 60px"
        maxHeight={260}
        style={{ marginTop: 0 }}
        isEmpty={chatMemory.length === 0}
        emptyText={t("settings.chat_memory_empty")}
        bodyTestId="settings-chat-memory-list"
        header={
          <>
            <div>{t("settings.chat_memory_col_content")}</div>
            <div>{t("settings.chat_memory_col_date")}</div>
            <div style={{ textAlign: "right" }}>{t("settings.collect_table_actions")}</div>
          </>
        }
      >
        {chatMemory.map((item, i) => (
          <SettingsTableRow
            key={item.id}
            isLast={i === chatMemory.length - 1}
            data-testid={`settings-chat-memory-row-${item.id}`}
          >
            <div style={{ wordBreak: "break-all", minWidth: 0, paddingRight: "var(--space-2)" }}>
              {item.text}
            </div>
            <div style={{ color: "var(--muted)", fontSize: "var(--text-xs)", whiteSpace: "nowrap" }}>
              {item.created_at ? (formatRelativeTime(item.created_at, lang) || item.created_at) : "—"}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              {/* 접근 이름엔 어느 기억인지까지 넣는다 — 행마다 "삭제" 만 반복되면 스크린리더로 구분이 안 된다. */}
              <IconAction
                icon={<IconTrash size={14} strokeWidth={1.8} />}
                label={t("settings.chat_memory_delete_item", {
                  text: item.text.length > 40 ? `${item.text.slice(0, 40)}…` : item.text,
                })}
                titleOverride={t("settings.chat_memory_delete")}
                size="sm"
                danger
                onClick={() => void removeChatMemory(item.id)}
                data-testid={`settings-chat-memory-delete-${item.id}`}
              />
            </div>
          </SettingsTableRow>
        ))}
      </SettingsTable>
    </>
  );
}
