import { useUiStore } from "../stores/ui";
import { t } from "../i18n/t";
import { IconChevronsCollapse, IconChevronsExpand } from "./icons";

/**
 * W24(오너): 에디터 푸터 좌측 끝의 접기/펼치기 토글 — 어시스트(previewCollapsed)와 첨부
 * (attachmentsCollapsed)를 한 번에 접어 에디터만 넓게 쓰거나, 둘 다 복원한다.
 * 두 상태가 섞여 있으면(한쪽만 접힘) "둘 다 접기"가 먼저다 — 완전 복원 상태에서만 펼치기.
 * 리치텍스트/시트/다이어그램 상태줄(.section-statusbar) 3곳이 공유하는 단일 컴포넌트.
 *
 * 아이콘 규약은 **에디터 폭 기준**으로 FixedToolbar의 전체 너비 토글과 맞춘다(라벨도
 * "어시스트·첨부 접기 (에디터 확장)"이라 이 버튼의 주어는 에디터다): 지금 좁은 상태면
 * 바깥으로 벌어지는 IconChevronsExpand(=클릭하면 넓어짐), 이미 넓은 상태(둘 다 접힘)면
 * 안으로 모이는 IconChevronsCollapse(=클릭하면 패널이 돌아오며 좁아짐). 예전엔 이 둘이
 * 뒤집혀 있어 같은 뜻의 두 토글이 정반대 그림을 보여줬다.
 *
 * 45도 회전: 전체 너비 토글(수평 그대로)과 한눈에 구분되게 대각선으로 눕힌다 — 좌우 패널을
 * 접어 에디터 면적을 키운다는 뜻이 최대화 아이콘처럼 읽힌다.
 */
export function BodyCollapseToggle() {
  const previewCollapsed = useUiStore((s) => s.previewCollapsed);
  const attachmentsCollapsed = useUiStore((s) => s.attachmentsCollapsed);
  const focusMode = useUiStore((s) => s.focusMode);
  const bothCollapsed = previewCollapsed && attachmentsCollapsed;
  const label = bothCollapsed ? t("editor.body_expand") : t("editor.body_collapse");
  // 접는 대상(어시스트·첨부)이 집중 모드에선 이미 숨어 있다 — 창 스트립의 사이드바 토글을
  // 숨기는 것과 같은 규칙(App.tsx).
  if (focusMode) return null;
  return (
    <button
      type="button"
      className="icon-btn icon-btn--sm icon-btn--glow"
      data-testid="body-collapse-toggle"
      data-active={bothCollapsed ? "true" : undefined}
      onClick={() =>
        useUiStore.setState({
          previewCollapsed: !bothCollapsed,
          attachmentsCollapsed: !bothCollapsed,
        })
      }
      title={label}
      aria-label={label}
      aria-pressed={bothCollapsed}
    >
      {bothCollapsed ? (
        <IconChevronsCollapse size={12} strokeWidth={2} style={{ transform: "rotate(-45deg)" }} />
      ) : (
        <IconChevronsExpand size={12} strokeWidth={2} style={{ transform: "rotate(-45deg)" }} />
      )}
    </button>
  );
}
