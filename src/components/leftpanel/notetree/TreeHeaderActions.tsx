import { useState } from "react";
import { useUiStore } from "../../../stores/ui";
import { IconNote, IconTrash } from "../../icons";
import { t } from "../../../i18n/t";
import { PresetManageModal } from "../../presets/PresetManageModal";

/**
 * Two quick icon buttons next to the tree header's "add folder" button (owner feedback):
 * presets (opens the shared PresetManageModal, mode="manage") and trash (opens the already-global
 * TrashModal, App.tsx:600, self-gated on useUiStore.trashOpen — no local modal needed here).
 *
 * PLAN-2026-08-30 §3 W4: the modal shell + its focus-handoff auto-close (PresetList's click
 * handlers all go through lib/presetBridge.ts, whose only registrant — EditorPanel — ends every
 * path in an unconditional editor.commands.focus(), the one signal that closes this modal with no
 * false positive against PresetList's own context menus/popovers) moved to
 * components/presets/PresetManageModal.tsx once a second entry point needed the exact same behavior.
 * 2026-09-27(오너 "진입점 일원화"): 앱 안의 프리셋 편집 진입점은 전부 이 모달이다 — 여기(노트 프리셋 탭
 * 으로)와 AI 모달의 연필·"+추가"(AI 프리셋만). 설정 창은 「AI 프리셋」 페이지가 같은 편집기를 싣는다.
 */
export function TreeHeaderActions() {
  const openTrash = useUiStore((s) => s.openTrash);
  const [presetsOpen, setPresetsOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setPresetsOpen(true)}
        title={t("presets.manage_open")}
        aria-label={t("presets.manage_open")}
        className="icon-btn icon-btn--sm icon-btn--glow"
      >
        <IconNote size={14} strokeWidth={2} />
      </button>
      <button
        type="button"
        onClick={openTrash}
        title={t("trash.title")}
        aria-label={t("trash.title")}
        className="icon-btn icon-btn--sm icon-btn--glow"
      >
        <IconTrash size={14} strokeWidth={2} />
      </button>

      {/* W7-d: 관리 모달 역할 정리 — 순서·이름변경·제거·만들기(새 노트/새 섹션 2옵션 메뉴,
          2026-08-26: "적용"의 제자리 적용은 제거 — 착지는 사용자가 고른다). mode="manage" 는 행
          클릭 자체가 더 이상 프리셋을 적용하지 않게 만든다(오너 피드백: "관리 모달인데 실행기처럼
          느껴짐"). 적용의 주 경로는 그대로 SourcePanel의 빈 에디터 미리보기(mode="picker", 기본값).
          트리 헤더에서 열 때는 기본 탭("노트 프리셋")으로 연다. */}
      {presetsOpen && <PresetManageModal onClose={() => setPresetsOpen(false)} />}
    </>
  );
}
