import { ContextMenuShell } from "../common/ContextMenuShell";
import { PromptDialog } from "../PromptDialog";
import { popoverRoot } from "../../lib/ui";
import { t } from "../../i18n/t";
import type { BuiltinPresetId, CustomPreset } from "../../stores/presets";
import type { Entry } from "./presetConstants";

interface PresetManageDialogsProps {
  rootEl: HTMLElement | null;

  ctx: { preset: CustomPreset; x: number; y: number } | null;
  onCloseCtx: () => void;
  onOpenRename: (preset: CustomPreset) => void;
  onOpenStyle: (id: string, x: number, y: number) => void;
  onOpenDelete: (preset: CustomPreset) => void;

  makeMenu: { entry: Entry; x: number; y: number } | null;
  onCloseMakeMenu: () => void;
  hasOpenNote: boolean;

  renameTarget: CustomPreset | null;
  onCloseRename: () => void;
  onRename: (id: string, newName: string) => void;

  deleteTarget: CustomPreset | null;
  onCloseDelete: () => void;
  onDelete: (id: string) => void;

  deleteBuiltinTarget: { id: BuiltinPresetId; label: string } | null;
  onCloseDeleteBuiltin: () => void;
  onDeleteBuiltin: (id: BuiltinPresetId) => void;
}

export function PresetManageDialogs({
  rootEl,
  ctx,
  onCloseCtx,
  onOpenRename,
  onOpenStyle,
  onOpenDelete,
  makeMenu,
  onCloseMakeMenu,
  hasOpenNote,
  renameTarget,
  onCloseRename,
  onRename,
  deleteTarget,
  onCloseDelete,
  onDelete,
  deleteBuiltinTarget,
  onCloseDeleteBuiltin,
  onDeleteBuiltin,
}: PresetManageDialogsProps) {
  const container = popoverRoot(rootEl);

  return (
    <>
      {/* 기본 컨텍스트 메뉴 (커스텀 프리셋 우클릭) */}
      <ContextMenuShell
        anchor={ctx}
        onClose={onCloseCtx}
        minWidth={140}
        container={container}
      >
        <button
          type="button"
          className="menu-row menu-item"
          onClick={() => {
            if (!ctx) return;
            const target = ctx.preset;
            onCloseCtx();
            onOpenRename(target);
          }}
        >
          {t("ctx.rename")}
        </button>
        <button
          type="button"
          className="menu-row menu-item"
          onClick={() => {
            if (!ctx) return;
            const { preset, x, y } = ctx;
            onCloseCtx();
            onOpenStyle(preset.id, x, y);
          }}
        >
          {t("presets.style_title")}
        </button>
        <button
          type="button"
          className="menu-row menu-item"
          onClick={() => {
            if (!ctx) return;
            const target = ctx.preset;
            onCloseCtx();
            onOpenDelete(target);
          }}
        >
          {t("ctx.remove")}
        </button>
      </ContextMenuShell>

      {/* manage "만들기" 메뉴 — 새 노트 / 새 섹션 2옵션 */}
      <ContextMenuShell
        anchor={makeMenu}
        onClose={onCloseMakeMenu}
        minWidth={160}
        container={container}
      >
        <button
          type="button"
          className="menu-row menu-item"
          data-testid="preset-make-new-note"
          onClick={() => {
            if (!makeMenu) return;
            const m = makeMenu;
            onCloseMakeMenu();
            m.entry.onMake?.("new-note");
          }}
        >
          {t("presets.make_new_note")}
        </button>
        <button
          type="button"
          className="menu-row menu-item"
          data-testid="preset-make-new-section"
          disabled={!hasOpenNote}
          title={hasOpenNote ? undefined : t("presets.make_new_section_hint")}
          style={hasOpenNote ? undefined : { opacity: 0.45, cursor: "default" }}
          onClick={() => {
            if (!hasOpenNote || !makeMenu) return;
            const m = makeMenu;
            onCloseMakeMenu();
            m.entry.onMake?.("new-section");
          }}
        >
          {t("presets.make_new_section")}
        </button>
      </ContextMenuShell>

      {/* 이름 변경 다이얼로그 */}
      {renameTarget && (
        <PromptDialog
          mode="input"
          title={t("presets.rename_title")}
          defaultValue={renameTarget.name}
          onSubmit={(val) => {
            const newName = typeof val === "string" ? val : val[""] ?? "";
            if (newName.trim()) onRename(renameTarget.id, newName.trim());
            onCloseRename();
          }}
          onCancel={onCloseRename}
        />
      )}

      {/* 삭제 확인 다이얼로그 (커스텀) */}
      {deleteTarget && (
        <PromptDialog
          mode="confirm"
          title={t("presets.delete_title")}
          description={t("presets.delete_confirm", { name: deleteTarget.name })}
          danger
          confirmLabel={t("ctx.remove")}
          onSubmit={() => {
            onDelete(deleteTarget.id);
            onCloseDelete();
          }}
          onCancel={onCloseDelete}
        />
      )}

      {/* 삭제 확인 다이얼로그 (빌트인 숨김) */}
      {deleteBuiltinTarget && (
        <PromptDialog
          mode="confirm"
          title={t("presets.delete_title")}
          description={t("presets.delete_confirm", { name: deleteBuiltinTarget.label })}
          danger
          confirmLabel={t("ctx.remove")}
          onSubmit={() => {
            onDeleteBuiltin(deleteBuiltinTarget.id);
            onCloseDeleteBuiltin();
          }}
          onCancel={onCloseDeleteBuiltin}
        />
      )}
    </>
  );
}
