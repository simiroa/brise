import { useEffect } from "react";
import { ModalShell } from "../ModalShell";
import { PresetList } from "../PresetList";
import type { AiActionAutoAdd } from "./AiActionEditor";
import { t } from "../../i18n/t";

interface PresetManageModalProps {
  onClose: () => void;
  /** 처음 보일 탭 — 기본은 "노트 프리셋". */
  initialManageTab?: "notes" | "ai_actions";
  /** AI 프리셋 편집기만(탭 줄 없음, 제목도 「AI 프리셋」). AI 모달의 연필·"+추가"가 쓴다 — PresetList 참고. */
  aiOnly?: boolean;
  /** 열리자마자 이 종류로 새 AI 프리셋 하나(AI 모달의 "+추가"). */
  autoAdd?: AiActionAutoAdd;
  /** AI 프리셋 편집기가 처음 고를 항목 — AI 모달의 연필이 지금 고른 타일로 연다. */
  initialId?: string;
}

/**
 * 프리셋 관리 모달(PresetList mode="manage")을 감싸는 얇은 셸 — 앱 안 진입점이 전부 이것 하나다
 * (2026-09-27 오너 "진입점 일원화"): 트리 헤더의 프리셋 아이콘(노트 프리셋 탭으로)과 AI 모달의
 * 연필·"+추가"(AI 프리셋만). 설정 창의 「AI 프리셋」 페이지는 같은 편집기(AiActionEditor)를 페이지에
 * 직접 싣는다 — 노트 프리셋은 "만들기"가 본 창 에디터를 쓰므로 설정 창에 두지 않는다.
 */
export function PresetManageModal({ onClose, initialManageTab, aiOnly, autoAdd, initialId }: PresetManageModalProps) {
  // PresetList의 클릭 핸들러는 모두 lib/presetBridge.ts를 거치고, 그 유일한 등록자(EditorPanel)가
  // newNote() + 프리셋 적용까지 끝낸 뒤 무조건 editor.commands.focus()로 마무리한다
  // (EditorPanel.tsx, bodyMd 유무 판단 바깥) — 그래서 "ProseMirror 에디터가 포커스를 받았다"가
  // 이 모달을 닫을 유일한 신호다(false positive 없음). 클릭 기반 자동 닫기였다면 PresetList의
  // 다른 인터랙티브 요소(이름변경/제거 컨텍스트 메뉴, 아이콘·색 팝오버)에서도 오발동했을 것이다.
  // aiOnly 에는 노트 프리셋 적용 경로가 없어 이 신호가 필요 없다 — 그리고 그 모달은 AI 모달 위에
  // 뜨는데, AI 모달의 요청문 상자도 ProseMirror 라 거기로 포커스가 돌아가는 순간 오발동한다.
  useEffect(() => {
    if (aiOnly) return;
    const onFocusIn = (e: FocusEvent) => {
      if ((e.target as HTMLElement | null)?.closest(".ProseMirror")) onClose();
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [onClose, aiOnly]);

  return (
    // ponytail: ModalShell's own unmount effect restores focus to the trigger button (whichever
    // one opened this instance), which fights the freshly-focused editor the instant this modal
    // closes. Ceiling: a stray focus hop back to the trigger on preset-select. Upgrade path if
    // it's ever noticed — skip ModalShell's restore-focus effect for this one call site.
    <ModalShell title={aiOnly ? t("presets.ai_actions_title") : t("presets.panel_title")} onClose={onClose} width={420}>
      <PresetList mode="manage" initialManageTab={initialManageTab} aiOnly={aiOnly} autoAdd={autoAdd} initialId={initialId} />
    </ModalShell>
  );
}
