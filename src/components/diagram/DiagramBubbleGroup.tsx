/**
 * DiagramBubbleGroup — 플로팅 버블의 그룹 컨텍스트(이름 변경·그룹 색상·그룹 해제).
 * 위치 계산·바깥 클릭·조기 반환은 DiagramFloatingBubble 셸에 있고, 여기는 그 안에 그려질 항목만 쥔다.
 */
import type { MutableRefObject } from "react";
import { t } from "../../i18n/t";
import { IconChevronsExpand, IconEdit, IconPalette } from "../icons";
import type { DiagramActions } from "./diagramActions";
import type { DiagramCanvasApi } from "./diagramCanvasApi";
import type { DiagramGroup } from "./diagramModel";
import { BubbleMenu, type BubbleMenuCtl } from "./DiagramBubbleMenu";
import { ToneSwatches } from "./ToneSwatches";

export interface DiagramBubbleGroupProps {
  group: DiagramGroup;
  actions: DiagramActions;
  apiRef?: MutableRefObject<DiagramCanvasApi | null>;
  menu: BubbleMenuCtl;
}

export function DiagramBubbleGroup({ group, actions, apiRef, menu }: DiagramBubbleGroupProps) {
  return (
    <>
      {/* 그룹 이름 변경 */}
      <button
        type="button"
        className="diagram-floating-bubble-btn"
        data-testid="diagram-group-rename"
        title={t("editor.diagram_group_rename")}
        aria-label={t("editor.diagram_group_rename")}
        onClick={() => apiRef?.current?.openGroupRename?.(group.id)}
      >
        <IconEdit size={14} strokeWidth={2} />
      </button>

      {/* 그룹 색상(Tone) */}
      <BubbleMenu
        id="group-tone"
        menu={menu}
        label={t("editor.diagram_tone")}
        icon={<IconPalette size={14} strokeWidth={2} />}
        highlight={Boolean(group.tone && group.tone !== "default")}
      >
        {() => (
          <ToneSwatches
            variant="swatch"
            current={group.tone ?? "default"}
            onPick={(tone) => {
              actions.setGroupTone(group.id, tone);
              menu.setActive(null);
            }}
          />
        )}
      </BubbleMenu>

      <span className="diagram-floating-bubble-divider" />

      {/* 그룹 해제 */}
      <button
        type="button"
        className="diagram-floating-bubble-btn"
        data-testid="diagram-group-dissolve"
        title={t("editor.diagram_group_dissolve")}
        aria-label={t("editor.diagram_group_dissolve")}
        onClick={() => actions.dissolveGroup(group.id)}
      >
        <IconChevronsExpand size={14} strokeWidth={2} />
      </button>
    </>
  );
}
