import { useEffect, useState } from "react";
import { useUiStore } from "../../stores/ui";
import { call, flushAll } from "../../lib/invoke";
import type { NoteDetail, Section } from "../../lib/commands.gen";
import { navigateToSection } from "../../lib/presetBridge";
import { IconCaret, IconGraph, IconNote, IconSheet } from "../icons";
import { centeredHintStyle } from "./shared";
import { SectionBody } from "./SectionBody";
import { t } from "../../i18n/t";

interface SectionPreviewProps {
  noteId: string;
  sectionId: string;
}

export function SectionPreview({ noteId, sectionId }: SectionPreviewProps) {
  const setPreviewItem = useUiStore((s) => s.setPreviewItem);
  const sectionSaveTick = useUiStore((s) =>
    s.sectionSaveEvent?.sectionId === sectionId ? s.sectionSaveEvent.tick : null
  );

  const [sectionData, setSectionData] = useState<Section | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load section content directly from DB via note_get after flushAll
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        await flushAll();
        const detail = await call<NoteDetail>("note_get", { id: noteId });
        if (cancelled) return;
        const sec = detail?.sections?.find((s) => s.id === sectionId);
        if (!sec) {
          // Section was deleted or not found — automatically release preview
          setPreviewItem(null);
          return;
        }
        setSectionData(sec);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId, sectionId, sectionSaveTick, setPreviewItem]);

  const handleNavigate = () => {
    void navigateToSection(sectionId);
  };

  if (loading && !sectionData) {
    return <div style={centeredHintStyle}>{t("attachments.preview_select_hint")}</div>;
  }

  if (error || !sectionData) {
    return <div style={centeredHintStyle}>{error || t("attachments.preview_select_hint")}</div>;
  }

  return (
    <div
      data-testid="section-preview-container"
      style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}
    >
      {/* Header bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "var(--space-2) var(--space-4)",
          borderBottom: "1px solid var(--divider)",
          background: "var(--hover)",
          fontSize: "var(--text-xs)",
          gap: "var(--space-2)",
          flex: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontWeight: 600,
            color: "var(--text)",
          }}
        >
          {sectionData.kind === "diagram" ? (
            <IconGraph size={14} strokeWidth={2} style={{ color: "var(--accent)", flex: "none" }} />
          ) : sectionData.kind === "sheet" ? (
            <IconSheet size={14} strokeWidth={2} style={{ color: "var(--accent)", flex: "none" }} />
          ) : (
            <IconNote size={14} strokeWidth={2} style={{ color: "var(--accent)", flex: "none" }} />
          )}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{sectionData.name}</span>
        </div>

        <button
          type="button"
          data-testid="section-preview-go-to"
          className="btn btn--sm"
          onClick={handleNavigate}
          title={t("attachments.go_to_section")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: "var(--text-xs)",
            padding: "var(--space-2xs) 8px",
            height: 24,
            whiteSpace: "nowrap",
            flex: "none",
          }}
        >
          <span>{t("attachments.go_to_section")}</span>
          <IconCaret dir="right" size={12} />
        </button>
      </div>

      {/* Body content */}
      <div className="scroll" style={{ flex: 1, padding: "var(--space-4)", overflow: "auto" }}>
        <SectionBody section={sectionData} />
      </div>
    </div>
  );
}

