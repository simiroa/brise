import { useState, useEffect, useMemo, type FC } from "react";
import { EditorContent } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { createMarkdownEditor } from "../../lib/mdSerialize";
import { SheetPreview } from "../sheet/SheetPreview";
import { parseSheet } from "../../lib/sheet/types";
import { parseDiagramJson, validateDiagramModel } from "../diagram/diagramSchema";
import { t } from "../../i18n/t";
import type { AiResultGateKind } from "../../stores/aiResultGate";

export interface ResultBodyProps {
  text: string;
  kind?: AiResultGateKind;
  showRaw?: boolean;
  inline?: boolean;
}

export const ResultBody: FC<ResultBodyProps> = ({
  text,
  kind = "text",
  showRaw = false,
  inline,
}) => {
  // 1. 원문 보기 모드
  if (showRaw) {
    return (
      <div className="ai-result-panel__preview" data-testid="ai-result-preview" data-inline={inline || undefined}>
        <pre className="ai-result-raw-view" data-testid="ai-result-raw-content">
          {text || t("aiResult.preview_empty")}
        </pre>
      </div>
    );
  }

  // 빈 결과 처리
  if (!text || !text.trim()) {
    return (
      <div className="ai-result-panel__preview" data-testid="ai-result-preview" data-inline={inline || undefined}>
        {t("aiResult.preview_empty")}
      </div>
    );
  }

  // 2. 시트 형식 렌더링
  if (kind === "sheet") {
    return <SheetResultView text={text} inline={inline} />;
  }

  // 3. 관계도 형식 렌더링
  if (kind === "diagram") {
    return <DiagramResultView text={text} inline={inline} />;
  }

  // 4. 텍스트 형식 (마크다운 읽기 전용 에디터 렌더링)
  return <TextResultView text={text} inline={inline} />;
};

function TextResultView({ text, inline }: { text: string; inline?: boolean }) {
  const [editor, setEditor] = useState<Editor | null>(null);

  useEffect(() => {
    if (!text.trim()) {
      setEditor(null);
      return;
    }
    const ed = createMarkdownEditor(text, true);
    ed.setEditable(false);
    setEditor(ed);

    return () => {
      ed.destroy();
    };
  }, [text]);

  return (
    <div
      className="ai-result-panel__preview"
      data-testid="ai-result-preview"
      data-inline={inline || undefined}
    >
      {editor ? (
        <EditorContent editor={editor} className="ai-result-panel__text-editor" />
      ) : (
        text
      )}
    </div>
  );
}

function SheetResultView({ text, inline }: { text: string; inline?: boolean }) {
  const isValid = useMemo(() => {
    try {
      const doc = parseSheet(text);
      return !!doc && Array.isArray(doc.cols) && doc.cols.length > 0;
    } catch {
      return false;
    }
  }, [text]);

  if (!isValid) {
    return (
      <div className="ai-result-panel__preview" data-testid="ai-result-preview" data-inline={inline || undefined}>
        <div className="ai-result-panel__error-box">
          <p role="alert" className="ai-result-panel__error-hint">
            {t("aiResult.sheet_parse_error")}
          </p>
          <details>
            <summary className="ai-result-panel__error-summary">
              {t("aiResult.raw_error_label")}
            </summary>
            <pre className="ai-result-raw-view">{text}</pre>
          </details>
        </div>
      </div>
    );
  }

  return (
    <div className="ai-result-panel__preview" data-testid="ai-result-preview" data-inline={inline || undefined}>
      <SheetPreview bodyMd={text} />
    </div>
  );
}

function DiagramResultView({ text, inline }: { text: string; inline?: boolean }) {
  const parsed = useMemo(() => {
    try {
      const model = parseDiagramJson(text);
      const validation = validateDiagramModel(model);
      const hasError = !validation.valid || !!model.error;
      return { model, hasError };
    } catch {
      return { model: null, hasError: true };
    }
  }, [text]);

  if (parsed.hasError || !parsed.model) {
    return (
      <div className="ai-result-panel__preview" data-testid="ai-result-preview" data-inline={inline || undefined}>
        <div className="ai-result-panel__error-box">
          <p role="alert" className="ai-result-panel__error-hint">
            {t("aiResult.diagram_parse_error")}
          </p>
          <details>
            <summary className="ai-result-panel__error-summary">
              {t("aiResult.raw_error_label")}
            </summary>
            <pre className="ai-result-raw-view">{text}</pre>
          </details>
        </div>
      </div>
    );
  }

  const { model } = parsed;

  return (
    <div className="ai-result-panel__preview" data-testid="ai-result-preview" data-inline={inline || undefined}>
      <div className="ai-result-diagram" data-testid="ai-result-diagram-summary">
        <div className="ai-result-diagram__stats" data-testid="ai-result-diagram-stats">
          {t("aiResult.diagram_summary", {
            nodes: model.nodes.length,
            edges: model.edges.length,
          })}
        </div>
        <div className="ai-result-diagram__chips">
          {model.nodes.map((node) => (
            <span key={node.id} className="ai-result-diagram__chip" data-testid="ai-result-diagram-node-chip">
              {node.label || node.id}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
