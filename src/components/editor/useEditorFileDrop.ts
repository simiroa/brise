import { useRef } from "react";
import type { Editor } from "@tiptap/core";
import { useNotesStore } from "../../stores/notes";
import { call, emitNotice } from "../../lib/invoke";
import { t } from "../../i18n/t";
import type { Attachment, Section } from "../../lib/commands.gen";
import { insertImageAtPos } from "./insertImageAtPos";
import { ATTACHMENT_IMAGE_EXTS, SECTION_IMPORT_EXTS, fileExt } from "../../lib/fileKinds";
import { importFilesAsSections, previewNewAttachment } from "../../lib/noteActions";
import { isStillOnTarget } from "../../lib/onTargetGuard";
import { useFileDropZone } from "../../lib/useFileDropZone";

// nextDragOverState는 이제 lib/useFileDropZone.ts 소유다. useEditorFileDrop.test.ts가 여기서
// import하므로 재export만 남긴다.
export { nextDragOverState } from "../../lib/useFileDropZone";

/** Exported for testing. posAtCoords가 문서 영역 밖(빈 여백 등)을 가리켜 null을 주면 현재
 *  selection 위치로 폴백한다. */
export function resolveDropPos(coordsPos: number | null | undefined, fallbackPos: number): number {
  return typeof coordsPos === "number" ? coordsPos : fallbackPos;
}

/**
 * OS 파일 탐색기 → 에디터 본문 드롭: 확장자로 세 갈래(이미지/섹션 가져오기/첨부만)로 라우팅한다.
 * lib/useFileDropZone.ts(Tauri 레벨 onDragDropEvent — HTML5 DnD는 웹뷰 안에서 파일 경로를 절대
 * 못 준다) 공용 훅을 쓴다 — useAttachmentsDragDrop.ts/SourcePanel.tsx의 usePreviewFileDrop과
 * 같은 훅이고, 각자 자기 rect만 히트테스트하므로 셋이 겹치지 않는다.
 *
 * 세 갈래 판정은 IPC를 보내기 *전에* 확장자로 프런트가 직접 한다(lib/fileKinds.ts) —
 * attachment_add_file의 응답 kind를 보고 사후 판정하던 예전 방식은 "가져오기 지원 확장자"를
 * 이미지/첨부와 구분할 수 없어(둘 다 kind='doc'으로 온다) 더는 성립하지 않는다:
 *   - 이미지 확장자(ATTACHMENT_IMAGE_EXTS, repo::attachments::kind_from_ext와 동기화) →
 *     기존과 완전히 동일: attachment_add_file + 드롭 좌표에 노드 삽입.
 *   - 섹션 가져오기 확장자(SECTION_IMPORT_EXTS) 또는 확장자 없음(폴더 추정 — ponytail: 프런트는
 *     파일시스템을 못 읽어 파일/폴더를 구분 못 한다, section_import_scan과 같은 이유. 진짜
 *     확장자 없는 파일이면 importFilesAsSections의 section_import_scan이 skipped로 잡는다) →
 *     attachment_add_file을 부르지 않고 모아뒀다가 한 번에 importFilesAsSections
 *     (section_import_scan → section_import_file 배치, lib/noteActions.ts)로 넘긴다.
 *   - 그 외 → 기존과 동일: attachment_add_file만(노드 삽입 없음, 첨부바에만 나타남).
 *
 * 히트테스트 rect는 `containerEl`(EditorPanel 최상위 컨테이너 — 섹션 종류와 무관하게 항상
 * 마운트되므로 텍스트/시트/관계도 세 종류 모두 이 하나의 존을 공유한다) — 없으면(마운트 초기
 * 프레임) editor.view.dom으로 폴백.
 *
 * 드래그 오버 중, 활성 섹션이 텍스트일 때는 캐럿을 실시간으로 드롭 위치에 옮긴다
 * (setTextSelection) — 삽입될 자리를 미리 보여주는 이 에디터만의 피드백. 셀렉션-only
 * 트랜잭션이라 onUpdate(700ms 저장 디바운스)는 타지 않는다. 시트/관계도 섹션이 활성일 때는
 * Tiptap 인스턴스가 화면에 마운트돼 있지 않으므로(EditorPanel이 EditorContent를 렌더하지 않음)
 * 건너뛴다 — 캐럿 추종은 공용 훅이 대신할 수 없는 에디터 전용 동작이라 onOver 콜백에 그대로
 * 남긴다(dragOver 표시 자체는 훅이 소유).
 *
 * `onImported`: 가져오기로 새 섹션이 하나라도 만들어지면 그중 마지막 섹션으로 한 번 호출한다 —
 * 이 훅은 EditorPanel의 switchSection을 직접 부를 수 없으므로(순환 임포트) 콜백으로 위임한다.
 */
export function useEditorFileDrop(
  editor: Editor | null,
  sectionRef: { current: { id: string; kind?: string } | null },
  containerEl?: HTMLElement | null,
  onImported?: (section: Section) => void
) {
  // 같은 pos로 반복 호출되는 "over" 이벤트마다 setTextSelection을 다시 태우지 않기 위한 가드.
  const lastPosRef = useRef<number | null>(null);
  // 매 렌더 갱신되는 최신 콜백 — useFileDropZone은 [enabled]에만 의존해 재구독하므로,
  // onImported가 stale 클로저에 갇히지 않도록 ref로 우회한다.
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;

  return useFileDropZone(
    () => containerEl ?? editor?.view.dom ?? null,
    {
      onLeave: () => {
        lastPosRef.current = null;
      },
      onOver: (pos, inside) => {
        if (!editor || !inside || editor.isDestroyed) return;
        // 캐럿 추종은 텍스트 섹션 전용 — 시트/관계도 활성 중엔 Tiptap이 화면에 없다(위 주석).
        if (sectionRef.current?.kind !== "text") return;
        const docSize = editor.state.doc.content.size;
        const posInDoc = Math.min(
          resolveDropPos(editor.view.posAtCoords({ left: pos.x, top: pos.y })?.pos, editor.state.selection.to),
          docSize
        );
        if (posInDoc === lastPosRef.current) return;
        lastPosRef.current = posInDoc;
        editor.chain().focus().setTextSelection(posInDoc).run();
      },
      onDrop: (paths, pos, inside) => {
        lastPosRef.current = null;
        if (!editor || !inside) return;
        void handleFileDrop(editor, sectionRef, paths, pos.x, pos.y, onImportedRef.current);
      },
    },
    !!editor
  );
}

/** Exported for testing — the actual drop routing (mocked note store/IPC, no live Tauri/editor
 *  harness needed; see useEditorFileDrop.handleFileDrop.test.ts). */
export async function handleFileDrop(
  editor: Editor,
  sectionRef: { current: { id: string; kind?: string } | null },
  paths: string[],
  left: number,
  top: number,
  onImported?: (section: Section) => void
) {
  const id = await useNotesStore.getState().ensureMaterialized();
  if (!id) {
    emitNotice(t("attachments.drop_requires_note"));
    return;
  }
  if (editor.isDestroyed) return;

  // pasteImageFile(EditorPanel.tsx)과 같은 캡처 시점: ensureMaterialized가 막 만든 초안으로
  // activeNote 자체를 통째로 바꿀 수 있으므로, 그 뒤에 목표 note/section을 캡처한다.
  const target = { noteId: id, sectionId: sectionRef.current?.id ?? null };
  // 시트/관계도 섹션이 활성일 때는 Tiptap이 화면에 없다(EditorPanel이 EditorContent를 렌더하지
  // 않음) — 캐럿 계산도 이미지 노드 삽입도 의미가 없으니, 이미지를 포함한 모든 파일이 첨부로만
  // 간다(가져오기 확장자는 아래에서 종류 무관하게 새 섹션이 된다).
  const isTextSection = sectionRef.current?.kind === "text";
  // 첫 파일은 드롭 좌표, 이후 파일은 직전 삽입 뒤 selection(insertContentAt의 updateSelection
  // 기본 동작 — 삽입한 노드 뒤로 옮겨간다)을 이어서 쓴다. 가져오기/첨부만 갈래는 캐럿을 쓰지 않는다.
  let insertPos = isTextSection
    ? resolveDropPos(editor.view.posAtCoords({ left, top })?.pos, editor.state.selection.to)
    : 0;
  let anyAdded = false;
  let raceNotified = false;
  // 섹션 가져오기 확장자(+ 확장자 없음 = 폴더 추정)는 한 파일씩 IPC를 쏘지 않고 모아뒀다가
  // importFilesAsSections로 한 번에 보낸다(그쪽이 section_import_scan/flushAll/truncated 알림/
  // reloadActive를 이미 갖고 있다 — 로직 중복 금지).
  const importPaths: string[] = [];

  for (const path of paths) {
    const ext = fileExt(path);

    if (SECTION_IMPORT_EXTS.has(ext) || ext === "") {
      importPaths.push(path);
      continue;
    }

    let attachment: Attachment;
    try {
      attachment = await call<Attachment>("attachment_add_file", { note_id: id, file_path: path });
    } catch {
      continue; // call()이 이미 AppError 토스트를 표출함
    }
    anyAdded = true;
    previewNewAttachment(attachment.id); // 드롭한 파일은 종류 무관하게 어시스트 미리보기로 — 마지막 파일이 남는다
    if (editor.isDestroyed) return;
    if (!ATTACHMENT_IMAGE_EXTS.has(ext)) continue; // 이미지가 아니면 첨부만(첨부바에 나타난다) — 노드 삽입 없음
    if (!isTextSection) continue; // 시트/관계도 — 이미지도 첨부만(꽂을 캐럿 자리가 없다)

    const current = {
      noteId: useNotesStore.getState().activeNote?.note.id,
      sectionId: sectionRef.current?.id ?? null,
    };
    if (!isStillOnTarget(target, current)) {
      // 첨부 자체는 이미 target.noteId로 저장 완료 — 남은 파일도 계속 저장하되(다음 루프),
      // 지금 라이브 문서는 더 이상 그 노트가 아니므로 노드 삽입만 건너뛴다. 알림은 한 번만.
      if (!raceNotified) {
        emitNotice(t("editor.image_paste_note_changed"));
        raceNotified = true;
      }
      continue;
    }

    insertImageAtPos(editor, attachment, insertPos);
    insertPos = editor.state.selection.to;
  }

  if (importPaths.length) {
    const sections = await importFilesAsSections(id, importPaths);
    const last = sections[sections.length - 1];
    if (last && !editor.isDestroyed) {
      const current = {
        noteId: useNotesStore.getState().activeNote?.note.id,
        sectionId: sectionRef.current?.id ?? null,
      };
      // 노트/섹션이 그사이 바뀌었어도 섹션 자체는 이미 만들어졌다 — 화면 전환만 건너뛴다
      // (이미지 경로의 raceNotified와 같은 판단: 저장은 계속하되 라이브 문서만 안 건드린다).
      if (isStillOnTarget(target, current)) onImported?.(last);
    }
  }

  if (anyAdded) await useNotesStore.getState().reloadActive();
}
