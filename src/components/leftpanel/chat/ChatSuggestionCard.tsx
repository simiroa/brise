import { t } from "../../../i18n/t";
import type { PetSuggestionCard } from "../../../plugins/pet/PetChat";

export interface PendingSuggestionData {
  kind: "overlap" | "link" | "theme" | "collect";
  id: string;
  noteTitle?: string;
  relatedNoteTitle?: string;
  targetNoteTitle?: string | null;
  summary?: string;
  othersCount?: number;
}

export interface ChatSuggestionCardProps {
  card: PetSuggestionCard;
  suggestion?: PendingSuggestionData;
  onDismiss: () => void;
  onAcceptOrReview: () => void;
  testId?: string;
  text?: string;
  dismissLabel?: string;
  actionLabel?: string;
}

export function formatSuggestionCardText(s: PetSuggestionCard): string {
  const untitled = t("note.untitled_note");
  if (s.kind === "link") {
    return s.targetNoteTitle
      ? `"${s.summary}" → "${s.targetNoteTitle}"?`
      : `"${s.summary}" → new note?`;
  }
  if (s.kind === "theme") {
    return `"${s.noteTitle || untitled}" + ${s.othersCount}`;
  }
  if (s.kind === "collect") {
    return `"${s.sourceName}" → "${s.noteTitle || untitled}"`;
  }
  return `"${s.noteTitle || untitled}" × "${s.relatedNoteTitle || untitled}"`;
}

function defaultActionLabel(kind: PetSuggestionCard["kind"]): string {
  if (kind === "link") return t("search.chat_add");
  if (kind === "theme") return t("search.chat_collect");
  if (kind === "collect") return t("search.chat_organize");
  return t("search.chat_review");
}

export function ChatSuggestionCard({
  card,
  suggestion,
  onDismiss,
  onAcceptOrReview,
  testId = "sidebar-chat-suggestion",
  text,
  dismissLabel,
  actionLabel,
}: ChatSuggestionCardProps) {
  const kind = suggestion?.kind ?? card.kind;
  return (
    <div className="pet-suggestion" data-testid={testId}>
      <p className="pet-suggestion__text">{text ?? formatSuggestionCardText(card)}</p>
      <div className="pet-suggestion__actions">
        <button type="button" onClick={onDismiss}>
          {dismissLabel ?? t("search.chat_dismiss")}
        </button>
        <button
          type="button"
          className="pet-suggestion__review"
          onClick={onAcceptOrReview}
        >
          {actionLabel ?? defaultActionLabel(kind)}
        </button>
      </div>
    </div>
  );
}
