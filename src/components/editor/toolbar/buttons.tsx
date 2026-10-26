import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, useEditorState } from "@tiptap/react";
import { call, emitNotice } from "../../../lib/invoke";
import { isStillOnTarget } from "../../../lib/onTargetGuard";
import { useNotesStore } from "../../../stores/notes";
import { t } from "../../../i18n/t";
import {
  IconLink, IconImage, IconHighlight, IconUnderline, IconPalette, IconTable,
  IconBold, IconItalic, IconStrike, IconArrowUp, IconArrowDown, IconClose,
  IconUndo, IconRedo,
} from "../../icons";
import { IMAGE_WIDTH_DEFAULT, formatImageWidth } from "../imageResize";
import { useFloatingPopover } from "../../../lib/ui";
import { markCoverageRatio, markPressFromRatio } from "./markCoverage";
import { Select } from "../../Select";
export function useIsActive(
  editor: NonNullable<ReturnType<typeof useEditor>>,
  name: string,
  attrs?: Record<string, unknown>
): boolean {
  return useEditorState({
    editor,
    selector: ({ editor: ed }) => ed.isActive(name, attrs),
  });
}

import {
  ToolbarButton,
  ToolbarDivider,
  ToolbarDropdownTrigger,
  type ToolbarPress,
  type ToolbarButtonProps,
  type ToolbarDividerProps,
  type ToolbarDropdownTriggerProps,
} from "../../common/toolbar";

export {
  ToolbarButton,
  ToolbarDivider,
  ToolbarDropdownTrigger,
  type ToolbarPress,
  type ToolbarButtonProps,
  type ToolbarDividerProps,
  type ToolbarDropdownTriggerProps,
};

/**
 * Mark tri-state via the same useEditorState subscription pattern as useIsActive.
 * Caret (empty selection) stays boolean via TipTap isActive; non-empty uses coverage ratio.
 */
function useMarkPress(
  editor: NonNullable<ReturnType<typeof useEditor>>,
  markName: string,
): ToolbarPress {
  return useEditorState({
    editor,
    selector: ({ editor: ed }): ToolbarPress => {
      const { from, to, empty } = ed.state.selection;
      if (empty) return ed.isActive(markName);
      const state = markPressFromRatio(markCoverageRatio(ed.state.doc, from, to, markName));
      if (state === "partial") return "mixed";
      return state === "on";
    },
  });
}

/**
 * `can()` 은 이 파일의 useEditorState 셀렉터 중 **유일하게 commandManager 를 타는** 경로다.
 * TipTap v3 의 `Editor.destroy()` 가 `commandManager = null` 로 비우므로 파괴된 인스턴스에서
 * 부르면 "Cannot read properties of null (reading 'can')" 로 렌더 도중 던지고, EditorPanel 을
 * 감싼 App.tsx 의 ErrorBoundary 가 패널 전체를 "컴포넌트를 불러오지 못했습니다"로 바꿔버린다.
 * isActive/state 계열 셀렉터가 멀쩡한 이유는 core 의 `get state()` 가 unmount 후에도 마지막
 * editorState 를 계속 돌려주기 때문 — 그래서 이 두 버튼만 터졌다.
 *
 * 파괴된 인스턴스가 셀렉터까지 오는 창이 실재한다: useEditorState 의 스냅샷은 레이아웃
 * 이펙트에서만 갱신되므로 인스턴스가 교체·파괴된 뒤에도 렌더가 한 번 더 옛 인스턴스로 돈다
 * (StrictMode/HMR 재마운트). EditorPanel.tsx·SectionPreview.tsx 가 `.commands` 앞에 두는
 * isDestroyed 가드의 렌더 경로 짝이고, 두 호출자가 지나가는 이 한 지점에서만 막는다.
 */
function useEditorCan(
  editor: NonNullable<ReturnType<typeof useEditor>>,
  action: "undo" | "redo",
): boolean {
  return useEditorState({
    editor,
    selector: ({ editor: ed }) => (ed && !ed.isDestroyed ? ed.can()[action]() : false),
  });
}

export function UndoButton({ editor }: { editor: NonNullable<ReturnType<typeof useEditor>> }) {
  const canUndo = useEditorCan(editor, "undo");
  return (
    <ToolbarButton
      title={`${t("editor.diagram_undo")} (Ctrl+Z)`}
      onClick={() => editor.chain().focus().undo().run()}
      disabled={!canUndo}
      testid="editor-undo"
    >
      <IconUndo size={15} />
    </ToolbarButton>
  );
}

export function RedoButton({ editor }: { editor: NonNullable<ReturnType<typeof useEditor>> }) {
  const canRedo = useEditorCan(editor, "redo");
  return (
    <ToolbarButton
      title={`${t("editor.diagram_redo")} (Ctrl+Y)`}
      onClick={() => editor.chain().focus().redo().run()}
      disabled={!canRedo}
      testid="editor-redo"
    >
      <IconRedo size={15} />
    </ToolbarButton>
  );
}

export function BoldButton({ editor }: { editor: NonNullable<ReturnType<typeof useEditor>> }) {
  const active = useMarkPress(editor, "bold");
  return (
    <ToolbarButton title={t("editor.bold")} onClick={() => editor.chain().focus().toggleBold().run()} active={active}>
      <IconBold size={15} strokeWidth={2.2} />
    </ToolbarButton>
  );
}

export function ItalicButton({ editor }: { editor: NonNullable<ReturnType<typeof useEditor>> }) {
  const active = useMarkPress(editor, "italic");
  return (
    <ToolbarButton title={t("editor.italic")} onClick={() => editor.chain().focus().toggleItalic().run()} active={active}>
      <IconItalic size={15} strokeWidth={2} />
    </ToolbarButton>
  );
}

export function StrikeButton({ editor }: { editor: NonNullable<ReturnType<typeof useEditor>> }) {
  const active = useMarkPress(editor, "strike");
  return (
    <ToolbarButton title={t("editor.strikethrough")} onClick={() => editor.chain().focus().toggleStrike().run()} active={active}>
      <IconStrike size={15} strokeWidth={2} />
    </ToolbarButton>
  );
}

type ParagraphStyle = "p" | "h1" | "h2" | "h3";

export function ParagraphStyleSelect({ editor }: { editor: NonNullable<ReturnType<typeof useEditor>> }) {
  const value: ParagraphStyle = editor.isActive("heading", { level: 1 })
    ? "h1"
    : editor.isActive("heading", { level: 2 })
      ? "h2"
      : editor.isActive("heading", { level: 3 })
        ? "h3"
        : "p";

  const onChange = (v: ParagraphStyle) => {
    if (v === "p") editor.chain().focus().setParagraph().run();
    else editor.chain().focus().toggleHeading({ level: Number(v[1]) as 1 | 2 | 3 }).run();
  };

  return (
    <Select
      value={value}
      onChange={(v) => onChange(v as ParagraphStyle)}
      ariaLabel={t("editor.heading_step")}
      testid="paragraph-style-select"
      options={[
        { value: "p", label: t("editor.normal") },
        { value: "h1", label: t("editor.heading_1") },
        { value: "h2", label: t("editor.heading_2") },
        { value: "h3", label: t("editor.heading_3") },
      ]}
      style={{
        marginRight: "var(--space-1)",
        fontSize: "var(--text-xs)",
        fontFamily: "var(--font-body)",
      }}
    />
  );
}

/** Link toolbar control — popover accepts both URL and display text when no selection exists (2-6). */
export function LinkButton({ editor }: { editor: NonNullable<ReturnType<typeof useEditor>> }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const active = useIsActive(editor, "link");
  const close = useCallback(() => setOpen(false), []);
  const { anchorRef, popRef, x, y } = useFloatingPopover(open, close);
  // Owner QA 6, item 5: the range to apply the link to, captured once at popover-open time — see
  // `apply()`'s comment for why this must not be re-read from live editor.state.selection.
  const [capturedRange, setCapturedRange] = useState<{ from: number; to: number } | null>(null);
  const trimmedUrl = url.trim();
  const validUrl = isValidLinkUrl(trimmedUrl);

  const openPopover = () => {
    const { from, to } = editor.state.selection;
    setCapturedRange({ from, to });
    const selectedText = editor.state.doc.textBetween(from, to, " ");
    setText(selectedText);
    setUrl((editor.getAttributes("link").href as string) || "");
    setOpen(true);
  };

  const apply = () => {
    const trimmedText = text.trim();
    if (!validUrl) return;

    // Owner QA 6, item 5 ("본문에 링크 추가한 경우..."): apply to the range captured when the
    // popover opened, not editor.state.selection read fresh here. The popover's URL/text inputs
    // live outside the editor's own DOM (autoFocus steals focus the moment the popover opens) —
    // this code has no business trusting "whatever the live selection happens to be" to still
    // match the text the user actually selected before opening the popover. Clamp to the current
    // doc size (content can still grow/shrink while the popover is open) so this can't throw.
    const docSize = editor.state.doc.content.size;
    const range = capturedRange ?? { from: editor.state.selection.from, to: editor.state.selection.to };
    const from = Math.min(range.from, docSize);
    const to = Math.min(range.to, docSize);

    if (from === to) {
      const label = trimmedText || trimmedUrl;
      editor
        .chain()
        .focus()
        .insertContentAt(from, {
          type: "text",
          text: label,
          marks: [{ type: "link", attrs: { href: trimmedUrl } }],
        })
        .run();
    } else {
      editor
        .chain()
        .focus()
        .setTextSelection({ from, to })
        .extendMarkRange("link")
        .setLink({ href: trimmedUrl })
        .run();
    }
    setOpen(false);
  };

  const remove = () => {
    editor.chain().focus().unsetLink().run();
    setOpen(false);
  };

  return (
    <div ref={anchorRef} style={{ display: "inline-flex" }}>
      <ToolbarButton title={t("editor.link")} onClick={openPopover} active={active}>
        <IconLink size={15} strokeWidth={2} />
      </ToolbarButton>
      {open && createPortal(
        <div
          ref={popRef}
          className="overlay"
          role="dialog"
          aria-label={t("editor.link")}
          // Lets the selection BubbleMenu's shouldShow (TextBubbleMenu.tsx) recognize this portal
          // as "still part of the menu" once its autoFocus'd input steals DOM focus away from
          // `element` — otherwise the menu (and this popover's trigger button) would hide from
          // under the user while they're mid-edit.
          data-editor-pop=""
          style={{
            position: "fixed",
            top: y,
            left: x,
            zIndex: "var(--z-dropdown)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: 10,
            border: "2px solid var(--divider)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-lg)",
            width: 250,
          }}
        >
          {/* Owner QA 6, item 5: driven by the range captured at open time (see apply()'s
              comment), not live selection.empty — stable for the popover's whole lifetime
              instead of potentially flipping under the user while they interact with it. */}
          {capturedRange?.from === capturedRange?.to && (
            <label style={{ display: "grid", gap: 3, fontSize: "var(--text-xs)", color: "var(--muted)" }}>
              {t("editor.link_text_label")}
              <input
                className="field"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t("editor.link_text_placeholder")}
                style={{ fontSize: "var(--text-sm)", padding: "6px 8px" }}
              />
            </label>
          )}
          <label style={{ display: "grid", gap: 3, fontSize: "var(--text-xs)", color: "var(--muted)" }}>
            {t("editor.link_url_label")}
            <input
              className="field"
              type="url"
              autoFocus
              value={url}
              aria-invalid={trimmedUrl.length > 0 && !validUrl}
              aria-describedby="editor-link-error"
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("editor.link_placeholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter") apply();
                if (e.key === "Escape") setOpen(false);
              }}
              style={{ fontSize: "var(--text-sm)", padding: "6px 8px" }}
            />
          </label>
          {trimmedUrl.length > 0 && !validUrl && (
            <span id="editor-link-error" role="alert" style={{ color: "var(--danger)", fontSize: "var(--text-xs)" }}>
              {t("editor.link_invalid")}
            </span>
          )}
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            {active && (
              <button
                type="button"
                onClick={remove}
                style={{
                  padding: "4px 10px",
                  border: "1px solid var(--divider)",
                  borderRadius: "var(--radius-sm)",
                  background: "transparent",
                  color: "var(--muted)",
                  fontSize: "var(--text-sm)",
                  cursor: "pointer",
                }}
              >
                {t("editor.link_remove")}
              </button>
            )}
            <button
              type="button"
              onClick={apply}
              disabled={!validUrl}
              style={{
                padding: "4px 10px",
                border: "1px solid var(--accent)",
                borderRadius: "var(--radius-sm)",
                background: "transparent",
                color: "var(--accent)",
                fontSize: "var(--text-sm)",
                fontWeight: 600,
                cursor: validUrl ? "pointer" : "not-allowed",
                opacity: validUrl ? 1 : 0.5,
              }}
            >
              {t("editor.link_apply")}
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

export function isValidLinkUrl(value: string): boolean {
  if (!value) return false;
  try {
    return ["http:", "https:", "mailto:", "note:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

// Insert-race guard (mirrors EditorPanel.tsx's pasteImageFile / isPasteStillOnTarget, added
// a0997af; widened to also cover section switches — flagged follow-up from 9cb466d) — true when
// the note AND section this insert started against are still the active ones. Moved to
// lib/onTargetGuard.ts (shared with EditorPanel.tsx and useEditorFileDrop.ts) — re-exported
// under its old name because buttons.image.test.tsx imports it from here.
export const isInsertStillOnTarget = isStillOnTarget;

export function ImageButton({
  editor,
  noteId,
  sectionRef,
}: {
  editor: NonNullable<ReturnType<typeof useEditor>>;
  noteId: string;
  // The live section ref EditorPanel.tsx already tracks (its own `sectionRef`, kept in sync with
  // the actually-mounted section — see that file's setActiveSection comment on why it's the
  // authoritative source, not the React-state activeSectionId mirror). Passed down as the ref
  // object itself (not a snapshot value) so it can be re-read fresh after the awaits below, the
  // same way `useNotesStore.getState()` gives a fresh noteId — a plain value prop would only be
  // able to capture the target, not re-check the current section post-await.
  sectionRef: { current: { id: string } | null };
}) {
  const insertImage = async () => {
    try {
      // Captured before any await — same capture point as noteId (this component's own prop),
      // there is no materialization step here to wait out first (unlike pasteImageFile's
      // ensureMaterialized(); ImageButton only ever renders once EditorPanel already has a
      // non-null activeNote, see its `if (!editor || !activeNote) return null` guard).
      const target = { noteId, sectionId: sectionRef.current?.id ?? null };
      // Owner QA 6, item 4 ("이미지 삽입이 캐럿 위치에 안 들어간다"): capture the insert range now,
      // not just the note/section identity. The native file dialog itself is modal — the user
      // can't touch the document while it's open — but the SECOND await below (attachment_add_file,
      // a real IPC round trip) hands control back to the app, and the caret can move (click,
      // continued typing) before this resolves. Inserting at "whatever editor.state.selection
      // happens to be by the time we get here" would land the image wherever the cursor drifted
      // to, not where the user had it when they clicked the toolbar button.
      const insertRange = { from: editor.state.selection.from, to: editor.state.selection.to };
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      const attachment = await call<{ name: string; rel_path: string | null }>("attachment_add_file", {
        note_id: noteId,
        file_path: selected,
      });

      // The attachment is already saved server-side at this point no matter what happens next.
      // If the user switched notes OR sections during the two awaits above (file dialog +
      // attachment_add_file), inserting the image node now would land it in the WRONG
      // note/section — skip the insert instead (the attachment stays safely saved, just not
      // auto-inserted; losing the auto-insert is acceptable, a cross-document write is not —
      // same tradeoff as pasteImageFile's guard).
      const current = {
        noteId: useNotesStore.getState().activeNote?.note.id,
        sectionId: sectionRef.current?.id ?? null,
      };
      if (!isInsertStillOnTarget(target, current)) {
        emitNotice(t("editor.image_paste_note_changed"));
        return;
      }

      // No display-src precompute here — relPath alone is set; ImageNodeView resolves it to a
      // paintable asset:// URL at render time (root-cause fix, see its header comment). That
      // resolution runs identically right now AND after reloadActive()'s setContent re-parse
      // below, so there's nothing left to go stale between the two.
      //
      // insertContentAt(insertRange, ...) instead of setImage()'s implicit "insert at whatever
      // the current selection is" — clamp to the live doc size first (content may have grown or
      // shrunk during the awaits above; the position itself can't be re-mapped through those
      // edits, but clamping at least keeps it a valid position instead of throwing).
      const docSize = editor.state.doc.content.size;
      const range = {
        from: Math.min(insertRange.from, docSize),
        to: Math.min(insertRange.to, docSize),
      };
      editor
        .chain()
        .focus()
        .insertContentAt(range, {
          type: "image",
          attrs: {
            alt: attachment.name,
            // Schema attr name is relPath (BriseImage); rendered as data-rel-path in HTML and as
            // the markdown image destination on save (P0-1).
            relPath: attachment.rel_path ?? null,
            // D5: default insert width = 40% of content column
            width: formatImageWidth(IMAGE_WIDTH_DEFAULT),
          },
        })
        .run();
      useNotesStore.getState().reloadActive();
    } catch (err) {
      // Native file dialog cancel is not an error we surface; real failures get a toast.
      // (plugin-dialog typically returns null on cancel — that path returns above. Other
      // reject reasons are attachment_add_file / convert failures.)
      console.warn("image insert failed", err);
      emitNotice(t("editor.image_insert_failed"));
    }
  };

  return (
    <ToolbarButton title={t("editor.image")} onClick={() => void insertImage()}>
      <IconImage size={15} strokeWidth={2} />
    </ToolbarButton>
  );
}

export function UnderlineButton({ editor }: { editor: NonNullable<ReturnType<typeof useEditor>> }) {
  const active = useMarkPress(editor, "underline");
  return (
    <ToolbarButton title={t("editor.underline")} onClick={() => editor.chain().focus().toggleUnderline().run()} active={active}>
      <IconUnderline size={15} strokeWidth={2} />
    </ToolbarButton>
  );
}

export function HighlightButton({ editor }: { editor: NonNullable<ReturnType<typeof useEditor>> }) {
  const active = useMarkPress(editor, "highlight");
  return (
    <ToolbarButton title={t("editor.highlight")} onClick={() => editor.chain().focus().toggleHighlight().run()} active={active}>
      <IconHighlight size={15} strokeWidth={2} />
    </ToolbarButton>
  );
}

export function ColorButton({ editor }: { editor: NonNullable<ReturnType<typeof useEditor>> }) {
  const [open, setOpen] = useState(false);
  // Same useEditorState pattern as useIsActive — getAttributes alone does not re-render on selection tx.
  const activeColor = useEditorState({
    editor,
    selector: ({ editor: ed }) => (ed.getAttributes("textStyle").color as string) || "",
  });
  const colors = ["#7da98c", "#e07a5f", "#f2cc8f", "#3d405b", "#81b29a", "#e76f51"];
  const close = useCallback(() => setOpen(false), []);
  const { anchorRef, popRef, x, y } = useFloatingPopover(open, close);

  return (
    <div ref={anchorRef} style={{ display: "inline-flex" }}>
      <ToolbarButton title={t("editor.text_color")} onClick={() => setOpen(!open)} active={!!activeColor}>
        <IconPalette size={15} strokeWidth={2} />
      </ToolbarButton>
      {open && createPortal(
        <div
          ref={popRef}
          className="overlay"
          role="dialog"
          aria-label={t("editor.text_color")}
          // See LinkButton's identical comment — same BubbleMenu shouldShow interaction.
          data-editor-pop=""
          style={{
            position: "fixed",
            top: y,
            left: x,
            zIndex: "var(--z-dropdown)",
            display: "flex",
            gap: 4,
            padding: 6,
            border: "1px solid var(--divider)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-lg)",
          }}
        >
          {colors.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => {
                editor.chain().focus().setColor(c).run();
                setOpen(false);
              }}
              style={{
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: c,
                border: activeColor === c ? "2px solid var(--text)" : "1px solid var(--divider)",
                cursor: "pointer",
              }}
            />
          ))}
          {activeColor && (
            <button
              type="button"
              aria-label={t("ctx.folder_color_reset")}
              onClick={() => {
                editor.chain().focus().unsetColor().run();
                setOpen(false);
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                background: "transparent",
                border: "none",
                color: "var(--muted)",
                cursor: "pointer",
                padding: "0 4px",
              }}
            >
              <IconClose size={12} strokeWidth={2} />
            </button>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

export function TableButton({ editor }: { editor: NonNullable<ReturnType<typeof useEditor>> }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [hovered, setHovered] = useState<{ rows: number; cols: number } | null>(null);
  const [withHeaderRow, setWithHeaderRow] = useState(true);
  const close = useCallback(() => setOpen(false), []);
  const { anchorRef, popRef, x, y } = useFloatingPopover(open, close);

  const show = () => {
    setRows(3);
    setCols(3);
    setHovered(null);
    setWithHeaderRow(true);
    setOpen(true);
  };
  const insert = (nextRows = rows, nextCols = cols) => {
    editor.chain().focus().insertTable({
      rows: Math.max(1, Math.min(50, nextRows)),
      cols: Math.max(1, Math.min(50, nextCols)),
      withHeaderRow,
    }).run();
    setOpen(false);
  };

  return (
    <div ref={anchorRef} style={{ display: "inline-flex" }}>
      <ToolbarButton title={t("editor.table_insert")} onClick={show}>
        <IconTable size={15} strokeWidth={2} />
      </ToolbarButton>
      {open && createPortal(
        <div
          ref={popRef}
          className="overlay"
          role="dialog"
          aria-label={t("editor.table_insert")}
          data-editor-pop=""
          style={{
            position: "fixed",
            top: y,
            left: x,
            zIndex: "var(--z-dropdown)",
            width: 258,
            padding: 10,
            border: "1px solid var(--divider)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-lg)",
          }}
        >
          <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, marginBottom: 7 }}>
            {(hovered?.rows ?? rows)} × {(hovered?.cols ?? cols)}
          </div>
          <div
            data-testid="table-size-grid"
            onMouseLeave={() => setHovered(null)}
            style={{ display: "grid", gridTemplateColumns: "repeat(10, 18px)", gap: 3 }}
          >
            {Array.from({ length: 100 }, (_, index) => {
              const gridRows = Math.floor(index / 10) + 1;
              const gridCols = (index % 10) + 1;
              const preview = hovered ?? { rows, cols };
              const selected = gridRows <= preview.rows && gridCols <= preview.cols;
              return (
                <button
                  key={index}
                  type="button"
                  aria-label={`${gridRows} × ${gridCols}`}
                  onMouseEnter={() => setHovered({ rows: gridRows, cols: gridCols })}
                  onFocus={() => setHovered({ rows: gridRows, cols: gridCols })}
                  onClick={() => insert(gridRows, gridCols)}
                  style={{
                    width: 18,
                    height: 18,
                    padding: 0,
                    border: `1px solid ${selected ? "var(--accent)" : "var(--divider)"}`,
                    borderRadius: 2,
                    background: selected ? "color-mix(in srgb, var(--accent) 22%, transparent)" : "transparent",
                    cursor: "pointer",
                  }}
                />
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "end", marginTop: 10 }}>
            {([
              ["editor.table_rows", rows, setRows],
              ["editor.table_columns", cols, setCols],
            ] as const).map(([label, value, setter]) => (
              <label key={label} style={{ display: "grid", gap: 3, fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                {t(label)}
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={value}
                  onChange={(e) => setter(Math.max(1, Math.min(50, e.currentTarget.valueAsNumber || 1)))}
                  style={{ width: 64, padding: "4px 6px", color: "var(--text)", background: "transparent", border: "1px solid var(--divider)", borderRadius: "var(--radius-sm)" }}
                />
              </label>
            ))}
            <button type="button" className="toolbar-btn toolbar-btn--text" onClick={() => insert()} style={{ marginLeft: "auto" }}>
              {t("editor.table_insert_action")}
            </button>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 9, fontSize: "var(--text-xs)" }}>
            <input type="checkbox" checked={withHeaderRow} onChange={(e) => setWithHeaderRow(e.currentTarget.checked)} />
            {t("editor.table_first_row_header")}
          </label>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** D6: Heading Level Switcher (▲▼: Paragraph ↔ H1 ↔ H2 ↔ H3) — shared by FixedToolbar and
 *  TextBubbleMenu. */
export function HeadingStepButtons({ editor }: { editor: NonNullable<ReturnType<typeof useEditor>> }) {
  const currentLevel = editor.isActive("heading", { level: 1 })
    ? 1
    : editor.isActive("heading", { level: 2 })
    ? 2
    : editor.isActive("heading", { level: 3 })
    ? 3
    : 0;

  const stepUp = () => {
    const next = currentLevel === 0 ? 1 : currentLevel === 1 ? 2 : currentLevel === 2 ? 3 : 0;
    if (next === 0) editor.chain().focus().setParagraph().run();
    else editor.chain().focus().toggleHeading({ level: next as 1 | 2 | 3 }).run();
  };

  const stepDown = () => {
    const prev = currentLevel === 3 ? 2 : currentLevel === 2 ? 1 : currentLevel === 1 ? 0 : 3;
    if (prev === 0) editor.chain().focus().setParagraph().run();
    else editor.chain().focus().toggleHeading({ level: prev as 1 | 2 | 3 }).run();
  };

  const label = currentLevel === 0 ? "P" : `H${currentLevel}`;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 1 }}>
      <button
        type="button"
        className="toolbar-btn"
        data-active={currentLevel > 0 ? "true" : undefined}
        onClick={stepUp}
        title={t("editor.heading_step")}
        aria-label={t("editor.heading_step")}
        style={{ fontSize: "var(--text-xs)", fontWeight: 600, padding: "var(--space-2xs) 5px", display: "flex", gap: "var(--space-2xs)", alignItems: "center" }}
      >
        <IconArrowUp size={11} strokeWidth={2.5} /> <span style={{ fontSize: "var(--text-label)" }}>{label}</span>
      </button>
      <button
        type="button"
        className="toolbar-btn"
        onClick={stepDown}
        title={t("editor.heading_step")}
        aria-label={t("editor.heading_step")}
        style={{ fontSize: "var(--text-xs)", fontWeight: 600, padding: "var(--space-2xs) 5px", display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <IconArrowDown size={11} strokeWidth={2.5} />
      </button>
    </div>
  );
}
