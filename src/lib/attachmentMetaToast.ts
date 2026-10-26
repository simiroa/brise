// 사진 EXIF·음성 업로드 메타가 노트 날짜/경유지에 **자동 반영**됐을 때(서버 이벤트
// "attachment-meta-applied", repo::attachments::exif_region) 되돌리기 토스트를 띄우고 되돌린다.
// PLAN-2026-10-06-s2-input.md §1.1 — "자동"을 안전하게 만드는 것은 질문이 아니라 되돌리기다.
//
// 되돌리기는 새 커맨드 없이 기존 것을 재사용한다: 관련 날짜 = note_date_remove, 경유지 =
// note_region_remove. 대표 날짜는 서버가 건드리지 않으므로 복원 경로가 없다.
import { t } from "../i18n/t";
import { useNotesStore } from "../stores/notes";
import { call } from "./invoke";
import { bumpNoteQueryVersion } from "./noteQuery";
import { showToastOnly } from "./undo";

export interface AttachmentMetaApplied {
  note_id: string;
  /** 새로 만든 관련 날짜 행. */
  date_row_id?: string | null;
  region_row_id?: string | null;
  /** "2026-10-03 · 서울" — 서버가 만든 표시용 요약. */
  summary: string;
}

/** 서버가 DB 를 바꿨다 — 데스크톱 웹뷰는 낸 창을 모르는 local 이벤트(백그라운드 작업)를 트리만 재조회하고 열린 노트는 안 건드리므로(remoteNoteWrite.ts) 여기서 직접 새로고침한다. */
async function refresh(noteId: string): Promise<void> {
  bumpNoteQueryVersion();
  const s = useNotesStore.getState();
  s.bumpAttachmentRevision();
  if (s.activeNote?.note.id !== noteId) return;
  try {
    await s.reloadActive();
  } catch {
    // silent-ok: 새로고침 실패는 다음 노트 열기/이벤트가 바로잡는 표시 문제일 뿐 데이터는 이미 서버에 있다.
  }
}

/** 반영된 것을 되돌린다 — 부분 실패해도 나머지는 계속한다(call() 이 실패마다 토스트를 띄운다). */
export async function undoAttachmentMeta(p: AttachmentMetaApplied): Promise<void> {
  const steps: Array<() => Promise<unknown>> = [];
  if (p.date_row_id) steps.push(() => call("note_date_remove", { id: p.date_row_id }));
  if (p.region_row_id) steps.push(() => call("note_region_remove", { id: p.region_row_id }));
  for (const step of steps) {
    try {
      await step();
    } catch {
      // silent-ok: call() 이 이미 에러 토스트와 진단 로그를 남겼다 — 나머지 되돌리기는 계속한다.
    }
  }
  await refresh(p.note_id);
}

/** "attachment-meta-applied" 수신 — 화면을 새로고침하고 [되돌리기] 토스트를 띄운다. */
export function onAttachmentMetaApplied(p: AttachmentMetaApplied): void {
  if (!p?.note_id || !p.summary) return;
  void refresh(p.note_id);
  showToastOnly(
    t("attachmentMeta.applied", { summary: p.summary }),
    () => {
      void undoAttachmentMeta(p);
    },
    { actionLabel: t("attachmentMeta.undo") },
  );
}
