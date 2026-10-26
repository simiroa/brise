import React, { useState } from "react";
import { t } from "../../i18n/t";
import { emitNotice } from "../../lib/invoke";
import { useSettingsStore } from "../../stores/settings";
import { useAiStore, selectAiAvailability } from "../../stores/ai";
import { importLinkToSection } from "../../lib/linkImport";
import { useNotesStore } from "../../stores/notes";
import type { Source } from "../../lib/commands.gen";
import { ModalShell } from "../ModalShell";
import { IconAi } from "../icons";
import { PromptDialog } from "../PromptDialog";
import { InternalNotePicker } from "./InternalNotePicker";

export type AttachmentDialogState =
  | { kind: "link" }
  | { kind: "note" }
  | { kind: "internal" }
  | { kind: "keepOriginal"; resolve: (keep: boolean) => void }
  | { kind: "renameSource"; source: Source }
  | { kind: "confirmDelete"; resolve: (confirm: boolean) => void }
  | { kind: "confirmDeleteSelected" };

export function normalizeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}


function LinkAttachmentDialog({
  activeNoteId,
  onClose,
  onAddLink,
}: {
  activeNoteId: string;
  onClose: () => void;
  onAddLink: (url: string, name: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const aiReachable = useAiStore((s) => s.aiReachable);
  const availability = selectAiAvailability({ aiEnabled }, { aiReachable });
  const showAi = availability === "ready";

  const validUrl = normalizeHttpUrl(url);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!validUrl) {
      emitNotice(t("attachments.invalid_link_url"));
      return;
    }
    onClose();
    void onAddLink(validUrl, name.trim());
  };

  const handleAiImport = async () => {
    if (!validUrl) return;
    setBusy(true);
    try {
      // 실패 안내는 importLinkToSection 안에서 이미 emitNotice/토스트로 끝낸다 — 여기서는
      // 성공했을 때만 닫는다(기존 동작 유지: 실패 시 대화상자는 열린 채로 남아 재시도 가능).
      const ok = await importLinkToSection(validUrl, name.trim(), activeNoteId, "raw");
      if (ok) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title={t("attachments.dialog_add_link_title")}
      onClose={onClose}
      width={420}
    >
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label className="form-label">{t("attachments.prompt_link_url")}</label>
          <input
            autoFocus
            type="text"
            className="field"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://..."
            style={{ width: "100%" }}
          />
        </div>
        <div>
          <label className="form-label">{t("attachments.prompt_link_name")}</label>
          <input
            type="text"
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ width: "100%" }}
          />
        </div>

        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            justifyContent: showAi && validUrl ? "space-between" : "flex-end",
            marginTop: 4,
          }}
        >
          {showAi && validUrl && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleAiImport()}
              className="btn"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "var(--space-1) var(--space-3)",
                fontSize: "var(--text-md)",
                color: "var(--accent)",
              }}
            >
              <IconAi size={14} />
              {busy ? "…" : t("attachments.ai_import_section")}
            </button>
          )}
          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" onClick={onClose} className="btn">
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              disabled={busy}
              className="btn btn--primary"
            >
              {t("common.apply")}
            </button>
          </div>
        </div>
      </form>
    </ModalShell>
  );
}

export interface AttachmentDialogsProps {
  dialog: AttachmentDialogState | null;
  activeNoteId: string;
  selectedTileCount: number;
  onClose: () => void;
  onAddLink: (url: string, name: string) => void;
  onAddNote: (name: string, text: string) => void;
  onAddInternal: (noteId: string, title: string) => void;
  onRenameSource: (sourceId: string, name: string) => void;
  onDeleteSelected: () => void;
}

export function AttachmentDialogs({
  dialog,
  activeNoteId,
  selectedTileCount,
  onClose,
  onAddLink,
  onAddNote,
  onAddInternal,
  onRenameSource,
  onDeleteSelected,
}: AttachmentDialogsProps) {
  if (!dialog) return null;

  return (
    <>
      {dialog.kind === "link" && (
        <LinkAttachmentDialog
          activeNoteId={activeNoteId}
          onClose={onClose}
          onAddLink={onAddLink}
        />
      )}

      {dialog.kind === "note" && (
        <PromptDialog
          title={t("attachments.dialog_note_title")}
          mode="input"
          fields={[
            { key: "name", label: t("attachments.prompt_note_name") },
            { key: "text", label: t("attachments.prompt_note_text"), multiline: true },
          ]}
          onCancel={onClose}
          onSubmit={(value) => {
            const v = value as Record<string, string>;
            onClose();
            void onAddNote(v.name ?? "", v.text ?? "");
          }}
        />
      )}

      {dialog.kind === "internal" && (
        <InternalNotePicker
          excludeNoteId={activeNoteId}
          onCancel={onClose}
          onPick={(noteId) => {
            onClose();
            void useNotesStore
              .getState()
              .ensureNoteSummaries([noteId])
              .then((map) => {
                const target = map.get(noteId);
                if (target) void onAddInternal(noteId, target.title);
              });
          }}
        />
      )}

      {dialog.kind === "keepOriginal" && (
        <PromptDialog
          title={t("attachments.keep_original_title")}
          // 참조(ext_path)로 붙는 원본은 복사본이 아니라 원래 자리를 가리킨다 — 백업에도 안 담긴다.
          // 여기서 **알리기만** 한다(복사/참조 선택은 설정 attachment_storage_mode 하나가 갖는다).
          // ponytail: 파일 크기를 프런트가 알 방법이 없어(피커·드롭 모두 경로 문자열만 준다,
          // plugin-fs 미설치, stat 커맨드 없음) 32MB 조건 없이 규칙 그대로 적는다 — 이 문장은
          // 크기와 무관하게 참이다. 조건부로 하려면 경로 하나를 stat 하는 IPC 커맨드가 필요하다.
          description={`${t("attachments.keep_original_body")} ${t("attachments.keep_original_reference_note")}`}
          mode="confirm"
          confirmLabel={t("attachments.keep_original_keep")}
          cancelLabel={t("attachments.keep_original_discard")}
          onCancel={() => {
            const resolve = dialog.resolve;
            onClose();
            resolve(false);
          }}
          onSubmit={() => {
            const resolve = dialog.resolve;
            onClose();
            resolve(true);
          }}
        />
      )}

      {dialog.kind === "renameSource" && (
        <PromptDialog
          title={t("attachments.dialog_rename_source_title")}
          mode="input"
          fields={[{ key: "name", label: t("attachments.prompt_source_name"), defaultValue: dialog.source.name }]}
          onCancel={onClose}
          onSubmit={(value) => {
            const v = value as Record<string, string>;
            const id = dialog.source.id;
            onClose();
            void onRenameSource(id, v.name ?? "");
          }}
        />
      )}

      {dialog.kind === "confirmDeleteSelected" && (
        <PromptDialog
          title={t("selection.delete_attachments_title", { n: selectedTileCount })}
          description={t("selection.delete_attachments_body")}
          mode="confirm"
          danger
          confirmLabel={t("selection.delete")}
          onCancel={onClose}
          onSubmit={() => {
            onClose();
            onDeleteSelected();
          }}
        />
      )}

      {dialog.kind === "confirmDelete" && (
        <PromptDialog
          title={t("attachments.confirm_delete_title")}
          description={t("attachments.confirm_delete_body")}
          mode="confirm"
          confirmLabel={t("selection.delete")}
          cancelLabel={t("common.cancel")}
          onCancel={() => {
            const resolve = dialog.resolve;
            onClose();
            resolve(false);
          }}
          onSubmit={() => {
            const resolve = dialog.resolve;
            onClose();
            resolve(true);
          }}
        />
      )}
    </>
  );
}
