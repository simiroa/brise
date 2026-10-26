import { useMemo, useState } from "react";
import type { Attachment } from "../../lib/commands.gen";
import { useNotesStore } from "../../stores/notes";
import { call } from "../../lib/invoke";
import { parseSheet } from "../../lib/sheet/types";
import { SheetEngine } from "../../lib/sheet/engine";
import { SheetChart } from "../sheet/SheetChart";
import { IconChart, IconTrash } from "../icons";
import { t } from "../../i18n/t";

/** `"<section_id>#<chart_id>"` — repo/attachments::add_chart_ref 가 만드는 모양. */
export function splitChartUrl(url: string | null): { sectionId: string; chartId: string } | null {
  if (!url) return null;
  const i = url.indexOf("#");
  if (i <= 0 || i === url.length - 1) return null;
  return { sectionId: url.slice(0, i), chartId: url.slice(i + 1) };
}

/**
 * kind='chart' 첨부의 프리뷰 — **라이브 참조**(PLAN-2026-09-20 D5). 스냅샷이 없다: activeNote.sections
 * 에서 시트 섹션을 찾아 본문을 파싱하고 그 안의 charts[] 스펙으로 SheetChart 를 그린다. 시트 셀이
 * 바뀌면 useSheetState.saveNow 가 activeNote.sections[].body_md 를 갱신하므로(700ms 디바운스) 여기도
 * 따라 다시 그려진다. 섹션이 지워졌거나(휴지통·다른 노트로 이동) 차트가 스펙에서 빠지면 행은 남고
 * "원본 없음" + 삭제 동사(D8).
 */
export function ChartRefPreview({ att }: { att: Attachment }) {
  const sections = useNotesStore((s) => s.activeNote?.sections);
  const [busy, setBusy] = useState(false);
  const ref = splitChartUrl(att.url);
  const section = ref
    ? sections?.find((s) => s.id === ref.sectionId && s.kind === "sheet")
    : undefined;
  const bodyMd = section?.body_md;
  const doc = useMemo(() => (bodyMd == null ? null : parseSheet(bodyMd)), [bodyMd]);
  const engine = useMemo(() => (doc ? new SheetEngine(doc) : null), [doc]);
  const spec = ref && doc ? doc.charts.find((c) => c.id === ref.chartId) : undefined;

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await call("attachment_remove", { id: att.id });
      await useNotesStore.getState().reloadActive();
    } catch {
      // call() 이 토스트를 띄웠다 — 되돌릴 낙관적 상태가 없다.
    } finally {
      setBusy(false);
    }
  };

  if (!doc || !engine || !spec) {
    return (
      <div
        data-testid="chart-ref-missing"
        style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: "var(--space-6)", textAlign: "center" }}
      >
        <IconChart size={40} strokeWidth={1.5} style={{ color: "var(--faint)" }} />
        <div style={{ fontSize: "var(--text-lg)", fontWeight: 600, color: "var(--text)" }}>{att.name}</div>
        <div style={{ fontSize: "var(--text-md)", color: "var(--muted)" }}>{t("attachments.chart_missing_title")}</div>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--faint)", maxWidth: 320 }}>{t("attachments.chart_missing_hint")}</div>
        <button
          type="button"
          className="toolbar-btn toolbar-btn--text"
          onClick={() => void remove()}
          disabled={busy}
          style={{ color: "var(--danger)" }}
        >
          <IconTrash size={14} />
          <span>{t("attachments.remove")}</span>
        </button>
      </div>
    );
  }

  return (
    <div data-testid="chart-ref-preview" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "var(--space-6)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-sm)", color: "var(--muted)" }}>
        <IconChart size={14} strokeWidth={1.8} />
        <span>{section?.name || t("attachments.chart_live_label")}</span>
      </div>
      <div style={{ background: "var(--surface-sunken)", borderRadius: "var(--radius-sm)", border: "1px solid var(--line)", padding: 8 }}>
        <SheetChart spec={spec} doc={doc} engine={engine} height={260} />
      </div>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--faint)" }}>{t("attachments.chart_live_label")}</div>
    </div>
  );
}
