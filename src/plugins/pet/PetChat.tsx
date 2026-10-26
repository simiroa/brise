import { useEffect, useRef, useState } from "react";
import type { PetSearchHit } from "../../lib/commands.gen";
import { storedTitleOrEmpty } from "../../lib/noteTitle";
import { IconClose, IconNote } from "../../components/icons";
import { ChatBubble, CHAT_BUBBLE_LABELS } from "./ChatBubble";
import { ChatComposer } from "./ChatComposer";
import { ChatSuggestionCard } from "../../components/leftpanel/chat/ChatSuggestionCard";

/**
 * 펫 채팅 패널 (W6-d2) — 말풍선 목록 + 입력창. 순수 프레젠테이션: IPC 는 전부 PetApp 이 하고
 * 이 컴포넌트는 콜백만 부른다(펫 창은 풀 부팅을 안 하므로 스토어를 쓰지 않는다 —
 * docs/CLIENT-RULES.md §9 화면-로컬 규칙).
 * 문구는 한국어 상수로 여기 둔다(펫 창은 i18n 스택을 로드하지 않는다 — tray.rs 와 같은 관례).
 */
export interface PetChatItem {
  role: "user" | "assistant";
  text: string;
  action?: string;
  /** history timestamp, when the backend supplied one */
  createdAt?: string;
  /** action=create_note 결과 — 노트 링크 칩으로 렌더 */
  noteId?: string;
  noteTitle?: string;
  /** action=search 결과 */
  hits?: PetSearchHit[];
  /** action=propose_plan — 툴 칩. 클릭은 메인 창 검토 모달 */
  planKind?: "fill_note" | "rename_plan" | "prune_plan";
  planId?: string;
  visionStatus?: "used" | "fallback_text";
  /** 턴 한정 미리보기. 히스토리 복원에는 없다 */
  imagePreview?: string;
  /** pet_messages.meta.failed — muted failure bubble */
  failed?: boolean;
  /** create_section — session-only body (not in meta). Chip inserts if not yet applied. */
  sectionTitle?: string;
  sectionBody?: string;
  sectionInserted?: boolean;
  /** U3(AUDIT-2026-09-26): true when PetBubbleApp already emitted the create-section request to
   *  the (often hidden) main window automatically, but — unlike `sectionInserted` — WITHOUT
   *  knowing whether it actually landed there (no round trip over the pet event bridge exists for
   *  this). Never set alongside a true `sectionInserted`: this is deliberately a weaker,
   *  "sent, not confirmed" state, rendered as inert status copy instead of a clickable chip so the
   *  UI stops claiming success it cannot know. */
  sectionAutoSent?: boolean;
}

/** 후행 제안(docs/PLAN-2026-08-07-second-brain.md Q5) — 채팅 카드용 표시 데이터. kind로 갈린다:
 *  겹침(P2 2단계, "검토하기" → 병합 검토 모달)과 링크(P2 3단계, "추가하기" → 대상 노트에 섹션
 *  append 또는 인박스에 새 노트). 두 경우 다 note_id/related_note_id/targetNoteId 등 액션에
 *  필요한 원본 id는 여기까지 안 내려온다 — PetBubbleApp 이 들고 있는 원본 suggestion 객체를 그대로
 *  쓴다(이 컴포넌트는 콜백만 부르는 순수 프레젠테이션). */
export type PetSuggestionCard =
  | { kind: "overlap"; id: string; noteTitle: string; relatedNoteTitle: string }
  | {
      kind: "link";
      id: string;
      title: string;
      summary: string;
      url: string;
      targetNoteTitle: string | null;
    }
  /** 테마(docs/PLAN-2026-08-08-presets-schedule.md Q1~Q3) — 겹치지는 않지만 비슷한 노트가
   *  여러 개. noteTitle 은 앵커(방금 저장된) 노트, othersCount 는 나머지 클러스터 멤버 수. */
  | { kind: "theme"; id: string; noteTitle: string; othersCount: number }
  /** collect_post_process(docs/SUGGESTIONS.md §3) — 수집 소스가 노트를 만들며 "AI로 정리할까요?"
   *  를 제안. 수락은 기존 organize propose/apply 계약(ai_organize_note → lastProposal →
   *  AiConfirmModal)을 그 노트에 대해 실행한다(petCollectBridge.ts). */
  | { kind: "collect"; id: string; noteTitle: string; sourceName: string };

export interface PetChatProps {
  items: PetChatItem[];
  pending: boolean;
  onSend: (text: string) => void;
  onSaveMemo: (text: string) => void;
  /** Save the current conversation as a note. Resolving means the note was created. */
  onSaveConversation?: (items: PetChatItem[]) => Promise<void> | void;
  /** Turns created since this chat window opened. Restored history is display-only. */
  conversationItems?: PetChatItem[];
  /** Incremented when the character window requests a close. */
  closeRequest?: number;
  onOpenNote: (noteId: string) => void;
  /** propose_plan 칩 — 메인 창 검토 모달. 없으면 칩을 그리지 않는다. */
  onOpenPlan?: (item: PetChatItem) => void;
  /** 채팅은 자기 창이라 "바깥 클릭"이 없다 — 닫기 버튼(과 Esc)이 유일한 출구다. */
  onClose: () => void;
  /** AI 가 꺼져 있어 대답할 수 없는 상태(백엔드 프라이버시 게이트가 거부). 입력은 막지 않는다 —
   *  설정에서 AI 를 켠 직후 그대로 다시 보내면 되고, "메모로 저장"은 원래 AI 없이 동작한다. */
  aiOff?: boolean;
  /** pending 후행 제안 하나(v1: 한 번에 하나만 보여준다, kind 무관). 없으면 카드를 그리지 않는다. */
  suggestion?: PetSuggestionCard | null;
  /** kind='overlap' 카드의 "검토하기". */
  onReviewSuggestion?: () => void;
  /** kind='link' 카드의 "추가하기". */
  onAcceptLink?: () => void;
  /** kind='theme' 카드의 "모으기". */
  onAcceptTheme?: () => void;
  /** kind='collect' 카드의 "정리하기". */
  onAcceptCollect?: () => void;
  onDismissSuggestion?: () => void;
}

const PLACEHOLDER = "무엇이든 물어보세요";
const SAVE_LABEL = "메모로 저장";
const SAVE_TITLE = "AI 없이 이 내용을 그대로 Inbox 노트로 저장합니다";
const EMPTY_HINT = "메모해줘 · 찾아줘 · 궁금한 것 아무거나";
const CLOSE_LABEL = "닫기";
const AI_OFF_HINT = "AI가 꺼져 있어 대답할 수 없어요. 설정 > AI에서 켜 주세요 — 지금은 “메모로 저장”만 됩니다.";
const REVIEW_LABEL = "검토하기";
const ADD_LABEL = "추가하기";
const COLLECT_LABEL = "모으기";
const ORGANIZE_LABEL = "정리하기";
const DISMISS_LABEL = "무시";
const UNTITLED = "(제목 없음)";
const SAVE_CONVERSATION_PROMPT = "이 대화를 노트에 정리할까요?";
const SAVE_CONVERSATION_LABEL = "노트로 정리";
const CLOSE_WITHOUT_SAVING_LABEL = "그냥 닫기";
const CANCEL_LABEL = "취소";
const SAVING_CONVERSATION_LABEL = "노트로 정리하는 중…";
const SAVE_CONVERSATION_ERROR = "노트로 정리하지 못했어요. 다시 시도해 주세요.";
const PENDING_CONVERSATION_HINT = "답변이 끝난 뒤 원문과 요약을 저장할 수 있어요.";
const WAITING = "대기 중";
function overlapSuggestionText(s: Extract<PetSuggestionCard, { kind: "overlap" }>): string {
  return `"${s.noteTitle || UNTITLED}"와 "${s.relatedNoteTitle || UNTITLED}" 내용이 겹쳐요 — 합칠지 검토할까요?`;
}
function linkSuggestionText(s: Extract<PetSuggestionCard, { kind: "link" }>): string {
  return s.targetNoteTitle
    ? `이 링크, "${s.summary}" 내용이에요 — "${storedTitleOrEmpty(s.targetNoteTitle) || UNTITLED}" 노트에 추가할까요?`
    : `이 링크, "${s.summary}" 내용이에요 — 새 노트로 저장할까요?`;
}
/** LLM 0원(Q3) — 문구는 대표 노트 제목과 개수만으로 만든다. */
function themeSuggestionText(s: Extract<PetSuggestionCard, { kind: "theme" }>): string {
  return `"${s.noteTitle || UNTITLED}" 외 ${s.othersCount}개가 비슷해요 — 하나의 목록으로 모을까요?`;
}
function collectSuggestionText(s: Extract<PetSuggestionCard, { kind: "collect" }>): string {
  return `"${s.sourceName}"에서 수집한 "${s.noteTitle || UNTITLED}" — AI로 정리할까요?`;
}
function suggestionText(s: PetSuggestionCard): string {
  if (s.kind === "link") return linkSuggestionText(s);
  if (s.kind === "theme") return themeSuggestionText(s);
  if (s.kind === "collect") return collectSuggestionText(s);
  return overlapSuggestionText(s);
}

export function PetChat({
  items,
  pending,
  onSend,
  onSaveMemo,
  onSaveConversation,
  conversationItems,
  closeRequest = 0,
  onOpenNote,
  onOpenPlan,
  onClose,
  aiOff,
  suggestion,
  onReviewSuggestion,
  onAcceptLink,
  onAcceptTheme,
  onAcceptCollect,
  onDismissSuggestion,
}: PetChatProps) {
  const [draft, setDraft] = useState("");
  const [closePromptOpen, setClosePromptOpen] = useState(false);
  const [savingConversation, setSavingConversation] = useState(false);
  const [saveConversationError, setSaveConversationError] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 새 말풍선이 붙으면 항상 맨 아래를 본다.
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [items.length, pending]);

  const submit = (fn: (text: string) => void) => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    fn(text);
  };

  const saveItems = conversationItems ?? items;
  const hasConversation = saveItems.some((item) => item.text.trim().length > 0);
  const requestClose = () => {
    if (savingConversation) return;
    if (!hasConversation || !onSaveConversation) {
      onClose();
      return;
    }
    setSaveConversationError(false);
    setClosePromptOpen(true);
  };

  useEffect(() => {
    if (closeRequest > 0) requestClose();
    // The counter changes only when another window requests closing; the callback reads the
    // latest session/pending state from that render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeRequest]);

  const saveConversation = async () => {
    if (!onSaveConversation || savingConversation) return;
    setSavingConversation(true);
    setSaveConversationError(false);
    try {
      await onSaveConversation(saveItems);
      setClosePromptOpen(false);
      onClose();
    } catch {
      setSaveConversationError(true);
    } finally {
      setSavingConversation(false);
    }
  };

  // PetBubbleApp owns the window close command, but this component owns the conversation decision.
  // Handling Escape here keeps keyboard close behavior identical to the close button.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (closePromptOpen && !savingConversation) {
        setClosePromptOpen(false);
        setSaveConversationError(false);
      } else {
        requestClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closePromptOpen, savingConversation, hasConversation, onSaveConversation, saveItems]);

  const visible = items.slice(-3);

  return (
    <div className="overlay pet-chat pet-chat--compact">
      <button type="button" className="pet-chat__close" aria-label={CLOSE_LABEL} onClick={requestClose}>
        <IconClose size={14} strokeWidth={2} />
      </button>
      <div className="pet-chat__list" ref={listRef}>
        {items.length === 0 && !pending ? <p className="pet-chat__hint">{EMPTY_HINT}</p> : null}
        {visible.map((m, i) => (
          <ChatBubble
            key={`${m.createdAt ?? "local"}-${i}`}
            item={m}
            labels={CHAT_BUBBLE_LABELS}
            onOpenNote={onOpenNote}
            onOpenPlan={onOpenPlan}
          />
        ))}
        {pending ? (
          <div className="pet-bubble pet-bubble--assistant pet-chat__thinking">
            <span className="pet-chat__thinking-label">{WAITING}</span>
            <span className="pet-chat__dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </div>
        ) : null}
      </div>

      {suggestion ? (
        <ChatSuggestionCard
          card={suggestion}
          testId="pet-suggestion-card"
          text={suggestionText(suggestion)}
          dismissLabel={DISMISS_LABEL}
          actionLabel={
            suggestion.kind === "link"
              ? ADD_LABEL
              : suggestion.kind === "theme"
                ? COLLECT_LABEL
                : suggestion.kind === "collect"
                  ? ORGANIZE_LABEL
                  : REVIEW_LABEL
          }
          onDismiss={() => onDismissSuggestion?.()}
          onAcceptOrReview={
            suggestion.kind === "link"
              ? () => onAcceptLink?.()
              : suggestion.kind === "theme"
                ? () => onAcceptTheme?.()
                : suggestion.kind === "collect"
                  ? () => onAcceptCollect?.()
                  : () => onReviewSuggestion?.()
          }
        />
      ) : null}

      {aiOff ? <p className="pet-chat__hint pet-chat__hint--warn">{AI_OFF_HINT}</p> : null}

      <div className="pet-chat__composer">
        <ChatComposer
          value={draft}
          onChange={setDraft}
          onSubmit={() => submit(aiOff ? onSaveMemo : onSend)}
          pending={pending}
          disabled={pending}
          rows={1}
          placeholder={aiOff ? SAVE_TITLE : PLACEHOLDER}
          sendLabel={aiOff ? SAVE_LABEL : "보내기"}
          topAction={
            aiOff ? undefined : (
              <button
                type="button"
                className="pet-chat__icon-btn pet-chat__icon-btn--glow"
                data-testid="pet-chat-save-memo-btn"
                aria-label={SAVE_LABEL}
                title={SAVE_TITLE}
                disabled={pending || !draft.trim()}
                onClick={() => submit(onSaveMemo)}
              >
                <IconNote size={14} strokeWidth={2} />
              </button>
            )
          }
        />
      </div>

      {closePromptOpen ? (
        <div className="pet-chat__save-dialog-backdrop" data-testid="pet-chat-save-dialog-backdrop">
          <div
            className="overlay pet-chat__save-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pet-chat-save-dialog-title"
          >
            <p id="pet-chat-save-dialog-title">{SAVE_CONVERSATION_PROMPT}</p>
            <p className="pet-chat__save-dialog-hint">
              {pending ? PENDING_CONVERSATION_HINT : "원문과 요약을 각각 한 섹션으로 저장합니다."}
            </p>
            {saveConversationError ? (
              <p className="pet-chat__save-dialog-error" role="alert">
                {SAVE_CONVERSATION_ERROR}
              </p>
            ) : null}
            <div className="pet-chat__save-dialog-actions">
              <button type="button" onClick={saveConversation} disabled={savingConversation || pending}>
                {savingConversation ? SAVING_CONVERSATION_LABEL : SAVE_CONVERSATION_LABEL}
              </button>
              <button
                type="button"
                onClick={() => {
                  setClosePromptOpen(false);
                  onClose();
                }}
                disabled={savingConversation}
              >
                {CLOSE_WITHOUT_SAVING_LABEL}
              </button>
              <button
                type="button"
                onClick={() => {
                  setClosePromptOpen(false);
                  setSaveConversationError(false);
                }}
                disabled={savingConversation}
              >
                {CANCEL_LABEL}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
