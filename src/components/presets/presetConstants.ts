import type { ComponentType, CSSProperties, ReactNode } from "react";
import type { BuiltinPresetId, CustomPreset } from "../../stores/presets";
import {
  IconNote,
  IconCheck,
  IconGraph,
  IconSheet,
  IconWallet,
  IconClock,
  IconMap,
  IconTimeline,
  type IconProps,
} from "../icons";

export const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  padding: "var(--space-2) var(--space-4)",
};

/** 빌트인 프리셋의 고정 아이콘 — 사용자가 못 바꾼다(커스텀만 IconGrid 로 지정). 칩 스트립에서는
 *  실루엣이 서로 구별돼야 해서 오늘 기록/여행 기록/회고가 각자 아이콘을 갖는다(전부 기존 아이콘). */
export const BUILTIN_CHIPS: { id: BuiltinPresetId; labelKey: string; Icon: ComponentType<IconProps> }[] = [
  { id: "blank", labelKey: "presets.blank_name", Icon: IconNote },
  { id: "todo", labelKey: "presets.todo_name", Icon: IconCheck },
  { id: "daily", labelKey: "presets.daily_name", Icon: IconClock },
  { id: "travel", labelKey: "presets.travel_name", Icon: IconMap },
  { id: "retro", labelKey: "presets.retro_name", Icon: IconTimeline },
  { id: "diagram", labelKey: "presets.diagram_name", Icon: IconGraph },
  { id: "diagram_mindmap", labelKey: "presets.diagram_mindmap_name", Icon: IconGraph },
  { id: "diagram_sequence", labelKey: "presets.diagram_sequence_name", Icon: IconTimeline },
  { id: "sheet", labelKey: "presets.sheet_name", Icon: IconSheet },
  { id: "budget", labelKey: "presets.budget_name", Icon: IconWallet },
  { id: "sheet_schedule", labelKey: "presets.sheet_schedule_name", Icon: IconClock },
  { id: "sheet_tracker", labelKey: "presets.sheet_tracker_name", Icon: IconCheck },
];

/** ⑨ 어시스트 패널 전용 동사형 라벨(오너 3차 피드백) — "+" 메뉴/관리 모달은 명사형 그대로 두고
 *  (BUILTIN_CHIPS.labelKey), 이 패널(strips)만 렌더 시점에 바꿔 읽는다. 새 i18n 키만 추가했다. */
export const BUILTIN_VERB_LABEL_KEY: Partial<Record<BuiltinPresetId, string>> = {
  blank: "presets.blank_verb",
  todo: "presets.todo_verb",
  daily: "presets.daily_verb",
  travel: "presets.travel_verb",
  retro: "presets.retro_verb",
  diagram: "presets.diagram_verb",
  diagram_mindmap: "presets.diagram_mindmap_verb",
  diagram_sequence: "presets.diagram_sequence_verb",
  sheet: "presets.sheet_verb",
  budget: "presets.budget_verb",
  sheet_schedule: "presets.sheet_schedule_verb",
  sheet_tracker: "presets.sheet_tracker_verb",
};

/** 목록에 그릴 항목 하나 — 행(PresetRow)이든 칩(PresetChip)이든 같은 데이터에서 나온다. */
export interface Entry {
  key: string;
  label: string;
  icon: ReactNode;
  locked: boolean;
  onApply: () => void;
  onMake?: (landing: "new-note" | "new-section") => void;
  hover: { onMouseEnter?: () => void; onMouseLeave?: () => void };
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRename?: () => void;
  onRemove?: () => void;
  /** 커스텀 프리셋만 — 우클릭 메뉴/관리 행의 아이콘·색 진입점이 이 좌표로 팝오버를 연다. */
  custom?: CustomPreset;
}
