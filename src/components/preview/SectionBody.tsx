import type { Section } from "../../lib/commands.gen";
import { parseDiagramJson } from "../diagram/diagramSchema";
import { DiagramStaticSvg } from "../diagram/diagramStaticSvg";
import { SheetPreview } from "../sheet/SheetPreview";
import { MarkdownBody } from "./MarkdownBody";
import { t } from "../../i18n/t";

/**
 * 섹션 하나의 읽기 전용 본문 — kind(text/diagram/sheet)로 갈린다. SectionPreview(섹션 미리보기)와
 * NotePreview(연관 노트 첫 섹션)가 **같은 렌더 경로**를 쓰도록 여기 한 곳에 둔다.
 * 스크롤·패딩·헤더는 호출자 몫이다.
 */
export function SectionBody({ section }: { section: Pick<Section, "kind" | "body_md"> }) {
  if (section.kind === "diagram") {
    const model = parseDiagramJson(section.body_md);
    return (
      <div data-testid="section-preview-diagram" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        <div style={{ display: "flex", gap: "var(--space-2)", fontSize: "var(--text-xs)", color: "var(--muted)" }}>
          <span>{t("editor.diagram_count_nodes", { n: model?.nodes.length ?? 0 })}</span>
          <span>•</span>
          <span>{t("editor.diagram_count_edges", { n: model?.edges.length ?? 0 })}</span>
        </div>
        {/* 축소 렌더 — 캔버스와 같은 배치·색(diagramStaticSvg). */}
        {model && <DiagramStaticSvg model={model} fit />}
      </div>
    );
  }
  if (section.kind === "sheet") return <SheetPreview bodyMd={section.body_md} />;
  return <MarkdownBody text={section.body_md} />;
}
