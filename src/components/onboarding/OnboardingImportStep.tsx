import { useRef, useState, type JSX } from "react";
import { t } from "../../i18n/t";
import { isBrowser } from "../../lib/env";
import { useFileDropZone } from "../../lib/useFileDropZone";
import { ImportSourcesPanel, importFromPath, type ImportSource } from "../ImportSourcesPanel";

/**
 * 경로만으로 가져오기 종류를 정한다(파일 선택 대화상자 대신 드롭으로 온 경로엔 확장자로 판정할
 * 근거가 이것뿐) — .zip → Notion, .enex → Evernote, 확장자 없음(폴더) → Markdown. 그 밖은 null.
 */
function importKindForPath(path: string): ImportSource | null {
  const base = path.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "markdown"; // 점이 없거나(폴더) 숨김파일(".foo")이면 폴더로 취급
  const ext = base.slice(dot + 1).toLowerCase();
  if (ext === "zip") return "notion";
  if (ext === "enex") return "enex";
  return null;
}

/**
 * PLAN-2026-09-28-onboarding-rebuild.md §1 "기록 가져오기" 오른쪽 열. 왼쪽 일러스트·프레임·이전
 * 버튼은 위저드가 소유— 이 컴포넌트는 오른쪽 열 내용만 그린다. 드롭존과 기존
 * `ImportSourcesPanel`(피커)이 같은 `importFromPath` 관문을 타므로("유사 기능은 같은 관문") 결과
 * 처리(가져온 개수>0 → onImported, 그 외 → 인라인 에러로 재시도 유도)가 한 곳에 있다.
 */
export function OnboardingImportStep(props: { onImported: () => void; onCancel: () => void }): JSX.Element {
  const browser = isBrowser();
  const zoneRef = useRef<HTMLDivElement>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { dragOver } = useFileDropZone(
    () => zoneRef.current,
    {
      onDrop: (paths, _pos, inside) => {
        if (!inside || importing) return;
        const path = paths[0];
        if (!path) return;
        const kind = importKindForPath(path);
        if (!kind) {
          setError(t("onboarding.import_drop_unsupported"));
          return;
        }
        setError(null);
        setImporting(true);
        void importFromPath(kind, path).then((result) => {
          setImporting(false);
          if (result && result.imported > 0) props.onImported();
          else setError(t("onboarding.import_drop_failed"));
        });
      },
    },
    !browser,
  );

  // 제목·설명은 왼쪽 열(위저드)이 소유 — 이 컴포넌트는 오른쪽 카드 하나(끌어다 놓기 + 원본 선택 + 가져오기 버튼).
  return (
    <div className="ob-card">
      {browser ? (
        <div className="ob-hint">{t("common.desktop_only")}</div>
      ) : (
        <>
          <div
            ref={zoneRef}
            data-testid="onboarding-import-dropzone"
            style={{
              border: `1.5px dashed ${dragOver ? "var(--accent)" : "var(--divider)"}`,
              borderRadius: "var(--radius-md)",
              background: dragOver ? "color-mix(in srgb,var(--accent) 8%,transparent)" : "transparent",
              padding: "var(--space-7) var(--space-5)",
              textAlign: "center",
              fontSize: "var(--text-md)",
              color: "var(--muted)",
              opacity: importing ? 0.6 : 1,
              pointerEvents: importing ? "none" : "auto",
              transition: "border-color var(--dur-fast), background var(--dur-fast)",
            }}
          >
            {importing ? t("onboarding.import_in_progress") : t("onboarding.import_drop_hint")}
          </div>

          {error && (
            <div data-testid="onboarding-import-error" className="ob-hint" style={{ color: "var(--danger)" }}>
              {error}
            </div>
          )}

          <div className="ob-hint" style={{ color: "var(--faint)" }}>{t("onboarding.import_or_pick")}</div>
          <ImportSourcesPanel variant="dropdown" primary onImported={props.onImported} onCancel={props.onCancel} />
        </>
      )}
    </div>
  );
}
