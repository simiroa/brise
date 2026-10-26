// 노트 제목 표시 판정 — 스토어를 싣지 않는 창(펫·브리핑)도 쓰는 순수 헬퍼.
// 새 노트의 저장 제목은 센티널 "Untitled Note" 다(stores/notesActive.ts 가 만든다). 메인 창은
// notesActive.displayTitle 이 이것을 '제목 없음' 으로 바꾸지만, 펫·브리핑 창은 그 스토어를 싣지 않아
// '"Untitled Note" 와 …' 처럼 원문이 새고 있었다(2026-10-18 화면 보드 리뷰).
// ponytail: 같은 리터럴이 notesActive.displayTitle · runAiAction.ts · presets.ts · mobile/* 에 복제돼 있다.
// notesActive.ts 를 고칠 수 있을 때(역슬래시 수정 머지 뒤) displayTitle 이 이 함수를 쓰게 옮겨 한 곳으로 모은다.

export const UNTITLED_NOTE_SENTINEL = "Untitled Note";

/** 저장 제목이 비었거나 센티널이면 "" — 화면은 각자의 '제목 없음' 문구로 채워 그린다. */
export function storedTitleOrEmpty(title: string | null | undefined): string {
  if (!title || !title.trim() || title === UNTITLED_NOTE_SENTINEL) return "";
  return title;
}
