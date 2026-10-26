/**
 * "[[" wiki-link autocomplete — wave 3. Typing "[[" opens a note-title search; picking a result
 * inserts a real Link mark (`<a href="note://<id>">title</a>`), NOT a custom node — see
 * mdSerialize.ts's passthrough rule for why that's the only shape that survives save/reload.
 *
 * Reuses the exact `search_notes` query shape InternalNotePicker.tsx already uses for the same
 * "type a fragment, get top note matches" job, and its debounce constant — this is the same job,
 * just triggered from inside the editor instead of a modal.
 */
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { Extension } from "@tiptap/core";
import type { Range } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { call } from "../../lib/invoke";
import { noteQuery } from "../../lib/noteQuery";
import type { NoteSummary } from "../../lib/commands.gen";
import { INTERNAL_PICKER_DEBOUNCE_MS } from "../attachments/InternalNotePicker";
import { createSuggestionRender, type SuggestionListRef } from "./suggestionPopup";
import { displayTitle } from "../../stores/notes";

const WIKILINK_RESULT_LIMIT = 8;

async function fetchWikiLinkCandidates(query: string): Promise<NoteSummary[]> {
  const q = query.trim();
  if (!q) {
    const r = await noteQuery({ sort: "title_asc", offset: 0, limit: WIKILINK_RESULT_LIMIT });
    return r.notes;
  }
  const r = await call<{ results: NoteSummary[] }>("search_notes", {
    query: q,
    year_from: -9999,
    year_to: 9999,
  });
  return (r.results ?? []).slice(0, WIKILINK_RESULT_LIMIT);
}

const WikiLinkMenuList = forwardRef<SuggestionListRef, { items: NoteSummary[]; command: (item: NoteSummary) => void }>(
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

    if (items.length === 0) return null;

    return (
      <div role="listbox" style={{ display: "flex", flexDirection: "column", gap: "var(--space-2xs)", maxHeight: 280, overflowY: "auto" }}>
        {items.map((note, i) => (
          <button
            key={note.id}
            type="button"
            role="option"
            aria-selected={i === selected}
            data-selected={i === selected}
            className="menu-row menu-item"
            onMouseEnter={() => setSelected(i)}
            onClick={() => command(note)}
            style={{ color: "inherit", justifyContent: "space-between" }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayTitle(note.title)}</span>
            <span style={{ flex: "none", color: "var(--faint)", fontSize: "var(--text-xs)" }}>{note.year}</span>
          </button>
        ))}
      </div>
    );
  }
);
WikiLinkMenuList.displayName = "WikiLinkMenuList";

export const WikiLink = Extension.create({
  name: "wikiLink",

  addOptions() {
    return {
      suggestion: {
        char: "[[",
        // Unlike slash commands, a wiki-link can start mid-sentence ("see [[some note]]"), not
        // just after a space — Suggestion's default allowedPrefixes ([' ']) would otherwise
        // refuse to trigger right after a word character.
        allowedPrefixes: null,
        pluginKey: new PluginKey("wikiLink"),
        debounce: INTERNAL_PICKER_DEBOUNCE_MS,
        items: async ({ query }: { query: string }) => {
          try {
            return await fetchWikiLinkCandidates(query);
          } catch {
            return [];
          }
        },
        command: ({ editor, range, props }: { editor: import("@tiptap/core").Editor; range: Range; props: NoteSummary }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              { type: "text", marks: [{ type: "link", attrs: { href: `note://${props.id}` } }], text: props.title },
              { type: "text", text: " " },
            ])
            .run();
        },
        render: createSuggestionRender<NoteSummary>(WikiLinkMenuList),
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
