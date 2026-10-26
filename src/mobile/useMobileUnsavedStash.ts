/**
 * 폰 노트 화면의 "이 기기에 저장하지 못한 글" 복구 — [그래도 나가기](useMobileNoteSave)가 unsavedStash 에 적어 둔
 * 본문을, 그 노트를 다시 열었을 때 배너로 돌려준다. 상태·동작은 여기, 그리기는 MobileNoteBanners.
 *
 * 복구는 "새 섹션으로 넣기"뿐이다 — 어떤 기존 본문도 덮지 않는다. 새 섹션은 D2② 충돌 "복사" 와 같은 길
 * (`section_create_with_body`)로 만든다. useMobileSectionOps::insertSection 을 쓰지 않는 이유: 그쪽은 자기 실패를
 * 삼키고 void 를 돌려줘서 성공 여부를 알 수 없고, 여기선 **서버가 확인한 뒤에만** 보관본을 지워야 한다(실패하면
 * 이 보관본이 글의 유일한 사본이다). call() 은 실패를 토스트하고 다시 던지므로 try/catch 로 붙잡는다.
 *
 * 훅은 MobileNote 의 조기 반환 위에서 부른다(CLAUDE.md 함정 1).
 */
import { useMemo, useRef, useState } from "react";
import type { Section } from "../lib/commands.gen";
import { call } from "../lib/invoke";
import { reportFallback } from "../lib/diag";
import { prepareAiInsertNoteId } from "../lib/aiSectionBridge";
import { useNotesStore } from "../stores/notes";
import { t } from "../i18n/t";
import type { MobileBodyEditor } from "./useMobileBodyEditor";
import { removeStash, stashesForNote, type UnsavedStash } from "./unsavedStash";

export function useMobileUnsavedStash(opts: {
  ed: MobileBodyEditor;
  /** 지금 열린 노트(없으면 null). 캡처 초안이면 "__draft__" — 초안에서 못 올린 글은 다음 입력 화면에 다시 뜬다. */
  noteId: string | null;
  /** 이 기기에만 있는 본문이 남았는가(useMobileNoteSave) — 있으면 복구 섹션으로 화면을 옮기지 않는다. */
  bodyUnsavedRef: { current: boolean };
}) {
  const { noteId, bodyUnsavedRef } = opts;
  // 비동기 뒤에는 그 사이 새로 만들어진 에디터를 봐야 한다(함정 2) — 클릭 시점의 ed 를 쥐고 있으면 destroy 된
  // 인스턴스에 setEditable 을 부른다.
  const edRef = useRef(opts.ed);
  edRef.current = opts.ed;

  // 노트가 바뀌거나 지웠을 때(rev)만 저장소를 다시 읽는다. 나가기 직후 같은 화면에 남는 경우(보관한 글이 아직 에디터에
  // 있다)에 배너가 바로 뜨면 같은 글을 두 번 넣게 되므로, 보관(put) 쪽은 rev 를 올리지 않는다.
  const [rev, setRev] = useState(0);
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- rev 는 저장소 재읽기 신호일 뿐 값이 아니다
  const stashes = useMemo<UnsavedStash[]>(() => (noteId ? stashesForNote(noteId) : []), [noteId, rev]);
  const current = stashes[0] ?? null;

  const insert = async (stash: UnsavedStash) => {
    if (busy) return;
    setBusy(true);
    try {
      let id: string | null;
      let created: Section;
      try {
        // 입력 중인 본문부터 서버에 확정한다 — 새 섹션을 올리면 에디터가 그 섹션을 그려서, 대기 중인 디바운스가 엉뚱한
        // 섹션에 걸린다(switchSection 과 같은 규율).
        await edRef.current.flushRef.current();
        // 초안이면 여기서 노트를 만든다(ensureMaterialized — 서버가 안 되면 던진다). 그래서 이것도 이 try 안이다:
        // 서버가 아직 죽어 있을 때 복구를 누른 초안 보관본이 처리 안 된 rejection 이 되면 안 된다(함정 8).
        id = await prepareAiInsertNoteId(stash.noteId);
        if (!id) return;
        created = await call<Section>("section_create_with_body", {
          note_id: id,
          name: t("mobile.stash_section_name", { name: stash.sectionName || t("editor.new_section_text") }),
          body_md: stash.bodyMd,
          kind: stash.kind,
        });
      } catch {
        // call() 이 토스트했다(초안 materialize 도 call 을 거친다). 보관본은 그대로 — 배너가 남아 다시 누를 수 있다.
        reportFallback("mobile-save", "stash_insert_failed");
        return;
      }
      if (!removeStash(stash.id)) reportFallback("mobile-save", "stash_remove_after_insert_failed");
      setRev((r) => r + 1);
      useNotesStore.getState().appendActiveSection(id, created);
      // 저장 못 한 본문이 에디터에 남았으면(또 실패) 그 화면을 새 섹션으로 덮지 않는다 — 스트립에 새 탭만 생긴다.
      const live = edRef.current;
      if (!bodyUnsavedRef.current && live.editor && !live.editor.isDestroyed) {
        live.showSection({ ...created, kind: stash.kind }, { clearUneditable: false });
      }
    } finally {
      setBusy(false);
    }
  };

  const discard = (stash: UnsavedStash) => {
    if (!removeStash(stash.id)) return; // 지우지 못했으면 배너를 그대로 둔다(거짓으로 사라지지 않게)
    setRev((r) => r + 1);
  };

  return { stash: current, count: stashes.length, busy, insert, discard };
}
