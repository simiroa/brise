import { useState, type ReactNode } from "react";
import type { PetSearchHit } from "../../lib/commands.gen";
import type { PetChatItem } from "./PetChat";

export const CHAT_BUBBLE_LABELS = {
  failed: "실패",
  visionFallback: "이미지는 이 모델에서 읽을 수 없어 텍스트만 보냈어요.",
  openNote: "노트 열기",
  insertSection: "새 섹션으로 넣기",
  planFill: "새 섹션으로 넣기",
  planDetails: "자세히 보기",
  planChip: "자세히 보기",
  // U3(AUDIT-2026-09-26): the pet-bubble window cannot know whether the auto-sent create-section
  // request actually landed on the (often hidden) main window — this is deliberately "sent", not
  // "inserted", inert status copy rather than a button implying a confirmed result.
  sectionSent: "메인 창으로 보냈어요",
};

export function ChatBubble({
  item,
  text,
  labels = CHAT_BUBBLE_LABELS,
  onOpenNote,
  onOpenPlan,
  hits,
  lead,
  selected,
  onSelect,
}: {
  item: PetChatItem;
  text?: string;
  labels?: typeof CHAT_BUBBLE_LABELS;
  onOpenNote: (noteId: string) => void;
  onOpenPlan?: (item: PetChatItem) => void;
  hits?: ReactNode;
  lead?: ReactNode;
  selected?: boolean;
  onSelect?: (el: HTMLDivElement) => void;
}) {
  const body = text ?? item.text;
  // 프리셋으로 보낸 메시지는 표시 이름이 원문(item.text)과 다르다 — 대괄호 이름표로 접어두고,
  // 클릭하면 실제로 전달된 본문을 펼쳐 보여준다(전송 즉시 사라지던 원문을 나중에도 확인 가능).
  const isPresetDisplay = item.role === "user" && body !== item.text;
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={`pet-bubble pet-bubble--${item.role}${item.failed ? " pet-bubble--failed" : ""}`}
      data-chat-bubble=""
      data-failed={item.failed ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      onClick={(e) => {
        if (!onSelect) return;
        if ((e.target as HTMLElement).closest("button, a")) return;
        onSelect(e.currentTarget);
      }}
    >
      {lead}
      {!lead && item.imagePreview ? <img className="pet-chat__thumb" src={item.imagePreview} alt="" /> : null}
      {item.failed ? <span className="pet-chat__failed-label">{labels.failed}</span> : null}
      {isPresetDisplay ? (
        <button
          type="button"
          className="pet-chat__preset-reveal"
          data-testid="chat-preset-reveal"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? item.text : `[${body}]`}
        </button>
      ) : (
        <span>{body}</span>
      )}
      {item.visionStatus === "fallback_text" ? (
        <span className="pet-chat__vision-hint">{labels.visionFallback}</span>
      ) : null}
      {item.noteId ? (
        <button type="button" className="pet-chip" onClick={() => onOpenNote(item.noteId as string)}>
          {item.noteTitle || labels.openNote}
        </button>
      ) : null}
      {item.sectionBody && !item.sectionInserted && !item.sectionAutoSent ? (
        <button
          type="button"
          className="pet-chip pet-chip--plan"
          data-testid="chat-insert-section"
          onClick={() => onOpenPlan?.(item)}
        >
          {labels.insertSection}
        </button>
      ) : null}
      {/* U3(AUDIT-2026-09-26): already auto-sent, but not confirmed inserted — inert status text,
          never a re-clickable button (clicking it again would double-send the same section). */}
      {item.sectionBody && !item.sectionInserted && item.sectionAutoSent ? (
        <span className="pet-chip pet-chip--sent" data-testid="chat-section-sent">
          {labels.sectionSent}
        </span>
      ) : null}
      {onOpenPlan && (item.planKind || item.planId) && !item.sectionBody ? (
        <button
          type="button"
          className="pet-chip pet-chip--plan"
          data-testid="chat-plan-chip"
          onClick={() => onOpenPlan(item)}
        >
          {item.planKind === "fill_note"
            ? labels.planFill
            : item.planKind === "rename_plan" || item.planKind === "prune_plan"
              ? labels.planDetails
              : labels.planChip}
        </button>
      ) : null}
      {hits}
      {!hits && item.hits?.length ? <DefaultHits hits={item.hits} onOpenNote={onOpenNote} /> : null}
    </div>
  );
}

function DefaultHits({ hits, onOpenNote }: { hits: PetSearchHit[]; onOpenNote: (id: string) => void }) {
  return (
    <ul className="pet-hits">
      {hits.map((h) => (
        <li key={h.note_id}>
          <button type="button" className="pet-hit" onClick={() => onOpenNote(h.note_id)}>
            <strong>{h.title}</strong>
            <span>{h.snippet}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
