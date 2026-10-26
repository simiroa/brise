import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { registerFlush } from "../../lib/invoke";
import { MARKDOWN_SET_CONTENT_OPTIONS, mdSerializeDoc } from "../../lib/mdSerialize";

/** The live editor's current section. `body` = the body_md the server holds (save/rollback baseline).
 *  `loaded` = the doc painted from exactly that body (paintSectionBody) — see unchangedSinceLoad. */
export type CurrentSection<TKind extends string = string> = {
  id: string;
  body: string;
  kind: TKind;
  loaded?: { body: string; doc: Editor["state"]["doc"]; md?: string };
};

/** Paints body_md into the live editor (markdown, emitUpdate:false — a load, not an edit) and remembers the
 *  painted doc as `sec.loaded`, valid only while `sec.body` is still that body. */
export function paintSectionBody(editor: Editor, sec: CurrentSection | null, body: string) {
  editor.commands.setContent(body, MARKDOWN_SET_CONTENT_OPTIONS);
  if (sec && sec.body === body) sec.loaded = { body, doc: editor.state.doc };
}

/**
 * 저장 경로(onUpdate 타이머·flushRef)의 "쓸 것 없음" 판정 — 데스크톱·폰 공용.
 *
 * 예전엔 `md === sec.body`(에디터 직렬화 = DB 원문)만 봤다. 원문이 직렬화기의 정규형이 아니면(옛 본문, AI·수집이
 * 쓴 마크다운, 2026-10-18 의 역슬래시가 불던 색 글자) 열어 두기만 한 섹션도 다음 flushAll — 내보내기 모달·새로고침의
 * pagehide·섹션/노트 전환·주기 스냅샷 — 이 section_update 로 다시 썼다: 활동 기록 '편집' + 노트 수정 시각 갱신, 그리고
 * 비대칭 직렬화라면 본문 손상까지. 이제 "방금 칠한 문서를 직렬화한 것"과 같아도 바뀐 게 없다고 본다. 그 직렬화는
 * 원문 비교가 어긋날 때만 한 번 계산해 기억한다(칠할 때마다 직렬화하지 않는다). 저장 성공·롤백·초안 표시처럼
 * sec.body 가 바뀌면 `loaded.body !== sec.body` 가 되어 이 기준선은 저절로 무효다.
 */
export function unchangedSinceLoad(sec: CurrentSection, md: string, editor: Editor): boolean {
  if (md === sec.body) return true;
  const loaded = sec.loaded;
  if (!loaded || loaded.body !== sec.body) return false;
  loaded.md ??= mdSerializeDoc(editor, loaded.doc);
  return md === loaded.md;
}

/** Wave R3: EditorPanel.tsx and MobileNote.tsx each hand-rolled the same
 *  ref+state "current section" mirror and the same registerFlush wiring, down to the comments
 *  cross-referencing each other. Everything else that looked parallel at a glance — the 700ms
 *  autosave debounce body, switchSection, insertSection — actually differs in kind (desktop also
 *  maintains bodyCacheRef + the BubbleMenu anchor reset + a diagram-kind skip during onUpdate;
 *  mobile has no cache and drives readOnly/DiagramSection UI state instead) and stays duplicated,
 *  on purpose — forcing those into one shape would mean threading desktop-only refs through a
 *  hook mobile has no use for, or mobile-only UI state through one desktop has no use for. This
 *  hook covers only the part that was byte-for-byte identical.
 *
 *  `TKind` lets each caller keep its own section-kind union (mobile's "text"|"diagram" is
 *  narrower than desktop's plain `string`) without either side casting. */
export function useSectionEditor<TKind extends string = string>(onSet?: () => void) {
  // sectionRef is what every callback (onUpdate/flushRef/AI bridges) reads — a ref, not state, so
  // it's always current inside closures created on an earlier render. activeSectionId is its
  // render-visible echo: a plain ref never triggers a re-render on its own, and the current-tab
  // highlight (and, on desktop, the Tiptap-vs-DiagramSection branch) needs one.
  const sectionRef = useRef<CurrentSection<TKind> | null>(null);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const setActiveSection = (id: string, body: string, kind: TKind) => {
    onSet?.();
    sectionRef.current = { id, body, kind };
    setActiveSectionId(id);
  };
  // ReturnType<typeof setTimeout> — NodeJS.Timeout only resolves with @types/node present, which
  // breaks a clean CI checkout with TS2503. This form is safe in both the browser and Node.
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Current-section flush — registered globally (lib/invoke.ts::registerFlush) so tab/note switch
  // and window close all commit a pending debounced edit through the same chokepoint. Each caller
  // assigns its own real implementation to flushRef.current every render (stale-closure guard,
  // same pattern as the ref itself) — this hook only owns the ref and the registration.
  const flushRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    const unregister = registerFlush(() => flushRef.current());
    return () => {
      unregister();
      // Data-loss fix: a bare clearTimeout() here drops up to 700ms of unsaved edits whenever
      // this component unmounts without going through registerFlush's channel first — e.g.
      // clicking the Home/dashboard tab (App.tsx swaps EditorPanel out; TabBar's activateHome()
      // doesn't call flushAll). flushRef.current() clears the pending timer itself and persists
      // via updateSectionBody — same intent as DiagramSection.tsx's unmount cleanup. Fire-and-
      // forget: a cleanup function can't be async/awaited, and flushRef's void+.catch callers
      // already treat this as acceptable at unmount.
      void flushRef.current().catch(() => {});
    };
  }, []);

  // setActiveSectionId is also returned raw: the empty-state ("no note open") path clears
  // sectionRef.current to null directly (not a {id,body,kind} triple) and needs to echo that same
  // null into the render-visible state without going through setActiveSection's non-null shape.
  return { sectionRef, activeSectionId, setActiveSection, setActiveSectionId, timeoutRef, flushRef };
}
