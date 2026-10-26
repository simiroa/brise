import { type FC, type ReactNode } from "react";
import { t } from "../../i18n/t";
import { ContextMenuShell } from "../common/ContextMenuShell";
import {
  IconArrowUp,
  IconArrowDown,
  IconArrowLeft,
  IconArrowRight,
  IconRowDelete,
  IconColumnDelete,
  IconSort,
  IconCopy,
  IconPaste,
} from "../icons";

export interface SheetContextMenuProps {
  pos: { x: number; y: number } | null;
  onClose: () => void;
  target: {
    type: "cell" | "row" | "col";
    row?: number;
    col?: number;
    a1?: string;
  } | null;
  onInsertRowAbove?: () => void;
  onInsertRowBelow?: () => void;
  onDeleteRow?: () => void;
  /** 첫 행 고정 여부(라벨 전환용) — PLAN-2026-09-21 W2. */
  frozenRowActive?: boolean;
  onToggleFreezeRow?: () => void;
  onInsertColLeft?: () => void;
  onInsertColRight?: () => void;
  onDeleteCol?: () => void;
  onSortAsc?: () => void;
  onSortDesc?: () => void;
  onCopy?: () => void;
  onCut?: () => void;
  onPaste?: () => void;
}

/**
 * 시트 우클릭 메뉴. 2026-09-09 부터 앱 공용 `ContextMenuShell` 위에 선다 — 그전에는 포털·백드롭·
 * 바깥클릭/Escape·화면 밖 클램프(`Math.min(x, innerWidth - 220)`)·항목 스타일을 전부 자기가 다시
 * 구현한 **두 번째 컨텍스트 메뉴**였다. 지금은 자리 계산은 `useMenuPos`(양축 플립), 닫기는 쉘,
 * 항목 밀도는 `.overlay .menu-row.menu-item` 한 규칙이 갖는다.
 *
 * 서식 6줄이 여기 없는 이유: 툴바가 아이콘 6개 + 소수 자릿수까지 들고 있고, 우클릭이 이제 그
 * 열을 활성으로 만든다(SheetGrid.handleContextMenu).
 */
const Item: FC<{ icon: ReactNode; label: string; onClick: () => void }> = ({ icon, label, onClick }) => (
  <button type="button" role="menuitem" className="menu-row menu-item" onClick={onClick}>
    {icon}
    <span>{label}</span>
  </button>
);

export const SheetContextMenu: FC<SheetContextMenuProps> = ({
  pos,
  onClose,
  target,
  onInsertRowAbove,
  onInsertRowBelow,
  onDeleteRow,
  frozenRowActive,
  onToggleFreezeRow,
  onInsertColLeft,
  onInsertColRight,
  onDeleteCol,
  onSortAsc,
  onSortDesc,
  onCopy,
  onCut,
  onPaste,
}) => {
  if (!target) return null;

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const clipboard = [
    onCopy && <Item key="copy" icon={<IconCopy size={14} />} label={t("editor.copy")} onClick={run(onCopy)} />,
    onCut && <Item key="cut" icon={<IconCopy size={14} />} label={t("editor.cut")} onClick={run(onCut)} />,
    onPaste && <Item key="paste" icon={<IconPaste size={14} />} label={t("editor.paste")} onClick={run(onPaste)} />,
  ].filter(Boolean);

  const rows = [
    onInsertRowAbove && (
      <Item key="ra" icon={<IconArrowUp size={14} />} label={t("editor.sheet_insert_row_above")} onClick={run(onInsertRowAbove)} />
    ),
    onInsertRowBelow && (
      <Item key="rb" icon={<IconArrowDown size={14} />} label={t("editor.sheet_insert_row_below")} onClick={run(onInsertRowBelow)} />
    ),
    onDeleteRow && (
      <Item key="rd" icon={<IconRowDelete size={14} />} label={t("editor.sheet_delete_row")} onClick={run(onDeleteRow)} />
    ),
    // 첫 행 고정/해제(PLAN-2026-09-21 W2) — 전용 아이콘이 없어 "위로" 화살표를 재사용한다(고정 =
    // 스크롤 맨 위에 못 박는다는 은유). 새 아이콘 추가는 공유 파일(icons.tsx)이라 이번 웨이브 몫이 아니다.
    onToggleFreezeRow && (
      <Item
        key="freeze"
        icon={<IconArrowUp size={14} />}
        label={frozenRowActive ? t("editor.sheet_unfreeze_row") : t("editor.sheet_freeze_row")}
        onClick={run(onToggleFreezeRow)}
      />
    ),
  ].filter(Boolean);

  const cols = [
    onInsertColLeft && (
      <Item key="cl" icon={<IconArrowLeft size={14} />} label={t("editor.sheet_insert_col_left")} onClick={run(onInsertColLeft)} />
    ),
    onInsertColRight && (
      <Item key="cr" icon={<IconArrowRight size={14} />} label={t("editor.sheet_insert_col_right")} onClick={run(onInsertColRight)} />
    ),
    onDeleteCol && (
      <Item key="cd" icon={<IconColumnDelete size={14} />} label={t("editor.sheet_delete_col")} onClick={run(onDeleteCol)} />
    ),
  ].filter(Boolean);

  const sorts = [
    onSortAsc && <Item key="sa" icon={<IconSort size={14} />} label={t("editor.sheet_sort_asc")} onClick={run(onSortAsc)} />,
    onSortDesc && <Item key="sd" icon={<IconSort size={14} />} label={t("editor.sheet_sort_desc")} onClick={run(onSortDesc)} />,
  ].filter(Boolean);

  const groups = [clipboard, rows, cols, sorts].filter((g) => g.length > 0);

  return (
    <ContextMenuShell anchor={pos} onClose={onClose} testId="sheet-context-menu" minWidth={180}>
      {groups.map((group, i) => (
        <div key={i}>
          {i > 0 && <div className="menu-sep" />}
          {group}
        </div>
      ))}
    </ContextMenuShell>
  );
};
