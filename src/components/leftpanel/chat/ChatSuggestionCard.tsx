import { t } from "../../../i18n/t";
import type { PetSuggestionCard } from "../../../plugins/pet/PetChat";
import { formatSuggestionCardText, suggestionActionLabel } from "../../../plugins/pet/bridge/petSuggestionCards";

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
          {actionLabel ?? suggestionActionLabel(kind)}
        </button>
      </div>
    </div>
  );
}
