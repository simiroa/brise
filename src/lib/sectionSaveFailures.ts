/**
 * 저장 실패의 단일 출처(P0-3·M-11·M-16) — "마지막으로 칠한 본문과 같으면 저장된 것" 가정을 대신한다.
 * 키 = 섹션 id(본문·시트·관계도) 또는 노트 필드(`fieldFailureKey`). 쓰기가 실패하면 넣고, **그 쓰기가 성공할 때만** 뺀다.
 * 나가기 차단(hasUnsavedFailure)·섹션 전환/삽입 거부·다시 시도가 전부 이 집합을 읽는다.
 * 화면 표시(배너)는 여전히 스토어 savedState 가 맡는다 — 이 집합은 "어디가 못 보냈나"만 안다.
 * 스토어를 import 하지 않는다(스토어·컴포넌트 양쪽이 쓴다).
 *
 * retry: 보낸 본문 표시를 되돌려도 다시 보낼 수 없는 자리(AI 가 관계도·시트를 통째로 바꾼 뒤)가 쓰는 재전송 함수.
 * 다시 시도 버튼이 retryFailedSaves 로 부르고, 함수는 성공 시 스스로 clearSaveFailed 한다.
 */
const failed = new Map<string, (() => Promise<void>) | undefined>();

export const fieldFailureKey = (noteId: string, field: string) => `field:${noteId}:${field}`;

export const markSaveFailed = (key: string, retry?: () => Promise<void>) => {
  failed.set(key, retry);
};
export const clearSaveFailed = (key: string) => {
  failed.delete(key);
};
export const hasSaveFailed = (key: string) => failed.has(key);
export const anySaveFailed = (keys: Iterable<string>) => {
  for (const k of keys) if (failed.has(k)) return true;
  return false;
};
export const noteHasSaveFailure = (noteId: string, sectionIds: Iterable<string>) => {
  if (anySaveFailed(sectionIds)) return true;
  const prefix = `field:${noteId}:`;
  for (const k of failed.keys()) {
    if (k.startsWith(prefix)) return true;
  }
  return false;
};
export const retryFailedSaves = async () => {
  for (const retry of [...failed.values()]) {
    if (retry) await retry();
  }
};
/** [그래도 나가기] — 사용자가 버리기로 했다. */
export const clearAllSaveFailures = () => failed.clear();
