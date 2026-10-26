import { useState, Suspense } from "react";
import { IconAi } from "../icons";
import { t } from "../../i18n/t";
import { useSettingsStore } from "../../stores/settings";
import { useAiStore, selectAiAvailability, getAiDisabledHint } from "../../stores/ai";
import { useNotesStore, displayTitle } from "../../stores/notes";
import type { AskAiTarget } from "../AskAiModal";
import { AskAiModal } from "../../lazySurfaces";

/**
 * Sidebar footer's AI entry point. Opens AskAiModal directly — no intermediate action menu: the
 * owner's rule is that every AI-capable surface has ONE door that lands you in the prompt box
 * (see AskAiModal.tsx's header), and a dropdown of enumerated actions in front of it was a second
 * one. The chips inside the modal cover what the menu rows used to.
 *
 * Target follows what's open, same shapes TabBar/ContextMenu already open:
 *   note open  -> kind:"note" (chips + free prompt against that note's body)
 *   nothing    -> kind:"new"  (topic -> generated body, via applyPreset — no note is created up
 *                 front; applyPreset owns "draft open? use it, else make one").
 * Read at click time from the store rather than a subscription — this button re-renders for
 * nothing else, and the value only matters at the moment it's pressed.
 */
export function AiActionButton() {
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const aiReachable = useAiStore((s) => s.aiReachable);
  const availability = selectAiAvailability({ aiEnabled }, { aiReachable });
  const aiReady = availability === "ready";

  const [askAiTarget, setAskAiTarget] = useState<AskAiTarget | null>(null);

  if (availability === "off") return null;

  const openAskAi = () => {
    const n = useNotesStore.getState().activeNote;
    setAskAiTarget(
      n
        ? { kind: "note", noteId: n.note.id, noteTitle: displayTitle(n.note.title) }
        : { kind: "new" },
    );
  };

  const title = aiReady ? t("editor.ai_menu_title") : getAiDisabledHint(availability, "editor");

  return (
    <>
      <button
        type="button"
        data-testid="ai-action-btn"
        // 2026-09-02: 옆 CTA(.addnote)와 같은 박스 프레임을 걷어냈다 — 아이콘만 오른쪽 그리드에
        // 맞춰 뜨고, 강조는 색(accent, 항상 초록) + IconAi 자체의 발광 애니메이션이 담당
        // (icon-ai-anim, tokens.css ICON-ANIMATION). toolbar-btn 재사용은 hover 배경만 위해서고
        // 폭은 아이콘+최소 여백으로 좁혀 우측 여백을 없앤다(위 검색줄과 그리드 정렬).
        className="toolbar-btn"
        onClick={openAskAi}
        disabled={!aiReady}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        style={{
          flex: "none",
          width: "auto",
          minWidth: 0,
          height: "auto",
          padding: "var(--space-2)",
          color: "var(--accent)",
          cursor: aiReady ? "pointer" : "not-allowed",
          opacity: aiReady ? 1 : 0.5,
        }}
      >
        <IconAi size={16} strokeWidth={2.2} />
      </button>

      {askAiTarget && (
        <Suspense fallback={null}>
          <AskAiModal target={askAiTarget} onClose={() => setAskAiTarget(null)} />
        </Suspense>
      )}
    </>
  );
}
