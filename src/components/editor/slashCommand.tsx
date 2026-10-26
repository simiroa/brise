/**
 * "/" slash-command menu — wave 3. Typing "/" at the start of a line opens an insert menu
 * (heading/quote/code/lists/checklist/table/details/divider); arrows+Enter pick, Escape cancels.
 * Built on the community-standard `@tiptap/suggestion` + ReactRenderer pattern — see
 * suggestionPopup.tsx for the shared popup plumbing (positioning, Escape teardown).
 */
import React, { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { Extension } from "@tiptap/core";
import type { Editor, Range } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import {
  IconH1, IconH2, IconH3, IconQuote, IconCodeBlock, IconCheck, IconTable, IconCaret, IconMinimize,
  IconBulletList, IconOrderedList, IconCalendar, IconMapPin,
} from "../icons";
import { t } from "../../i18n/t";
import { createSuggestionRender, type SuggestionListRef } from "./suggestionPopup";
import { useNotesStore } from "../../stores/notes";
import { openDateEntry } from "../../lib/dateEntryBridge";
import { openRegionEntry } from "../../lib/regionEntryBridge";

export interface SlashItem {
  key: string;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  run: (editor: Editor, range: Range) => void;
}

/** Built lazily (not module scope) so t() reads the language active at insert time. */
export function buildSlashItems(): SlashItem[] {
  return [
    { key: "h1", label: t("editor.heading_1"), icon: IconH1, run: (e, r) => e.chain().focus().deleteRange(r).toggleHeading({ level: 1 }).run() },
    { key: "h2", label: t("editor.heading_2"), icon: IconH2, run: (e, r) => e.chain().focus().deleteRange(r).toggleHeading({ level: 2 }).run() },
    { key: "h3", label: t("editor.heading_3"), icon: IconH3, run: (e, r) => e.chain().focus().deleteRange(r).toggleHeading({ level: 3 }).run() },
    { key: "blockquote", label: t("editor.blockquote"), icon: IconQuote, run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
    { key: "codeBlock", label: t("editor.code_block"), icon: IconCodeBlock, run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
    { key: "bulletList", label: t("editor.bullet_list"), icon: IconBulletList, run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
    { key: "orderedList", label: t("editor.ordered_list"), icon: IconOrderedList, run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
    { key: "task", label: t("editor.task"), icon: IconCheck, run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
    { key: "table", label: t("editor.table_insert"), icon: IconTable, run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run() },
    // IconCaret needs a `dir` prop the shared SlashItem.icon signature doesn't carry — wrap it
    // rather than widen that signature for one item. Keeps the pre-wrapper look (down, unrotated).
    { key: "details", label: t("editor.details"), icon: (p) => <IconCaret dir="down" size={p.size} />, run: (e, r) => e.chain().focus().deleteRange(r).setDetails().run() },
    { key: "divider", label: t("editor.divider"), icon: IconMinimize, run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
    // PLAN-2026-09-18-nl-dates.md §W2 (D5/D6) — 다른 항목과 달리 즉시 커맨드를 실행하지 않는다.
    // "/날짜" 트리거 텍스트는 그대로 두고 lib/dateEntryBridge 로 DateEntryPopover 를 연다 — 팝오버가
    // "+" 로 관련 날짜를 성공적으로 등록하면 그때서야 이 range 를 평문 한 줄로 치환한다
    // (replaceRangeOnSave:true). 취소(Escape/바깥 클릭)하면 "/날짜" 텍스트가 그대로 남는다 —
    // footnoteCtx/translateCtx 등 이 파일의 다른 비동기 팝오버들과 같은 취소 시 무행동 관용구.
    {
      key: "date",
      label: t("editor.slash_date"),
      icon: IconCalendar,
      run: (editor, range) => {
        const noteId = useNotesStore.getState().activeNote?.note.id;
        if (!noteId) return;
        const coords = editor.view.coordsAtPos(range.from);
        openDateEntry({
          noteId,
          anchorX: coords.left,
          anchorY: coords.bottom + 6,
          range: { from: range.from, to: range.to },
          replaceRangeOnSave: true,
        });
      },
    },
    // PLAN-2026-09-18-nl-dates.md §W6 — same shape as the "date" item just above: opens a popover
    // (RegionEntryPopover via lib/regionEntryBridge) instead of running a command immediately. The
    // "/지역" trigger text stays put until a search result is picked; a successful pick replaces it
    // with the picked place's plain-text label (that popover's own replaceTriggerText).
    {
      key: "region",
      label: t("editor.slash_region"),
      icon: IconMapPin,
      run: (editor, range) => {
        const noteId = useNotesStore.getState().activeNote?.note.id;
        if (!noteId) return;
        const coords = editor.view.coordsAtPos(range.from);
        openRegionEntry({
          noteId,
          anchorX: coords.left,
          anchorY: coords.bottom + 6,
          range: { from: range.from, to: range.to },
        });
      },
    },
  ];
}

/**
 * Pure filter — exported for unit tests. Matches on the (localized) label OR the item's
 * locale-invariant `key` ("h1", "blockquote", "table", ...). Label-only matching would silently
 * break for every non-English locale: under ko, labels read 제목 1/인용구/표 삽입, so a user typing
 * the English command name (as this app's own docs/muscle memory might expect) would get zero
 * matches. Key matching keeps the ASCII command name working in every language, in addition to
 * label matching working in the user's own language.
 */
export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((i) => i.label.toLowerCase().includes(q) || i.key.toLowerCase().includes(q));
}

const SlashMenuList = forwardRef<SuggestionListRef, { items: SlashItem[]; command: (item: SlashItem) => void }>(
  ({ items, command }, ref) => {
    const [selected, setSelected] = useState(0);

    useEffect(() => {
      setSelected((s) => Math.min(s, Math.max(0, items.length - 1)));
    }, [items]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (event.isComposing) return false;
        if (event.key === "ArrowDown") {
          setSelected((s) => (items.length ? (s + 1) % items.length : 0));
          return true;
        }
        if (event.key === "ArrowUp") {
          setSelected((s) => (items.length ? (s - 1 + items.length) % items.length : 0));
          return true;
        }
        if (event.key === "Enter") {
          if (items[selected]) command(items[selected]);
          return true;
        }
        return false;
      },
    }));

    if (items.length === 0) {
      return (
        <div style={{ padding: "8px 10px", fontSize: "var(--text-md)", color: "var(--muted)" }}>
          {t("editor.slash_no_match")}
        </div>
      );
    }

    return (
      <div role="listbox" style={{ display: "flex", flexDirection: "column", gap: "var(--space-2xs)", maxHeight: 280, overflowY: "auto" }}>
        {items.map((item, i) => (
          <button
            key={item.key}
            type="button"
            role="option"
            aria-selected={i === selected}
            data-selected={i === selected}
            className="menu-row menu-item"
            onMouseEnter={() => setSelected(i)}
            onClick={() => command(item)}
            style={{ color: "inherit" }}
          >
            <item.icon size={15} strokeWidth={1.8} />
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    );
  }
);
SlashMenuList.displayName = "SlashMenuList";

export const SlashCommand = Extension.create({
  name: "slashCommand",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        startOfLine: true,
        pluginKey: new PluginKey("slashCommand"),
        // Slash-in-code-line (e.g. typing a path) shouldn't pop the insert menu.
        allow: ({ state, range }: { state: import("@tiptap/pm/state").EditorState; range: Range }) =>
          !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }: { query: string }) => filterSlashItems(buildSlashItems(), query),
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: SlashItem }) => {
          props.run(editor, range);
        },
        render: createSuggestionRender<SlashItem>(SlashMenuList),
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
