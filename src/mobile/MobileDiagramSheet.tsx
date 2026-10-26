import { useState } from "react";
import { t } from "../i18n/t";
import { MobileModal } from "./MobileModal";
import { DIAGRAM_TEMPLATE_IDS, diagramTemplateSource } from "../components/diagram/diagramStarter";
import { parseDiagramText } from "../components/diagram/diagramText";
import { DiagramTextForm } from "../components/diagram/DiagramSection";

/**
 * 관계도 시작하기 — the mobile entry point for CREATING a diagram section (the only other way a
 * phone gets a kind:'diagram' section is the AI 관계도 만들기 action). Typing raw diagram source (JSON IR; mermaid text before the 2026-09-04 rebuild) on a
 * phone is the worst case of "authoring from scratch is too hard", so creation goes through the
 * template gallery, never a blank source box.
 *
 * The templates themselves are NOT redefined here — `diagramStarter.ts` is the
 * single source, verified by their tests (EditorPanel.diagram.test.tsx's parseDiagram round-trip
 * over every DIAGRAM_TEMPLATE_IDS source, so every seed is form/click-editable). The real
 * `mermaid.parse` cross-check this used to also name is gone along with the mermaid npm dependency
 * — the JSON IR has no external-library validator, only diagramSchema's own parse/validate. This
 * file is only the mobile PRESENTATION of that same data: a bottom sheet with 48px rows instead of
 * their desktop ModalShell grid, sharing the same `editor.diagram_tpl_*` strings so the two surfaces
 * can never name a template differently.
 * Picking one is the already-proven `insertSection(name, source, "diagram")` call (MobileNote), the
 * same one the AI diagram action uses.
 *
 * Presentation moved from the bottom sheet to the shared centered `MobileModal` (Esc/backdrop close
 * and the focus trap now live there, not here) — same reason as everything else on this surface: a
 * bottom-anchored sheet is where the on-screen keyboard lands.
 */

interface Props {
  open: boolean;
  onClose: () => void;
  /** MobileNote's section inserter — same one the AI actions use. */
  onPick: (name: string, source: string) => Promise<void> | void;
}

export function MobileDiagramSheet({ open, onClose, onPick }: Props) {
  // 텍스트로 시작(D4) — 템플릿 목록의 대안 진입점. 파싱은 데스크톱 빈 상태와 같은
  // `DiagramTextForm`(두 번째 사용처가 아니라 이걸로 세 번째 — 캔버스 동사 팝오버가 두 번째다)이
  // 맡고, 여기는 결과 JSON 을 템플릿 선택과 같은 `onPick(name, source)` 으로 넘길 뿐이다.
  const [textOpen, setTextOpen] = useState(false);
  if (!open) return null;

  return (
    <MobileModal
      title={t("editor.diagram_template_title")}
      onClose={onClose}
      footer={
        <button type="button" className="mobile-text-btn" onClick={onClose}>
          {t("common.close")}
        </button>
      }
    >
      {textOpen ? (
        <DiagramTextForm
          onSubmit={(text) => {
            const res = parseDiagramText(text);
            if (!res.ok) return { ok: false, error: res.error, line: res.line };
            void onPick(t("editor.diagram_text_start"), JSON.stringify(res.json, null, 2));
            onClose();
            return { ok: true };
          }}
        />
      ) : (
        <div className="mobile-modal-options">
          <button
            type="button"
            className="menu-row mobile-ai-action"
            data-testid="mobile-diagram-text-start"
            onClick={() => setTextOpen(true)}
          >
            {t("editor.diagram_text_start")}
          </button>
          {DIAGRAM_TEMPLATE_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className="menu-row mobile-ai-action"
              data-testid={`mobile-diagram-tpl-${id}`}
              onClick={() => {
                void onPick(t(`editor.diagram_tpl_${id}`), diagramTemplateSource(id));
                onClose();
              }}
            >
              <span style={{ display: "flex", flexDirection: "column", gap: "var(--space-2xs)", alignItems: "flex-start" }}>
                {t(`editor.diagram_tpl_${id}`)}
                <span style={{ fontSize: "var(--text-sm)", fontWeight: 400, color: "var(--muted)" }}>
                  {t(`editor.diagram_tpl_${id}_hint`)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </MobileModal>
  );
}
