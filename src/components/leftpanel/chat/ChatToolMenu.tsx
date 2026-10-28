import { useState, type MouseEvent } from "react";
import { t } from "../../../i18n/t";
import type { PetSessionSummary } from "../../../lib/commands.gen";
import { IconCheckMark, IconHistory, IconPlus, IconSettings, IconSmile, IconWrench } from "../../icons";
import { PET_PERSONA_PRESETS, type PetPersonaPreset } from "../../../plugins/pet/bridge/petPersona";
import { ContextMenuShell } from "../../common/ContextMenuShell";
import { ModalShell } from "../../ModalShell";
import { Toggle } from "../../settings/Toggle";

// 새 세션은 상단 막대의 자기 버튼으로 나갔다(오너 2026-10-16 side-chat) — 도구 메뉴엔 나머지만.
export const CHAT_TOOLS = [
  { id: "save_session", label: "search.chat_tool_save_session" },
  { id: "copy_session", label: "search.chat_tool_copy_session" },
  { id: "regen_last", label: "search.chat_tool_regen_last" },
  { id: "extract_memory", label: "search.chat_tool_extract_memory" },
  { id: "refresh_suggestions", label: "search.chat_tool_refresh_suggestions" },
] as const;

export type ChatToolId = (typeof CHAT_TOOLS)[number]["id"];

/** 세션 기록 드롭다운에 바로 보이는 개수 — 나머지는 "더보기" 모달. */
const RECENT_SESSIONS = 3;

function sessionPreviewOrDate(session: PetSessionSummary): string {
  const preview = session.preview.trim();
  if (preview) return preview;
  const raw = session.closed_at || session.created_at;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleString();
}

export interface ChatToolMenuProps {
  writeEnabled: boolean;
  sessions: PetSessionSummary[];
  pending: boolean;
  newSessionDisabled: boolean;
  onToggleWrite: () => void;
  onRunTool: (toolId: ChatToolId) => void;
  onNewSession: () => void;
  /** 세션 기록을 열 때 목록을 새로 읽는다. */
  onLoadSessions: () => void;
  onOpenSession: (session: PetSessionSummary) => void;
  /** 없으면 설정 바로가기 버튼을 숨긴다(브라우저/폰 — OS 설정 창이 없다). */
  onOpenSettings?: () => void;
  /** 이 막대의 메뉴가 열릴 때 — 호스트가 다른 팝오버(프리셋)를 닫는다. */
  onMenuOpen?: () => void;
  isToolDisabled: (toolId: ChatToolId) => boolean;
  /** 현재 페르소나 프리셋(pet_persona_preset) — 드롭다운에서 체크 표시. */
  persona: PetPersonaPreset;
  /** secretary/friend 는 바로 저장, custom 은 호스트가 설정 페이지로 보낸다. */
  onPickPersona: (preset: PetPersonaPreset) => void;
  /** 페르소나 드롭다운을 열 때 현재 값을 다시 읽는다(설정 창에서 바꿨을 수 있다). */
  onLoadPersona: () => void;
}

type Anchor = { x: number; y: number };

function anchorBelow(e: MouseEvent<HTMLElement>): Anchor {
  const r = e.currentTarget.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 4 };
}

export function ChatToolMenu({
  writeEnabled,
  sessions,
  pending,
  newSessionDisabled,
  onToggleWrite,
  onRunTool,
  onNewSession,
  onLoadSessions,
  onOpenSession,
  onOpenSettings,
  onMenuOpen,
  isToolDisabled,
  persona,
  onPickPersona,
  onLoadPersona,
}: ChatToolMenuProps) {
  // 메뉴는 ContextMenuShell(포털 + 화면 경계 뒤집기)로 띄운다 — 예전엔 사이드바 안 absolute 라
  // 본문 영역 아래로 깔려 오른쪽이 잘렸다(오너 2026-10-16).
  const [toolsAt, setToolsAt] = useState<Anchor | null>(null);
  const [historyAt, setHistoryAt] = useState<Anchor | null>(null);
  const [personaAt, setPersonaAt] = useState<Anchor | null>(null);
  const [allOpen, setAllOpen] = useState(false);

  const pick = (session: PetSessionSummary) => {
    setHistoryAt(null);
    setAllOpen(false);
    onOpenSession(session);
  };

  const sessionRow = (session: PetSessionSummary) => (
    <button
      key={session.id}
      type="button"
      className="menu-row menu-item pet-chat__menu-item"
      data-testid={`chat-session-${session.id}`}
      disabled={pending && !session.live}
      onClick={() => pick(session)}
      style={{ display: "flex", flexDirection: "column", alignItems: "stretch" }}
    >
      <span className="pet-chat__menu-session-head">
        <span className="pet-chat__menu-session-title">{session.title}</span>
        {session.live ? (
          <span className="pet-chat__menu-session-live">{t("search.chat_session_live")}</span>
        ) : null}
      </span>
      <span className="pet-chat__menu-session-preview">{sessionPreviewOrDate(session)}</span>
    </button>
  );

  const empty = <div className="pet-chat__menu-empty">{t("search.chat_session_empty")}</div>;

  return (
    <div className="pet-chat__session-bar">
      <div className="pet-chat__session-actions">
        <button
          type="button"
          className="icon-btn icon-btn--sm icon-btn--glow"
          data-testid="chat-tools-btn"
          aria-label={t("search.chat_tools")}
          title={t("search.chat_tools")}
          aria-expanded={!!toolsAt}
          onClick={(e) => {
            onMenuOpen?.();
            setToolsAt(toolsAt ? null : anchorBelow(e));
          }}
        >
          <IconWrench size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm icon-btn--glow"
          data-testid="chat-new-session"
          aria-label={t("search.chat_new_session")}
          title={t("search.chat_new_session")}
          disabled={newSessionDisabled}
          onClick={onNewSession}
        >
          <IconPlus size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm icon-btn--glow"
          data-testid="chat-history-btn"
          aria-label={t("search.chat_session_history")}
          title={t("search.chat_session_history")}
          aria-expanded={!!historyAt}
          onClick={(e) => {
            onMenuOpen?.();
            if (historyAt) {
              setHistoryAt(null);
              return;
            }
            onLoadSessions();
            setHistoryAt(anchorBelow(e));
          }}
        >
          <IconHistory size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm icon-btn--glow"
          data-testid="chat-persona-btn"
          aria-label={t("search.chat_persona")}
          title={`${t("search.chat_persona")} — ${t(`settings.pet_persona_${persona}`)}`}
          aria-expanded={!!personaAt}
          onClick={(e) => {
            onMenuOpen?.();
            if (personaAt) {
              setPersonaAt(null);
              return;
            }
            onLoadPersona();
            setPersonaAt(anchorBelow(e));
          }}
        >
          <IconSmile size={14} strokeWidth={2} />
        </button>
        {onOpenSettings ? (
          <button
            type="button"
            className="icon-btn icon-btn--sm icon-btn--glow"
            data-testid="chat-settings-btn"
            aria-label={t("search.chat_open_settings")}
            title={t("search.chat_open_settings")}
            onClick={onOpenSettings}
          >
            <IconSettings size={14} strokeWidth={2} />
          </button>
        ) : null}
      </div>
      <div className="pet-chat__write-switch">
        <span aria-hidden="true" onClick={onToggleWrite}>
          {t("search.chat_write_allow")}
        </span>
        <Toggle
          checked={writeEnabled}
          onChange={onToggleWrite}
          aria-label={t("search.chat_write_allow")}
          data-testid="chat-write-toggle"
        />
      </div>

      <ContextMenuShell
        anchor={toolsAt}
        onClose={() => setToolsAt(null)}
        testId="chat-tools-list"
        minWidth={188}
        ariaLabel={t("search.chat_tools")}
      >
        {CHAT_TOOLS.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className="menu-row menu-item pet-chat__menu-item"
            data-testid={`chat-tool-${tool.id}`}
            disabled={isToolDisabled(tool.id)}
            onClick={() => {
              setToolsAt(null);
              onRunTool(tool.id);
            }}
          >
            {t(tool.label)}
          </button>
        ))}
      </ContextMenuShell>

      <ContextMenuShell
        anchor={personaAt}
        onClose={() => setPersonaAt(null)}
        testId="chat-persona-list"
        minWidth={176}
        ariaLabel={t("search.chat_persona")}
      >
        {PET_PERSONA_PRESETS.map((id) => (
          <button
            key={id}
            type="button"
            className="menu-row menu-item pet-chat__menu-item"
            data-testid={`chat-persona-${id}`}
            aria-checked={persona === id}
            role="menuitemradio"
            // 브라우저/폰엔 설정 창이 없어 "직접 입력"(= 설정 페이지로 이동)을 낼 수 없다.
            disabled={id === "custom" && !onOpenSettings}
            onClick={() => {
              setPersonaAt(null);
              onPickPersona(id);
            }}
            style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}
          >
            <span style={{ width: 14, display: "inline-flex" }}>
              {persona === id ? <IconCheckMark size={14} strokeWidth={2} /> : null}
            </span>
            {t(`settings.pet_persona_${id}`)}
          </button>
        ))}
      </ContextMenuShell>

      <ContextMenuShell
        anchor={historyAt}
        onClose={() => setHistoryAt(null)}
        testId="chat-history-list"
        minWidth={220}
        ariaLabel={t("search.chat_session_history")}
        style={{ maxWidth: 300 }}
      >
        {sessions.length ? sessions.slice(0, RECENT_SESSIONS).map(sessionRow) : empty}
        {sessions.length > RECENT_SESSIONS ? (
          <>
            <div className="pet-chat__menu-divider menu-sep" role="separator" />
            <button
              type="button"
              className="menu-row menu-item pet-chat__menu-item"
              data-testid="chat-history-more"
              onClick={() => {
                setHistoryAt(null);
                setAllOpen(true);
              }}
            >
              {t("search.chat_session_more")}
            </button>
          </>
        ) : null}
      </ContextMenuShell>

      {allOpen ? (
        <ModalShell title={t("search.chat_session_all_title")} onClose={() => setAllOpen(false)} width={440}>
          <div data-testid="chat-history-all" style={{ display: "flex", flexDirection: "column" }}>
            {sessions.length ? sessions.map(sessionRow) : empty}
          </div>
        </ModalShell>
      ) : null}
    </div>
  );
}
