import { type ComponentType, type FC, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n/t";
import { useToolbarRovingFocus } from "../common/useToolbarRovingFocus";
import { ToolbarButton, ToolbarDivider } from "../common/toolbar";
import { ChartEditor } from "../../lazySurfaces";
import { preloadIntentProps } from "../../lib/lazyPreload";
import { useDismiss, useMenuPos } from "../../lib/ui";
import type { CellFmt } from "../../lib/sheet/types";
import {
  IconCalendar,
  IconCheck,
  IconChart,
  IconColumnDelete,
  IconColumnInsert,
  IconDecimalLess,
  IconDecimalMore,
  IconEraser,
  IconFmtCurrency,
  IconFmtNumber,
  IconFmtPercent,
  IconFmtText,
  IconImageExport,
  IconPlus,
  IconRedo,
  IconRowDelete,
  IconRowInsert,
  IconSortAsc,
  IconSortDesc,
  IconUndo,
} from "../icons";

/** 소수 자릿수 상한 — Intl 이 21까지 받지만 시트에서 의미 있는 범위는 여기까지. */
const DP_MAX = 6;

/** 소수 자릿수가 의미 있는 서식. 나머지에서는 ± 버튼이 (숨김이 아니라) 비활성이다. */
const NUMERIC_FMTS: ReadonlySet<CellFmt> = new Set<CellFmt>(["number", "currency", "percent"]);

const FORMATS: ReadonlyArray<{ fmt: CellFmt; Icon: ComponentType<{ size?: number }>; key: string }> = [
  { fmt: "text", Icon: IconFmtText, key: "editor.sheet_fmt_text" },
  { fmt: "number", Icon: IconFmtNumber, key: "editor.sheet_fmt_number" },
  { fmt: "currency", Icon: IconFmtCurrency, key: "editor.sheet_fmt_currency" },
  { fmt: "percent", Icon: IconFmtPercent, key: "editor.sheet_fmt_percent" },
  { fmt: "date", Icon: IconCalendar, key: "editor.sheet_fmt_date" },
  { fmt: "checkbox", Icon: IconCheck, key: "editor.sheet_fmt_checkbox" },
];

export interface SheetToolbarProps {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  activeFormat?: CellFmt;
  /** 활성 열의 소수 자릿수. 미지정 = 0 취급(± 의 기준점). */
  activeDp?: number;
  onSetFormat: (fmt: CellFmt, dp?: number, cur?: string) => void;
  /** 활성 열의 소수 자릿수를 이 값으로. 클램프(0..6)는 툴바가 이미 끝냈다. */
  onSetDecimals: (dp: number) => void;
  /** 선택 위치 기준 구조 편집 — 우클릭 메뉴에만 있던 길을 툴바로 꺼냈다. */
  onInsertRow: () => void;
  onDeleteRow: () => void;
  onInsertCol: () => void;
  onDeleteCol: () => void;
  /** 맨 끝에 덧붙이기 (삽입과 달리 선택 위치와 무관). */
  onAddRow: () => void;
  onAddCol: () => void;
  onSortAsc: () => void;
  onSortDesc: () => void;
  /** 선택 영역 내용 지우기. 지울 내용이 없으면 `canClear` 가 false. */
  onClear: () => void;
  canClear: boolean;
  onOpenChart?: () => void;
  onExportCsv: () => void;
}

/**
 * 서식 6종을 인라인 토글 6개로 늘어놓는 대신 **현재 서식 아이콘 하나 + 팝오버**로 접었다.
 * 툴바가 이미 15개 컨트롤이라 6개를 더 늘어놓으면 보통 편집기 폭에서 두 줄로 접히고, 라벨 없는
 * 아이콘 6개만으로는 `%`·`#` 구분이 서지 않는다 — 팝오버는 이름을 같이 보여준다.
 * 떠 있는 표면은 새로 만들지 않고 저장소 공통 패턴(`.overlay` + `useMenuPos` + `useDismiss`,
 * 선례 `diagram/NodePicker.tsx`)을 그대로 쓴다.
 */
const FormatPicker: FC<{ value: CellFmt; onPick: (fmt: CellFmt) => void }> = ({ value, onPick }) => {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const { ref: listRef, x, y } = useMenuPos(anchor);
  const btnRef = useRef<HTMLButtonElement>(null);
  const open = anchor !== null;

  useDismiss(open, [listRef, btnRef], () => setAnchor(null));

  const current = FORMATS.find((f) => f.fmt === value) ?? FORMATS[0];
  const label = `${t("editor.sheet_format")}: ${t(current.key)}`;

  return (
    <>
      <ToolbarButton
        ref={btnRef}
        testid="sheet-format-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        active={open}
        title={label}
        onClick={() => {
          if (open) return setAnchor(null);
          const r = btnRef.current?.getBoundingClientRect();
          setAnchor({ x: r?.left ?? 0, y: r?.bottom ?? 0 });
        }}
      >
        <current.Icon size={15} />
      </ToolbarButton>
      {open &&
        createPortal(
          <div
            ref={listRef}
            className="overlay"
            role="listbox"
            aria-label={t("editor.sheet_format")}
            data-testid="sheet-format-list"
            style={{
              position: "fixed",
              left: x,
              top: y,
              zIndex: "var(--z-dropdown)",
              minWidth: 150,
              padding: "var(--space-1)",
              boxShadow: "var(--shadow-lg)",
            }}
          >
            {FORMATS.map(({ fmt, Icon, key }) => (
              <button
                key={fmt}
                type="button"
                className="menu-row menu-item"
                role="option"
                aria-selected={fmt === value}
                data-selected={fmt === value}
                onClick={() => {
                  onPick(fmt);
                  setAnchor(null);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  whiteSpace: "nowrap",
                  cursor: "pointer",
                  color: fmt === value ? "var(--accent)" : "var(--text)",
                }}
              >
                <Icon size={14} />
                {t(key)}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
};

export const SheetToolbar: FC<SheetToolbarProps> = ({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  activeFormat = "text",
  activeDp = 0,
  onSetFormat,
  onSetDecimals,
  onInsertRow,
  onDeleteRow,
  onInsertCol,
  onDeleteCol,
  onAddRow,
  onAddCol,
  onSortAsc,
  onSortDesc,
  onClear,
  canClear,
  onOpenChart,
  onExportCsv,
}) => {
  const dpEditable = NUMERIC_FMTS.has(activeFormat);
  const roving = useToolbarRovingFocus<HTMLDivElement>();

  return (
    <div
      className="scroll noscroll sheet-toolbar section-toolbar"
      role="toolbar"
      aria-label={t("editor.sheet_name")}
      ref={roving.ref}
      onKeyDown={roving.onKeyDown}
      style={{ display: "flex", alignItems: "center", width: "100%" }}
    >
      {/* Zone 1: Leading controls */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", flex: "none" }}>
        <ToolbarButton title={t("editor.diagram_undo")} onClick={onUndo} disabled={!canUndo}>
          <IconUndo size={15} />
        </ToolbarButton>
        <ToolbarButton title={t("editor.diagram_redo")} onClick={onRedo} disabled={!canRedo}>
          <IconRedo size={15} />
        </ToolbarButton>

        <ToolbarDivider />

        <FormatPicker value={activeFormat} onPick={(fmt) => onSetFormat(fmt)} />
        <ToolbarButton
          title={t("editor.sheet_dp_less")}
          testid="sheet-dp-less"
          onClick={() => onSetDecimals(Math.max(0, activeDp - 1))}
          disabled={!dpEditable || activeDp <= 0}
        >
          <IconDecimalLess size={15} />
        </ToolbarButton>
        <ToolbarButton
          title={t("editor.sheet_dp_more")}
          testid="sheet-dp-more"
          onClick={() => onSetDecimals(Math.min(DP_MAX, activeDp + 1))}
          disabled={!dpEditable || activeDp >= DP_MAX}
        >
          <IconDecimalMore size={15} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton title={t("editor.sheet_insert_row_above")} onClick={onInsertRow}>
          <IconRowInsert size={15} />
        </ToolbarButton>
        <ToolbarButton title={t("editor.sheet_delete_row")} onClick={onDeleteRow}>
          <IconRowDelete size={15} />
        </ToolbarButton>
        <ToolbarButton title={t("editor.sheet_add_row")} onClick={onAddRow}>
          <IconPlus size={15} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton title={t("editor.sheet_insert_col_left")} onClick={onInsertCol}>
          <IconColumnInsert size={15} />
        </ToolbarButton>
        <ToolbarButton title={t("editor.sheet_delete_col")} onClick={onDeleteCol}>
          <IconColumnDelete size={15} />
        </ToolbarButton>
        <ToolbarButton title={t("editor.sheet_add_col")} onClick={onAddCol}>
          <IconPlus size={15} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton title={t("editor.sheet_sort_asc")} onClick={onSortAsc}>
          <IconSortAsc size={15} />
        </ToolbarButton>
        <ToolbarButton title={t("editor.sheet_sort_desc")} onClick={onSortDesc}>
          <IconSortDesc size={15} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton
          title={t("editor.sheet_clear_contents")}
          testid="sheet-clear"
          onClick={onClear}
          disabled={!canClear}
        >
          <IconEraser size={15} />
        </ToolbarButton>
      </div>

      {/* Zone 2: Contextual slot / Spacer */}
      <div style={{ flex: "1 1 auto" }} />

      {/* Zone 3: Trailing controls */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", flex: "none" }}>
        <ToolbarDivider />

        {onOpenChart && (
          <ToolbarButton title={t("editor.sheet_chart")} onClick={onOpenChart} {...preloadIntentProps(ChartEditor)}>
            <IconChart size={15} />
          </ToolbarButton>
        )}
        <ToolbarButton title={t("editor.sheet_export_csv")} onClick={onExportCsv}>
          <IconImageExport size={15} />
        </ToolbarButton>
      </div>
    </div>
  );
};
