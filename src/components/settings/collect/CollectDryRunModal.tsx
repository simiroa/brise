import { t } from "../../../i18n/t";
import type { CollectSource, CollectSourceDryRunOutput, DryRunItem } from "../../../lib/commands.gen";
import { ModalShell } from "../../ModalShell";
import { Badge } from "../Badge";
import { Spinner } from "./Spinner";

/**
 * 드라이런 결과 모달이 그리는 한 건. confirmSource/confirmKey 는 "가져오기" 유령 행 흐름
 * (§useLocalImport.importCandidate)에서 열렸을 때만 채워진다 — 행별 "테스트 실행" 클릭은 둘 다 null 이라
 * 푸터에 닫기 버튼만 나온다(W8 이전과 같다).
 */
export interface DryRunPreview {
  sourceName: string;
  sourceKind: string;
  outcome: CollectSourceDryRunOutput;
  confirmSource: CollectSource | null;
  confirmKey: string | null;
}

interface CollectDryRunModalProps {
  result: DryRunPreview;
  confirmBusy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

/** Dry Run 결과 미리보기 모달 — 표 행의 "테스트 실행"과 로컬 가져오기 확인이 함께 쓴다. */
export function CollectDryRunModal({ result: dryRunResult, confirmBusy, onClose, onConfirm }: CollectDryRunModalProps) {
  return (
    <ModalShell
      title={`${t("settings.collect_dry_run_modal_title")} - ${dryRunResult.sourceName}`}
      // 닫기/스크림 클릭/Escape 모두 이 onClose 하나로 들어온다 — confirm 모드라도 여기서는
      // 아무것도 안 한다(§useLocalImport.importCandidate 주석): 만들어진 소스는 그대로 남고, 사용자가
      // 목록에서 나중에 실행하거나 지울 수 있다.
      onClose={onClose}
      width={640}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
            {t("settings.collect_dry_run_notice")}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn" data-testid="collect-dry-run-close-btn" onClick={onClose}>
              {t("common.close")}
            </button>
            {dryRunResult.confirmSource && (
              <button
                type="button"
                className="btn btn-primary"
                data-testid="collect-dry-run-confirm-btn"
                disabled={confirmBusy}
                onClick={onConfirm}
              >
                {confirmBusy ? <Spinner /> : t("settings.collect_dry_run_confirm_btn")}
              </button>
            )}
          </div>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {dryRunResult.sourceKind === "browser_history" && (
          <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", margin: 0 }}>
            {t("settings.collect_browser_open_tabs_hint")}
          </p>
        )}
        {(() => {
          const items = dryRunResult.outcome.items || [];
          const total = items.length;
          const seenCount = items.filter((it: DryRunItem) => it.seen).length;
          const newCount = total - seenCount;
          return (
            <div className="card" style={{ padding: "8px 12px", borderRadius: "var(--radius-md)", border: "1px solid var(--divider)", fontSize: "var(--text-sm)", fontWeight: 600 }}>
              {t("settings.collect_dry_run_summary", {
                total,
                new_count: newCount,
                seen_count: seenCount,
              })}
            </div>
          );
        })()}

        {dryRunResult.outcome.error && (
          <div style={{ color: "var(--danger)", fontSize: "var(--text-sm)", padding: "8px 12px", borderRadius: "var(--radius-sm)", background: "color-mix(in srgb,var(--danger) 10%,transparent)" }}>
            {dryRunResult.outcome.error}
          </div>
        )}

        <div style={{ maxHeight: 360, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }} className="scroll">
          {dryRunResult.outcome.items.length === 0 ? (
            <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", textAlign: "center", padding: 20 }}>
              {t("settings.collect_empty")}
            </p>
          ) : (
            dryRunResult.outcome.items.map((item: DryRunItem, idx: number) => (
              <div
                key={item.guid || idx}
                className="card"
                style={{
                  padding: "10px 12px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--divider)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontWeight: 600, fontSize: "var(--text-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.title || t("note.untitled_note")}
                  </span>
                  <span style={{ flexShrink: 0 }}>
                    <Badge tone={item.seen ? "neutral" : "accent"}>
                      {item.seen
                        ? t("settings.collect_dry_run_badge_seen")
                        : t("settings.collect_dry_run_badge_new")}
                    </Badge>
                  </span>
                </div>
                {item.guid && (
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 4 }}>
                    GUID: {item.guid}
                  </div>
                )}
                {item.preview && (
                  <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", margin: 0, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                    {item.preview}
                  </p>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </ModalShell>
  );
}
