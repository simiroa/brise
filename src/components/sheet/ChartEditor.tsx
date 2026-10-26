import { type FC, useState } from "react";
import { t } from "../../i18n/t";
import { randomId } from "../../lib/ids";
import type { ChartSpec, SheetDoc } from "../../lib/sheet/types";
import type { SheetEngine } from "../../lib/sheet/engine";
import { SheetChart } from "./SheetChart";
import { IconClose, IconPlus, IconTrash } from "../icons";
import { useNotesStore } from "../../stores/notes";
import { isChartRegistered, setChartRegistered } from "../../lib/sheet/chartAttachment";
import { CHART_TYPES, chartTypeById, type ChartType } from "../../lib/sheet/chartTypes";

export interface ChartEditorProps {
  initialSpec?: ChartSpec | null;
  doc: SheetDoc;
  engine?: SheetEngine;
  /** 선택 영역에서 뽑은 기본값(`defaultChartRanges`). 비면 x 축은 행 번호로 떨어진다. */
  defaultXRange?: string;
  defaultSeriesRanges?: string[];
  onSave: (spec: ChartSpec) => void;
  onDelete?: (chartId: string) => void;
  onClose: () => void;
  /** "첨부에 등록" 토글(D6ⓒ)에 필요한 좌표. 둘 다 있어야 토글이 그려진다(SheetSection 이 넘긴다). */
  noteId?: string;
  sectionId?: string;
}

export const ChartEditor: FC<ChartEditorProps> = ({
  initialSpec,
  doc,
  engine,
  defaultXRange = "",
  defaultSeriesRanges,
  onSave,
  onDelete,
  onClose,
  noteId,
  sectionId,
}) => {
  const [type, setType] = useState<ChartType>(initialSpec?.type ?? "bar");
  const [title, setTitle] = useState(initialSpec?.title ?? "");
  const [xRange, setXRange] = useState(initialSpec?.x ?? defaultXRange);
  const [series, setSeries] = useState<string[]>(
    initialSpec?.series?.length
      ? initialSpec.series
      : (defaultSeriesRanges?.length ? defaultSeriesRanges : [""])
  );

  const activeType = chartTypeById(type) ?? CHART_TYPES[0];
  const nonEmptySeries = series.filter((s) => s.trim().length > 0);
  const canSave = nonEmptySeries.length >= activeType.minSeries;

  // "첨부에 등록" — 진실은 DB(activeNote.attachments 의 kind='chart' 행). 기존 차트는 토글이 곧 IPC,
  // 새 차트는 아직 id 가 DB 에 없으니 저장 뒤에 등록한다(registerNew). 낙관적 갱신 없음.
  const attachments = useNotesStore((s) => s.activeNote?.attachments);
  const canRegister = !!noteId && !!sectionId;
  const registered = !!initialSpec && !!sectionId && isChartRegistered(attachments, sectionId, initialSpec.id);
  const [registerNew, setRegisterNew] = useState(false);
  const [registerBusy, setRegisterBusy] = useState(false);
  const chartName = () => title.trim() || t("attachments.chart_untitled");

  const handleToggleRegister = async (on: boolean) => {
    if (!noteId || !sectionId) return;
    if (!initialSpec) {
      setRegisterNew(on);
      return;
    }
    if (registerBusy) return;
    setRegisterBusy(true);
    try {
      await setChartRegistered({ noteId, sectionId, chartId: initialSpec.id, name: chartName(), on });
    } catch {
      // call() 이 토스트를 띄웠다 — 체크 상태는 스토어(DB)에서 다시 읽히므로 되돌릴 것이 없다.
    } finally {
      setRegisterBusy(false);
    }
  };

  const previewSpec: ChartSpec = {
    id: initialSpec?.id ?? "preview_chart",
    type,
    title: title.trim() || undefined,
    x: activeType.needsX ? (xRange.trim() || undefined) : undefined,
    series: nonEmptySeries,
  };

  const handleAddSeries = () => {
    setSeries([...series, ""]);
  };

  const handleUpdateSeries = (index: number, val: string) => {
    const next = [...series];
    next[index] = val;
    setSeries(next);
  };

  const handleRemoveSeries = (index: number) => {
    setSeries(series.filter((_, i) => i !== index));
  };

  const handleSave = () => {
    if (!canSave) return;
    const specToSave: ChartSpec = {
      id: initialSpec?.id ?? randomId("chart"),
      type,
      title: title.trim() || undefined,
      x: activeType.needsX ? (xRange.trim() || undefined) : undefined,
      series: nonEmptySeries,
    };
    onSave(specToSave);
    onClose();
    // 새 차트를 등록하기로 했으면 저장 뒤에 이어 붙인다 — setChartRegistered 가 flushAll 로 시트
    // 본문을 먼저 DB 에 보내므로 Rust 의 charts[] 검증을 통과한다. 편집기는 이미 닫혔으니 상태
    // 갱신 없이 결과는 reloadActive 가 첨부 바에 반영한다.
    if (!initialSpec && registerNew && noteId && sectionId) {
      void (async () => {
        try {
          await setChartRegistered({ noteId, sectionId, chartId: specToSave.id, name: chartName(), on: true });
        } catch {
          // call() 이 토스트를 띄웠다.
        }
      })();
    }
  };

  return (
    <div className="sheet-modal-backdrop" onClick={onClose}>
      <div
        className="sheet-modal-content"
        style={{
          width: 520,
          borderRadius: "var(--radius-md)",
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
        onClick={(e) => e.stopPropagation()}
      >

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0, fontSize: "var(--text-lg)", fontWeight: 600, color: "var(--text)" }}>
            {t("editor.sheet_chart")}
          </h3>
            <button
            type="button"
            className="toolbar-btn"
            onClick={onClose}
            style={{ padding: 4 }}
          >
            <IconClose size={16} />
          </button>
        </div>

        {/* 차트 실시간 미리보기 */}
        <div
          style={{
            background: "var(--surface-sunken)",
            borderRadius: "var(--radius-sm)",
            overflow: "hidden", // 미리보기는 패딩 없이 가장자리까지(PLAN-2026-09-30 §3)
          }}
        >
          <SheetChart spec={previewSpec} doc={doc} engine={engine} height={180} />
        </div>

        {/* 차트 유형 선택 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: "var(--text-sm)", color: "var(--muted)", fontWeight: 400 }}>
            {t("editor.sheet_chart")}
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {CHART_TYPES.map((c) => (
              <button
                key={c.id}
                type="button"
                data-testid={`chart-type-${c.id}`}
                className="toolbar-btn toolbar-btn--text"
                style={{
                  flex: "1 0 30%",
                  padding: "6px 8px",
                  background: type === c.id ? "var(--sel)" : "transparent",
                  borderColor: type === c.id ? "var(--accent)" : "var(--line)",
                  color: type === c.id ? "var(--accent)" : "var(--text)",
                }}
                onClick={() => setType(c.id)}
              >
                {t(c.nameKey)}
              </button>
            ))}
          </div>
        </div>

        {/* 차트 제목 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: "var(--text-sm)", color: "var(--muted)", fontWeight: 400 }}>
            {t("editor.sheet_chart_title")}
          </label>
          <input
            className="sheet-formula-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("editor.sheet_chart_title")}
          />
        </div>

        {/* X축 범위 — needsX:false 인 종류(산점도·KPI)는 x 를 안 쓴다(첫/둘째 시리즈가 대신한다). */}
        {activeType.needsX && (
          <div data-testid="chart-x-range-field" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: "var(--text-sm)", color: "var(--muted)", fontWeight: 400 }}>
              {t("editor.sheet_chart_x_axis")}
            </label>
            <input
              className="sheet-formula-input"
              value={xRange}
              onChange={(e) => setXRange(e.target.value)}
              placeholder="e.g. A2:A10"
            />
          </div>
        )}

        {/* 시리즈 범위 목록 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <label style={{ fontSize: "var(--text-sm)", color: "var(--muted)", fontWeight: 400 }}>
              {t("editor.sheet_chart_series")}
            </label>
            <button
              type="button"
              className="toolbar-btn toolbar-btn--text"
              onClick={handleAddSeries}
              style={{ fontSize: "var(--text-xs)", padding: "var(--space-2xs) 6px" }}
            >
              <IconPlus size={12} />
              <span>{t("editor.sheet_add_col")}</span>
            </button>
          </div>
          {series.map((s, idx) => (
            <div key={idx} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                className="sheet-formula-input"
                value={s}
                onChange={(e) => handleUpdateSeries(idx, e.target.value)}
                placeholder="e.g. B2:B10"
              />
              {series.length > 1 && (
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={() => handleRemoveSeries(idx)}
                  style={{ padding: 4 }}
                >
                  <IconTrash size={14} />
                </button>
              )}
            </div>
          ))}
        </div>

        {/* 첨부에 등록(D6ⓒ) — 차트 카드의 아이콘 버튼과 같은 setChartRegistered 를 부른다 */}
        {canRegister && (
          <label
            data-testid="chart-register-toggle"
            style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: "var(--text-sm)", color: "var(--text)", cursor: registerBusy ? "progress" : "pointer" }}
          >
            <input
              type="checkbox"
              checked={initialSpec ? registered : registerNew}
              disabled={registerBusy}
              onChange={(e) => void handleToggleRegister(e.target.checked)}
              style={{ marginTop: "var(--space-2xs)" }}
            />
            <span style={{ display: "flex", flexDirection: "column", gap: "var(--space-2xs)" }}>
              <span>{t("attachments.chart_register")}</span>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>{t("attachments.chart_register_hint")}</span>
            </span>
          </label>
        )}

        {/* minSeries 미달 힌트 — 예: 산점도는 x/y 두 시리즈가 필요하다. */}
        {!canSave && (
          <div data-testid="chart-min-series-hint" style={{ fontSize: "var(--text-xs)", color: "var(--danger)" }}>
            {t("editor.sheet_chart_min_series_hint", { count: activeType.minSeries })}
          </div>
        )}

        {/* 하단 액션 버튼 */}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
          {initialSpec && onDelete ? (
            <button
              type="button"
              className="toolbar-btn toolbar-btn--text"
              onClick={() => {
                onDelete(initialSpec.id);
                onClose();
              }}
              style={{ color: "var(--danger)" }}
            >
              <IconTrash size={14} />
              <span>{t("common.delete")}</span>
            </button>
          ) : (
            <div />
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="toolbar-btn toolbar-btn--text" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="toolbar-btn toolbar-btn--text"
              onClick={handleSave}
              disabled={!canSave}
              style={{
                background: "var(--accent)",
                color: "#ffffff",
                fontWeight: 600,
                padding: "6px 14px",
                opacity: canSave ? 1 : 0.5,
                cursor: canSave ? "pointer" : "not-allowed",
              }}
            >
              {t("common.apply")}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
