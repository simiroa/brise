import type { MouseEvent } from "react";

/**
 * onMouseDown 용 — 눌러도 본문 에디터의 포커스(=화면 키보드)를 뺏기지 않게 한다.
 * 독·FAB 의 버튼은 입력 도중에 눌리므로(입력 감지 칩 MobileInputChips 와 같은 조건) 버튼으로 포커스가
 * 넘어가 키보드가 내려갔다 올라오는 일이 없어야 한다. 서식 버튼은 이어서 `editor.chain().focus()` 로 포커스를
 * 되돌리지만, 그 사이 키보드가 깜박이므로 애초에 막는다.
 *
 * 예외 하나: IME 조합 중의 서식 버튼(☑·B·I)은 자기 onMouseDown 에서 stopPropagation 으로 이 위임을 끊는다
 * (MobileNoteToolbar::releaseFocusWhileComposing) — 막은 채로 명령을 꽂으면 안드로이드 Gboard 글자가 깨진다.
 *
 * 컨테이너 한 곳에 거는 위임 핸들러다 — MobileImageSizeControls 처럼 우리가 못 고치는 자식 버튼까지 덮는다.
 * `contains` 검사가 필수다: React 합성 이벤트는 **포털을 넘어** 버블되는데, 프리셋 더보기 시트(MobileModal,
 * 포털)의 입력칸 mousedown 까지 막으면 탭해도 포커스가 안 가서 글을 칠 수 없다. DOM 후손일 때만 막는다.
 */
export function keepEditorFocus(e: MouseEvent<HTMLElement>): void {
  if (e.currentTarget.contains(e.target as Node)) e.preventDefault();
}
