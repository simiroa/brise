/**
 * Internal note link picker (Scale Phase 1 / policy §B6).
 *
 * Boundary: search + pick only. Owns the modal chrome; does NOT mutate attachments.
 * Parent (AttachmentsBar) passes excludeNoteId / onPick / onCancel and runs
 * addInternal(noteId, title) after pick.
 *
 * Wave A-4: no resident corpus. Empty query → note_query title window; non-empty
 * → search_notes (existing search path). Hard-cap LIMIT 50.
 *
 * AI 찾기(search_semantic 하이브리드 검색, 2026-08-15)는 시맨틱 검색 제거와 함께 사라졌다
 * (PLAN-2026-08-21-settings-overhaul W9-b) — 검색은 note_query/search_notes FTS 단독이다.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { ModalShell } from "../ModalShell";
import { IconNote, IconSearch } from "../icons";
import { useNotesStore, displayTitle } from "../../stores/notes";
import type { NoteSummary } from "../../lib/commands.gen";
import { t } from "../../i18n/t";
import { call } from "../../lib/invoke";
import { noteQuery } from "../../lib/noteQuery";

/** Row shape the list actually renders (id/title/folder_id only) */
type PickerRow = Pick<NoteSummary, "id" | "folder_id" | "title">;

/** Max rows rendered / returned from the client filter. */
export const INTERNAL_PICKER_LIMIT = 50;
/** Search input debounce before applying the filter. */
export const INTERNAL_PICKER_DEBOUNCE_MS = 150;

export interface InternalNotePickerProps {
  /** Active note id — excluded so a note cannot link to itself. */
  excludeNoteId?: string | null;
  onPick: (noteId: string) => void;
  onCancel: () => void;
}

/** Pure filter used by unit tests — no React, no debounce. */
export function filterInternalNotes(
  notes: Iterable<NoteSummary>,
  query: string,
  excludeNoteId: string | null | undefined,
  limit: number = INTERNAL_PICKER_LIMIT,
): NoteSummary[] {
  const q = query.trim().toLowerCase();
  const out: NoteSummary[] = [];
  for (const n of notes) {
    if (excludeNoteId && n.id === excludeNoteId) continue;
    if (q && !n.title.toLowerCase().includes(q)) continue;
    out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}

export function InternalNotePicker({ excludeNoteId, onPick, onCancel }: InternalNotePickerProps) {
  const folders = useNotesStore((s) => s.folders);
  const mergeNoteSummaries = useNotesStore((s) => s.mergeNoteSummaries);

  const folderNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of folders) m.set(f.id, f.name);
    return m;
  }, [folders]);

  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [results, setResults] = useState<PickerRow[]>([]);

  // Debounce draft → query so we don't re-query on every keystroke.
  useEffect(() => {
    const tm = window.setTimeout(() => setQuery(draft), INTERNAL_PICKER_DEBOUNCE_MS);
    return () => window.clearTimeout(tm);
  }, [draft]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const q = query.trim();
        let notes: NoteSummary[] = [];
        if (q) {
          // Existing search path (free-text still reserved on note_query).
          const r = await call<{ results: NoteSummary[] }>("search_notes", {
            query: q,
            year_from: -9999,
            year_to: 9999,
          });
          notes = (r.results ?? []).slice(0, INTERNAL_PICKER_LIMIT + 1);
        } else {
          const r = await noteQuery({
            sort: "title_asc",
            offset: 0,
            limit: INTERNAL_PICKER_LIMIT + 1,
          });
          notes = r.notes;
        }
        const filtered = filterInternalNotes(notes, "", excludeNoteId, INTERNAL_PICKER_LIMIT);
        if (!cancelled) {
          setResults(filtered);
          mergeNoteSummaries(filtered);
        }
      } catch {
        if (!cancelled) setResults([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, excludeNoteId, mergeNoteSummaries]);

  // Keep highlight in range when the result set shrinks.
  useEffect(() => {
    setHighlight((h) => (results.length === 0 ? 0 : Math.min(h, results.length - 1)));
  }, [results]);

  const pick = (id: string) => onPick(id);

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (results.length === 0) return;
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length === 0) return;
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = results[highlight] ?? results[0];
      if (target) pick(target.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <ModalShell
      title={t("attachments.dialog_internal_title")}
      onClose={onCancel}
      width={420}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12, position: "relative" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ position: "relative", display: "block", flex: 1, minWidth: 0 }}>
            <span
              style={{
                position: "absolute",
                left: 10,
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--faint)",
                pointerEvents: "none",
                display: "grid",
                placeItems: "center",
              }}
            >
              <IconSearch size={14} strokeWidth={2} />
            </span>
            <input
              data-testid="internal-note-search"
              className="field"
              value={draft}
              placeholder={t("attachments.internal_search_placeholder")}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onSearchKeyDown}
              // 아이콘 좌측 인셋(--space-4) + 아이콘 폭(--space-6=14, IconSearch size) + 간격(--space-3)
              style={{
                paddingLeft: "calc(var(--space-4) + var(--space-6) + var(--space-3))",
                width: "100%",
                boxSizing: "border-box",
              }}
              autoComplete="off"
              autoFocus
            />
          </label>
        </div>

        <div
          role="listbox"
          aria-label={t("attachments.dialog_internal_title")}
          data-testid="internal-note-results"
          className="scroll"
          style={{
            maxHeight: 320,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {results.map((n, i) => {
            const active = i === highlight;
            const folderName = folderNameById.get(n.folder_id) ?? "";
            return (
              <div
                key={n.id}
                role="option"
                aria-selected={active}
                data-selected={active}
                data-testid={`internal-note-row-${n.id}`}
                tabIndex={-1}
                className="menu-row menu-item"
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(n.id)}
                style={{
                  minHeight: 28,
                  padding: "var(--space-1) var(--space-3)",
                  gap: "var(--space-3)",
                  display: "flex",
                  alignItems: "center",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text)",
                  cursor: "pointer",
                  transition: "background var(--dur-fast)",
                }}
              >
                <IconNote size={14} strokeWidth={1.8} style={{ flex: "none", color: "var(--accent)" }} />
                <span style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <span
                    style={{
                      fontSize: "var(--text-sm)",
                      fontWeight: 600,
                      color: "var(--text)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      flex: "0 1 auto",
                    }}
                  >
                    {displayTitle(n.title)}
                  </span>
                  {folderName && (
                    <span
                      style={{
                        fontSize: "var(--text-2xs)",
                        color: "var(--muted)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        flex: "none",
                        opacity: 0.75,
                      }}
                    >
                      · {folderName}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" onClick={onCancel} className="btn">
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
