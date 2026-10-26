// 붙여넣기/삽입/드롭 공용 레이스 가드 — 비동기 IPC 왕복(파일 다이얼로그, attachment_add_*,
// section_import_*) 도중 사용자가 다른 노트/섹션으로 옮겨갈 수 있다. target을 await 전에 한 번
// 캡처하고, 마지막 await 뒤 current를 다시 읽어 비교한다. 둘 다 같으면 그대로 문서에 쓰고,
// 다르면(레이스) 서버 저장은 이미 끝났으니 그대로 두되 라이브 문서 삽입만 건너뛴다.
//
// 이전엔 EditorPanel.tsx(isPasteStillOnTarget) · toolbar/buttons.tsx(isInsertStillOnTarget) ·
// useEditorFileDrop.ts(isDropStillOnTarget)가 "순환 임포트라 복제한다"는 주석과 함께 각자
// 이 세 줄을 복제하고 있었다 — 여기 lib/로 옮기면 그 순환 임포트 자체가 없어진다.
export interface OnTargetRef {
  noteId: string;
  sectionId: string | null;
}
export interface OnTargetCurrent {
  noteId: string | undefined;
  sectionId: string | null;
}

export function isStillOnTarget(target: OnTargetRef, current: OnTargetCurrent): boolean {
  return target.noteId === current.noteId && target.sectionId === current.sectionId;
}
