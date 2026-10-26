import type { PetSearchHit } from "../../../lib/commands.gen";
import { t } from "../../../i18n/t";
import { displayTitle } from "../../../stores/notes";

export interface ChatSearchToolCardProps {
  hits: PetSearchHit[];
  onOpen: (noteId: string) => void;
  /** "search" = 검색 액션 결과(머리말 "검색"), 기본 "evidence" = 답변 근거("참고한 노트"). */
  variant?: "evidence" | "search";
}

export function ChatSearchToolCard({ hits, onOpen, variant = "evidence" }: ChatSearchToolCardProps) {
  return (
    <div
      style={{
        marginTop: 8,
        border: "1px solid var(--divider)",
        borderRadius: "var(--radius-sm)",
        overflow: "hidden",
        background: "color-mix(in srgb, var(--app-canvas) 55%, transparent)",
      }}
      data-testid="chat-search-tool-card"
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          padding: "5px 9px",
          borderBottom: "1px solid var(--line)",
          fontSize: "var(--text-label)",
          fontWeight: 600,
          color: "var(--muted)",
        }}
      >
        <span style={{ color: "var(--accent)" }}>{t(variant === "search" ? "search.chat_search_tool" : "search.chat_evidence_header")}</span>
        <span>{hits.length}</span>
      </div>
      <ul className="pet-hits" style={{ margin: 0 }}>
        {hits.map((h) => (
          <li key={h.note_id}>
            <button type="button" className="pet-hit" onClick={() => onOpen(h.note_id)}>
              <strong>{displayTitle(h.title)}</strong>
              <span>{h.snippet}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
