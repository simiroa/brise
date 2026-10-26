import { useEffect, useState } from "react";
import { AuxWindowChrome } from "../components/AuxWindowChrome";
import { EditorPanel } from "../components/EditorPanel";
import { SectionNameTitle } from "./SectionNameTitle";
import { useNotesStore, renameSection } from "../stores/notes";
import { call } from "../lib/invoke";
import { seedSectionTokens } from "../lib/sectionTokens";
import { useEmojiRenderSync } from "../lib/emojiBase";
import { requestOpenNoteInMain } from "../lib/openNoteInMain";
import { listenDataReplaced } from "../lib/remoteNoteWrite";
import type { NoteDetail } from "../lib/commands.gen";
import { t } from "../i18n/t";

/**
 * 섹션 분리 창(#/section)의 루트 — 섹션 하나를 단독으로 편집한다(1단계, 2026-09-30). 창 자체는
 * src-tauri/src/section_window.rs, 본 창 쪽 거울은 stores/sectionWindows.ts.
 *
 * 에디터 결합을 푸는 방식: 두 번째 구현을 만들지 않고 **본 창과 같은 EditorPanel 을 그대로** 돌린다.
 * 이 창은 별도 웹뷰라 zustand 스토어가 따로다 — 그래서 이 창의 notes 스토어의 activeNote 에 이 섹션
 * 하나만 실어 두면, EditorPanel·DiagramSection·SheetSection 이 activeNote 를 읽는 모든 자리(내용잠금,
 * 첨부, 노트 id)와 저장(updateSectionBody → section_update)이 손대지 않고 이 섹션에 대해 돈다.
 * 탭 바는 inDetachedWindow 로 끈다(추가/삭제/이동/분리는 본 창 몫).
 *
 * 닫기: X·Alt+F4 → lib/invoke.ts 의 onCloseRequested 가 flushAll 로 저장을 끝낸 뒤 destroy →
 * Rust 가 Destroyed 에서 본 창에 알린다. 본 창은 그때 DB 에서 다시 읽는다.
 */
export function SectionWindowApp() {
  // 데이터가 통째로 바뀌면(초기화·복원·대체 가져오기) 다시 불러온다 — 복원은 같은 노트·섹션 id 를 되살려
  // close_orphans 가 이 창을 닫지 않고, 그대로 두면 다음 자동저장이 들고 있던 옛 본문으로 복원본을 덮는다.
  useEffect(() => listenDataReplaced(), []);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const [sectionId, setSectionId] = useState("");
  const [sectionName, setSectionName] = useState("");
  const [noteTitle, setNoteTitle] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const noteId = params.get("note");
    const sectionId = params.get("section");
    if (!noteId || !sectionId) {
      setState("missing");
      return;
    }
    void (async () => {
      try {
        const detail = await call<NoteDetail>("note_get", { id: noteId });
        const sec = detail.sections.find((s) => s.id === sectionId);
        if (!sec) {
          setState("missing");
          return;
        }
        // 섹션 하나만 — EditorPanel 의 note-load effect 가 "마지막 섹션"을 고르므로 이게 곧 선택이다.
        // 이 불변식(sections = [이 섹션])은 아래 구독이 지킨다.
        //
        // ponytail: 이 창은 자기 섹션 본문을 여는 순간 한 번 읽는다. 스냅샷 복원은 먼저 이 창을 닫게
        // 했지만(activityWindowBridge), 서버측 재작성 경로 — 폰 쓰기(sync_server/ingest.rs)·데이노트
        // 추가·AI 요약 등 — 는 여전히 이 창을 stale 로 두고, 다음 자동저장이 그 쓰기를 덮는다. 업그레이드
        // 경로: 이 창에서도 remote-note-write 를 듣고 자기 노트면 reloadActive(아래 구독이 걸러 준다).
        seedSectionTokens([sec]); // D2②: 이 창(별도 웹뷰)의 저장도 토큰을 보낸다
        useNotesStore.setState({
          activeNote: { ...detail, sections: [sec] },
          isBooting: false,
          // 이 창에서 다른 노트로 가는 모든 길(위키 링크·관계도 노트 링크 등)이 selectNote 한 곳으로
          // 모인다 — 여기서 그 노트를 열면 이 창이 엉뚱한 노트로 바뀌고(섹션 소유가 깨진다) 탭 저장까지
          // 건드린다. 본 창이 이미 듣는 채널(App.tsx "pet-open-note")로 넘겨 본 창에서 연다.
          selectNote: async (id: string) => {
            await requestOpenNoteInMain(id);
          },
        });
        setSectionId(sec.id);
        setSectionName(sec.name);
        setNoteTitle(detail.note.title);
        setState("ready");
      } catch {
        // call() 이 토스트 + 진단 기록.
        setState("missing");
      }
    })();
  }, []);

  // 배타 소유 — 이 창의 activeNote.sections 는 언제나 [이 섹션] 하나다. reloadActive(DB 의 전체 섹션)·
  // appendSectionLocally(AI 삽입·붙여넣기·파일 드롭이 만든 새 섹션) 등 **어느 경로가** activeNote 를
  // 바꾸든 여기 한 곳에서 거른다. zustand 구독은 set 직후 동기로 돌므로 React 는 걸러진 상태만 그린다.
  // (다른 섹션으로의 전환 자체는 EditorPanel.switchSection 이 inDetachedWindow 에서 막는다.)
  useEffect(() => {
    if (!sectionId) return;
    return useNotesStore.subscribe((s) => {
      const n = s.activeNote;
      if (!n || (n.sections.length === 1 && n.sections[0].id === sectionId)) return;
      useNotesStore.setState({ activeNote: { ...n, sections: n.sections.filter((x) => x.id === sectionId) } });
    });
  }, [sectionId]);

  // 컬러 이모지 — 이 창은 App 을 부팅하지 않는다.
  useEmojiRenderSync();

  // 섹션 이름 개명 — 규칙·IPC·스토어 갱신은 탭 개명과 같은 stores/notes.ts::renameSection 하나.
  // 본 창의 탭 라벨은 이 창이 닫혀 reloadActive 가 DB 를 다시 읽을 때 갱신된다(분리 중엔 stale 허용).
  // OS 제목(setTitle)은 안 건드린다 — 데코레이션·작업표시줄이 없어 안 보이고, core:window:allow-set-title
  // 권한을 새로 들이면 재빌드가 필요하다(CLAUDE.md 함정 7).
  const commitName = async (raw: string) => {
    const name = await renameSection(sectionId, sectionName, raw);
    if (name) setSectionName(name);
  };

  return (
    <AuxWindowChrome
      title={sectionName}
      titleSlot={
        state === "ready" ? (
          <SectionNameTitle name={sectionName} noteTitle={noteTitle} onCommit={commitName} />
        ) : undefined
      }
      closeTestId="section-window-close"
      escapeCloses={false}
    >
      {state === "ready" && <EditorPanel inDetachedWindow />}
      {state === "missing" && (
        <div style={{ flex: 1, display: "grid", placeItems: "center", padding: "var(--space-7)", color: "var(--muted)" }}>
          {t("sectionWindow.missing")}
        </div>
      )}
    </AuxWindowChrome>
  );
}
