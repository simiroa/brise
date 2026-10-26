import { t } from "../../../i18n/t";
import { IconFileImport } from "../../icons";
import { IconAction } from "../IconAction";
import type { LocalCandidate } from "./useLocalImport";

interface LocalImportPanelProps {
  /** source_id 가 없는 후보만(§TASKS 2) — useLocalImport 가 이미 걸러 준다. */
  ghostCandidates: LocalCandidate[];
  importingKey: string | null;
  onImport: (candidate: LocalCandidate) => void;
}

/** 로컬 소스 감지 결과 — 유령 행(§2.5, W8). 호출자가 "감지를 눌렀는가"(detectDone)를 판정해 감싼다. */
export function LocalImportPanel({ ghostCandidates, importingKey, onImport }: LocalImportPanelProps) {
  return (
    <div data-testid="collect-ghost-list">
      {/* 신뢰 문구(§TASKS 2, PLAN-2026-09-04-local-import §3b) — 읽기전용으로 훑었을 뿐
          아직 아무것도 저장하지 않았음을 감지 결과가 있든 없든 항상 먼저 밝힌다. */}
      <p
        data-testid="collect-detect-trust-hint"
        style={{ fontSize: "var(--text-xs)", color: "var(--muted)", margin: "0 0 var(--space-2)" }}
      >
        {t("settings.collect_detect_trust_hint")}
      </p>
      {ghostCandidates.length === 0 ? (
        <p style={{ fontSize: "var(--text-sm)", color: "var(--muted)", margin: "var(--space-2) 0" }}>
          {t("settings.collect_detect_empty")}
        </p>
      ) : (
        <>
          <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", margin: "0 0 var(--space-2)" }}>
            {t("settings.collect_detect_folder_hint")}
          </p>
          {ghostCandidates.map((c) => (
            <div
              key={c.key}
              data-testid={`collect-ghost-${c.key}`}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "var(--space-4)",
                minHeight: "calc(var(--ctrl-h-lg) + var(--space-3) * 2)",
                boxSizing: "border-box",
                padding: "var(--space-3) var(--space-4)",
                border: "1px dashed var(--divider)",
                borderRadius: "var(--radius-sm)",
                marginBottom: "var(--space-2)",
              }}
            >
              <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                <span
                  style={{
                    fontSize: "var(--text-md)",
                    fontWeight: 600,
                    color: "var(--muted)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {c.label}
                </span>
                <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>{c.detail}</span>
              </div>
              <IconAction
                icon={<IconFileImport size={16} />}
                label={t("settings.collect_detect_import_btn")}
                data-testid={`collect-ghost-import-${c.key}`}
                busy={importingKey === c.key}
                disabled={importingKey !== null}
                onClick={() => onImport(c)}
              />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
