import { useEffect, useState } from "react";
import { callSilent } from "../../lib/invoke";
import type { NoteDetail } from "../../lib/commands.gen";
import { t } from "../../i18n/t";
import { displayTitle } from "../../stores/notes";
import { centeredHintStyle } from "./shared";
import { SectionBody } from "./SectionBody";

// Related-note single-click preview: read-only reference view, title + one section body.
// 첫 섹션이 기본이고, 섹션이 2개 이상일 때만 작은 세그먼트 탭으로 넘겨볼 수 있다
// (docs/PLAN-2026-09-29-preview-pager-and-code-attach.md 안 1 — 선택 위치는 미리보기 이력이 아니라
// 이 컴포넌트의 로컬 상태다). ponytail: 섹션 수십 개면 가로 스크롤 대신 드롭다운으로 승격.
// The body goes through SectionBody — the same kind-aware renderer (markdown / diagram / sheet)
// SectionPreview uses. Fetched fresh via note_get (not from the sidebar cache), since the
// previewed note need not be the active note nor even loaded anywhere else in the store.
export function NotePreview({ noteId }: { noteId: string }) {
  const [noteData, setNoteData] = useState<NoteDetail | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteUnavailable, setNoteUnavailable] = useState(false);
  const [sectionIdx, setSectionIdx] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setNoteData(null);
    setSectionIdx(0);
    setNoteUnavailable(false);
    setNoteLoading(true);
    callSilent<NoteDetail>("note_get", { id: noteId })
      .then((detail) => {
        if (!cancelled) setNoteData(detail);
      })
      .catch(() => {
        // Guard: the note may have been deleted since the tile was rendered (or note_get failed
        // for any other reason) — call() already toasted the AppError, so here we just fall back
        // to a graceful "unavailable" state instead of leaving a stale/blank preview.
        if (!cancelled) setNoteUnavailable(true);
      })
      .finally(() => {
        if (!cancelled) setNoteLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  if (noteLoading) {
    return <div style={centeredHintStyle}>{t("attachments.preview_loading")}</div>;
  }
  if (noteUnavailable || !noteData) {
    return <div style={centeredHintStyle}>{t("attachments.preview_note_unavailable")}</div>;
  }
  const sections = noteData.sections;
  const shown = sections[Math.min(sectionIdx, sections.length - 1)];
  return (
    <div className="scroll" style={{ flex: 1, padding: 20, overflow: "auto" }}>
      <div
        className="label-caps"
        style={{
          color: "var(--accent)",
          marginBottom: "var(--space-1)",
        }}
      >
        {displayTitle(noteData.note.title)}
      </div>
      <div style={{ height: 2, background: "var(--divider)", marginBottom: 12 }} />
      {sections.length > 1 && (
        <div
          role="tablist"
          data-testid="note-preview-sections"
          className="scroll noscroll"
          style={{ display: "flex", gap: "var(--space-1)", overflowX: "auto", marginBottom: "var(--space-4)" }}
        >
          {sections.map((s, i) => {
            const on = s === shown;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setSectionIdx(i)}
                style={{
                  flex: "none",
                  padding: "var(--space-1) var(--space-3)",
                  background: on ? "var(--sel)" : "transparent",
                  border: "none",
                  borderBottom: on ? "2px solid var(--accent)" : "2px solid transparent",
                  color: on ? "var(--accent)" : "var(--muted)",
                  fontSize: "var(--text-sm)",
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {s.name || t("editor.new_section")}
              </button>
            );
          })}
        </div>
      )}
      {shown ? (
        <SectionBody section={shown} />
      ) : (
        <div style={{ color: "var(--faint)", fontSize: "var(--text-sm)" }}>
          {t("attachments.preview_note_empty")}
        </div>
      )}
    </div>
  );
}
