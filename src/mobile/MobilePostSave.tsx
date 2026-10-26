import { useState } from "react";
import type { Section } from "../lib/commands.gen";
import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { useAiStore, selectAiAvailability, getAiDisabledHint } from "../stores/ai";
import { call } from "../lib/invoke";
import { t } from "../i18n/t";
import { IconCheck } from "../components/icons";
import { stripHtmlForDisplay } from "./mobileEditorSupport";
import { MobileAiSheet } from "./MobileAiSheet";
import { useAiPresetsStore } from "../stores/aiPresets";
import { diagramBody } from "../components/diagram/diagramStarter";

/** "이어쓰기" made no sense once the user has already left the editor — "리스트로 만들기"/"데이터
 *  자동 채우기" don't fit a screen with no live editor either, same reasoning extended to the new
 *  4-action system. Only these two built-in ids ever show here. */
const POSTSAVE_ACTION_IDS = ["summarize", "organize"];

interface MobilePostSaveProps {
  onNextNote: () => void;
  onBackToFeed: () => void;
}

/**
 * Post-save AI interstitial — shown by MobileApp's leaveCapture() only for "long" notes (see the
 * CAPTURE_LONG_CHARS constant there). Reuses MobileAiSheet as-is, restricted to the summarize/
 * organize built-ins via its `only` prop (POSTSAVE_ACTION_IDS above) — so this component owns no AI
 * request/pending/proposal state of its own.
 */
export function MobilePostSave({ onNextNote, onBackToFeed }: MobilePostSaveProps) {
  const activeNote = useNotesStore((s) => s.activeNote);
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const aiReachable = useAiStore((s) => s.aiReachable);
  const presetList = useAiPresetsStore((s) => s.list);
  const [aiSheetOpen, setAiSheetOpen] = useState(false);

  // leaveCapture() only routes here right after a successful save, so activeNote is always set in
  // practice — the guard is defensive, not an expected path.
  if (!activeNote) return null;
  const note = activeNote.note;
  const lastSection = activeNote.sections[activeNote.sections.length - 1];
  const title = note.title.trim() && note.title !== "Untitled Note" ? note.title : null;
  const firstLine = lastSection ? stripHtmlForDisplay(lastSection.body_md).split("\n")[0] : "";
  const availability = selectAiAvailability({ aiEnabled }, { aiReachable });
  const aiReady = availability === "ready";

  const getActiveSection = () => (lastSection ? { id: lastSection.id, body_md: lastSection.body_md } : null);

  // Same shape as MobileNote::insertSection / MobileAiSheet's insertSection prop — targetNoteId
  // pins the insert to the note this screen is about; kind is required for 관계도 만들기 so diagram
  // source (JSON IR; mermaid text before the 2026-09-04 rebuild) never lands in a text section (P0-4).
  // call() already toasts on failure; do not empty-catch (would swallow after a success toast path).
  const insertSection = async (
    name: string,
    body_md: string,
    targetNoteId: string,
    kind?: "text" | "diagram" | "sheet",
  ) => {

    // Honour the request target (mid-flight switch safety) — never silent-write to another note.
    if (targetNoteId !== note.id) return;
    const body = kind === "diagram" ? diagramBody(body_md) : body_md;
    const newSec = await call<Section>("section_create_with_body", {
      note_id: targetNoteId,
      name,
      body_md: body,
      kind,
    });
    // 토큰까지 심는다(D2② W4). 다른 노트가 열려 있으면 스토어가 무시한다.
    useNotesStore.getState().appendActiveSection(targetNoteId, newSec);
  };

  return (
    <div className="mobile-postsave scroll">
      <div className="mobile-postsave-check">
        <IconCheck size={30} strokeWidth={1.8} />
      </div>
      <div className="mobile-postsave-title">{t("mobile.postsave_title")}</div>

      <div className="mobile-postsave-card card">
        <div className={title ? "mobile-card-title" : "mobile-card-title mobile-card-title--empty"}>
          {title ?? t("note.untitled_note")}
        </div>
        {firstLine && <div className="mobile-card-excerpt">{firstLine}</div>}
      </div>

      <div className="mobile-postsave-suggest label-caps">{t("mobile.postsave_suggest")}</div>
      <div className="mobile-postsave-ai-actions">
        {/* Labels come from the shared aiPresets store (SSOT for action names, editable from 설정 —
            see MobileSettings) once loaded; static defaults cover the render before that resolves. */}
        {POSTSAVE_ACTION_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className={aiReady ? "mobile-postsave-ai-btn" : "mobile-postsave-ai-btn mobile-postsave-ai-btn--muted"}
            title={aiReady ? undefined : getAiDisabledHint(availability, "mobile")}
            onClick={() => setAiSheetOpen(true)}
          >
            {presetList.find((a) => a.id === id)?.name ?? t(`ai.action_default_name_${id}`)}
          </button>
        ))}
      </div>

      <button type="button" className="mobile-record-btn btn-shimmer mobile-postsave-next" onClick={onNextNote}>
        {t("mobile.postsave_next")}
      </button>
      <button type="button" className="mobile-text-btn mobile-postsave-feed-link" onClick={onBackToFeed}>
        {t("mobile.postsave_to_feed")}
      </button>

      <MobileAiSheet
        open={aiSheetOpen}
        onClose={() => setAiSheetOpen(false)}
        getActiveSection={getActiveSection}
        insertSection={insertSection}
        only={POSTSAVE_ACTION_IDS}
      />
    </div>
  );
}
