// 첨부 우클릭 메뉴 — 첨부 바 타일과 갤러리가 **같은 메뉴**를 쓴다(similar-features-same-path).
// 외부 프로그램으로 열기 · 폴더에서 보기 · 이름 바꾸기 · (extra: 섹션으로 가져오기 등) · 삭제.
// 이름 바꾸기는 메뉴가 닫힌 뒤에도 입력 창이 살아 있어야 해서 이 컴포넌트가 PromptDialog 까지 갖는다 —
// 부모는 ctx 를 들고 있다가 onClose 로 비우면 된다. 저장은 attachment_rename(표시 이름만, 확장자 고정).
import { useState, type MouseEvent, type ReactNode } from "react";
import { t } from "../../i18n/t";
import { call, emitNotice } from "../../lib/invoke";
import { openAttachmentExternal, revealAttachmentExternal } from "../../lib/attachmentOpen";
import { useNotesStore } from "../../stores/notes";
import { ContextMenuShell } from "../common/ContextMenuShell";
import { PromptDialog } from "../PromptDialog";

export interface AttachmentMenuTarget {
  id: string;
  name: string;
  kind: string;
}

// 디스크 파일(또는 참조 원본)을 갖는 종류 — 열기/폴더에서 보기/이름 바꾸기 대상. 링크·노트 참조·차트·각주는 아니다.
const FILE_KINDS = new Set(["image", "doc", "audio"]);

export function AttachmentContextMenu({
  x,
  y,
  attachment,
  onClose,
  onDelete,
  extra,
}: {
  x: number;
  y: number;
  attachment: AttachmentMenuTarget;
  onClose: () => void;
  /** 삭제 방식은 표면마다 다르다(첨부 바 = 확인+되돌리기, 갤러리 = 낙관적 숨김) — 호출자가 정한다. */
  onDelete: (e: MouseEvent) => void;
  /** 표면 고유 항목(첨부 바의 "섹션으로 가져오기") — 삭제 위에 끼운다. */
  extra?: ReactNode;
}) {
  const [renaming, setRenaming] = useState(false);
  const isFile = FILE_KINDS.has(attachment.kind);

  const startRename = () => {
    if (useNotesStore.getState().activeNote?.note.content_locked) {
      emitNotice(t("editor.content_locked_tooltip"));
      onClose();
      return;
    }
    setRenaming(true);
  };

  const submitRename = async (name: string) => {
    onClose();
    try {
      await call("attachment_rename", { id: attachment.id, name });
      // 첨부 바(activeNote) + 갤러리(attachmentRevision → 재조회) 둘 다 갱신 — 진실은 DB.
      await useNotesStore.getState().reloadActive();
      useNotesStore.getState().bumpAttachmentRevision();
    } catch {
      // call() 이 토스트를 띄웠다(확장자 변경·잘못된 이름 등) — 낙관적 갱신이 없으니 되돌릴 것도 없다.
    }
  };

  if (renaming) {
    return (
      <PromptDialog
        title={t("attachments.dialog_rename_attachment_title")}
        mode="input"
        fields={[{ key: "name", label: t("attachments.prompt_attachment_name"), defaultValue: attachment.name }]}
        onCancel={onClose}
        onSubmit={(value) => void submitRename(((value as Record<string, string>).name ?? "").trim())}
      />
    );
  }

  return (
    <ContextMenuShell anchor={{ x, y }} onClose={onClose} testId="attachment-context-menu" minWidth={170}>
      {isFile && (
        <>
          <button
            type="button"
            className="menu-row menu-item"
            data-testid="attachment-menu-open"
            onClick={() => {
              onClose();
              openAttachmentExternal(attachment.id);
            }}
          >
            {t("attachments.ctx_open_external")}
          </button>
          <button
            type="button"
            className="menu-row menu-item"
            data-testid="attachment-menu-reveal"
            onClick={() => {
              onClose();
              revealAttachmentExternal(attachment.id);
            }}
          >
            {t("search.gallery_menu_reveal")}
          </button>
          <button type="button" className="menu-row menu-item" data-testid="attachment-menu-rename" onClick={startRename}>
            {t("attachments.ctx_rename")}
          </button>
        </>
      )}
      {extra}
      <button
        type="button"
        className="menu-row menu-item"
        data-testid="attachment-menu-remove"
        onClick={(e) => {
          onClose();
          onDelete(e);
        }}
        style={{ color: "var(--danger)" }}
      >
        {t("search.gallery_menu_remove")}
      </button>
    </ContextMenuShell>
  );
}
