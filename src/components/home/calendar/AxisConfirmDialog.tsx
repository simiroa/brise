import { PromptDialog } from "../../PromptDialog";
import { t } from "../../../i18n/t";
import type { ConfirmState } from "./useAxisConfirmFlow";
import { mdLabel } from "./useAxisConfirmFlow";

export { mdLabel };

export type AxisConfirmDialogProps = {
  confirm: ConfirmState | null;
  onResolveSpanDrop: (c: Extract<ConfirmState, { kind: "spanDrop" }>, choice: string) => void | Promise<void>;
  onResolveRepeatApply: (c: Extract<ConfirmState, { kind: "repeatApply" }>) => void | Promise<void>;
  onResolveDeleteRepeat: (c: Extract<ConfirmState, { kind: "deleteRepeat" }>) => void;
  onResolveDeleteEvent: (c: Extract<ConfirmState, { kind: "deleteEvent" }>) => void;
  onCancel: () => void;
};

export function AxisConfirmDialog({
  confirm,
  onResolveSpanDrop,
  onResolveRepeatApply,
  onResolveDeleteRepeat,
  onResolveDeleteEvent,
  onCancel,
}: AxisConfirmDialogProps) {
  if (!confirm) return null;

  return (
    <>
      {/* D2 — 여러 날 span 을 첫날 아닌 곳에 놓았을 때. 선택지 값은 "first"/"here" 두 값뿐이라
          choice 모드(취소 포함 N 개 액션)를 그대로 쓴다 — 새 컴포넌트를 뽑지 않는다
          (src/components/PromptDialog.tsx 가 이미 이 저장소 전역의 "확인/선택" 공용 다이얼로그다,
          예: TrashModal 의 purgeOne). */}
      {confirm.kind === "spanDrop" && (
        <PromptDialog
          title={t("home.cal_span_drop_title")}
          mode="choice"
          choices={[
            { value: "first", label: t("home.cal_span_drop_first", { day: mdLabel(confirm.firstDay) }) },
            { value: "here", label: t("home.cal_span_drop_here", { day: mdLabel(confirm.day) }) },
          ]}
          onSubmit={(value) => void onResolveSpanDrop(confirm, value as string)}
          onCancel={onCancel}
        />
      )}

      {/* D4 — 반복 편집의 "적용"은 초안일 뿐, 실제 저장 전에 한 번 더 확인한다. */}
      {confirm.kind === "repeatApply" && (
        <PromptDialog
          title={t("home.cal_repeat_apply_title")}
          description={t("home.cal_repeat_apply_confirm")}
          mode="confirm"
          confirmLabel={t("common.apply")}
          onSubmit={() => void onResolveRepeatApply(confirm)}
          onCancel={onCancel}
        />
      )}

      {/* D5 — 회차 칩의 Delete 는 반복이면 확인 뒤 removeDateRow(대표 행 삭제 → 반복 전체 제거). */}
      {confirm.kind === "deleteRepeat" && (
        <PromptDialog
          title={t("home.cal_repeat_delete_title")}
          description={t("home.cal_repeat_delete_confirm")}
          mode="confirm"
          danger
          confirmLabel={t("common.delete")}
          onSubmit={() => onResolveDeleteRepeat(confirm)}
          onCancel={onCancel}
        />
      )}

      {/* 오너 실기 2026-09-16 — 반복 없는 칩의 Delete/Backspace 도 이제 한 번 물어본다. */}
      {confirm.kind === "deleteEvent" && (
        <PromptDialog
          title={t("home.cal_delete_title")}
          description={t("home.cal_delete_confirm")}
          mode="confirm"
          danger
          confirmLabel={t("common.delete")}
          onSubmit={() => onResolveDeleteEvent(confirm)}
          onCancel={onCancel}
        />
      )}
    </>
  );
}
