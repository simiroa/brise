import { useState, useRef, Suspense } from "react";
import { IconAi } from "../icons";
import { t } from "../../i18n/t";
import { type TranslateLang, useAiStore } from "../../stores/ai";
import { useNotesStore, displayTitle } from "../../stores/notes";
import { getActiveSection, getDiagramTarget, getSheetTarget } from "../../lib/aiSectionBridge";
import type { AskAiTarget } from "../AskAiModal";
import { AskAiModal } from "../../lazySurfaces";

export interface AiActionsMenuProps {
  cloudGateOk?: boolean | null;
  organizePending?: boolean;
  promptPending?: boolean;
  translateLang?: TranslateLang;
  onChangeTranslateLang?: (lang: TranslateLang) => void;
  onOpenHistory?: () => void;
  onTranslate?: () => void;
  onAskPrompt?: (promptText: string) => void;
}

export function resolveAiTarget(): AskAiTarget {
  const activeNote = useNotesStore.getState().activeNote;
  const secSnapshot = getActiveSection();
  const activeSec = secSnapshot
    ? activeNote?.sections.find((s) => s.id === secSnapshot.id)
    : activeNote?.sections[0];

  const dTarget = getDiagramTarget();
  if (dTarget) {
    return {
      kind: "section",
      sectionId: dTarget.sectionId ?? activeSec?.id ?? "diagram",
      sectionName: activeSec?.name ?? "Diagram",
      sectionBody: dTarget.source,
      isDiagram: true,
      diagramMounted: true,
    };
  }
  const sTarget = getSheetTarget();
  if (sTarget) {
    return {
      kind: "section",
      sectionId: sTarget.sectionId ?? activeSec?.id ?? "sheet",
      sectionName: activeSec?.name ?? "Sheet",
      sectionBody: sTarget.source,
      isDiagram: false,
      diagramMounted: false,
      isSheet: true,
      sheetMounted: true,
    };
  }
  if (activeSec) {
    return {
      kind: "section",
      sectionId: activeSec.id,
      sectionName: activeSec.name,
      sectionBody: secSnapshot?.body_md ?? activeSec.body_md,
      isDiagram: activeSec.kind === "diagram",
      diagramMounted: activeSec.kind === "diagram",
      isSheet: activeSec.kind === "sheet",
      sheetMounted: activeSec.kind === "sheet",
    };
  }
  if (activeNote) {
    return {
      kind: "note",
      noteId: activeNote.note.id,
      noteTitle: displayTitle(activeNote.note.title),
    };
  }
  return { kind: "new" };
}

/**
 * AI 진입 버튼 — 노트 제목 줄(TitleBar, ☆ 옆)에 **한 곳만** 있다(2026-09-26 오너 결정). 예전엔
 * 섹션 툴바 3종(텍스트·시트·관계도)에도 아이콘 변형이 있었고 툴바가 뜨면 이쪽이 숨었지만, 노트
 * 단위 AI 요청이라 섹션 종류와 무관하게 늘 같은 자리가 맞고 툴바 공간도 확보된다. 대상(노트/섹션)은
 * 여전히 누를 때의 활성 섹션으로 `resolveAiTarget` 이 정한다.
 */
export function AiActionsMenu(_props: AiActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const organizePending = useAiStore((s) => s.organizePending);
  const promptPending = useAiStore((s) => s.promptPending);
  const anyPending = organizePending || promptPending;
  // 내용잠금: 번역/프롬프트/정리는 전부 노트에 결과를 써넣는 기능이라(대화창을 여는 게 아니라
  // 바로 쓰기로 이어짐) AskAiModal 안의 개별 삽입 차단과 별개로 진입점 자체를 막는다.
  const contentLocked = useNotesStore((s) => s.activeNote?.note.content_locked ?? false);
  const disabled = anyPending || contentLocked;

  const btnRef = useRef<HTMLButtonElement>(null);

  const target = resolveAiTarget();

  return (
    <div style={{ position: "relative" }} data-testid="ai-actions-menu">
      <button
        type="button"
        ref={btnRef}
        // 이웃(☆·⋮)과 같은 제목 줄 아이콘 버튼. ai-entry — 글리프가 상시로 빛난다(tokens.css AI-ENTRY).
        className="icon-btn icon-btn--sm icon-btn--glow ai-entry"
        data-active={anyPending || open ? "true" : undefined}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title={contentLocked ? t("editor.content_locked_tooltip") : t("editor.ai_menu_title") || "AI"}
        aria-label={contentLocked ? t("editor.content_locked_tooltip") : t("editor.ai_menu_title") || "AI"}
        aria-haspopup="dialog"
        aria-expanded={open}
        // 잠금으로 막힌 동안만 흐리게 — 작업 중(pending)에도 disabled 지만 스피너는 또렷해야 한다.
        style={contentLocked ? { opacity: "var(--dim-disabled)", cursor: "not-allowed" } : undefined}
      >
        {anyPending ? (
          <span
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              border: "2px solid var(--accent)",
              borderTopColor: "transparent",
              animation: "spin 1s linear infinite",
            }}
          />
        ) : (
          <IconAi size={13} strokeWidth={1.8} />
        )}
      </button>

      {open && (
        <Suspense fallback={null}>
          <AskAiModal target={target} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}

