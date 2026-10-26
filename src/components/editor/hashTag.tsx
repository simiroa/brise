/**
 * "#" hash-tag autocomplete — PLAN-2026-09-18-nl-dates.md §W5. Typing "#" opens a tag-name
 * autocomplete (existing workspace tags by frequency, or a synthesized "create new tag: '…'" row
 * when the typed query doesn't exactly match an existing tag); picking a result replaces the
 * trigger text with plain "#tagname" — no mark, no schema change (same D6 spirit as the date
 * entry points: body stays plain text, nothing extra to serialize/round-trip).
 *
 * Storage convention follows TagEditor.tsx: displayed with a leading "#", stored without one
 * (`tagDraft.trim().replace(/^#/, "")`). Tag registration reuses stores/notesActive.ts's
 * `setTags` action (never a direct `note_set_tags` call here) — it already owns the full-replace
 * contract (`note_set_tags` overwrites the whole array, so the caller must read-then-append) and
 * `refreshTagCounts()`, and its draft-note branch materializes the note before persisting, so a
 * still-unmaterialized note (draft page) is handled for free.
 *
 * Modeled on wikiLink.tsx/slashCommand.tsx's `@tiptap/suggestion` idiom — see those files' headers
 * for why this repo hand-rolls popup positioning (suggestionPopup.tsx) instead of tippy.js.
 */
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { Extension } from "@tiptap/core";
import type { Editor, Range } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { call } from "../../lib/invoke";
import { useNotesStore } from "../../stores/notes";
import { t } from "../../i18n/t";
import { createSuggestionRender, type SuggestionListRef } from "./suggestionPopup";
import { INTERNAL_PICKER_DEBOUNCE_MS } from "../attachments/InternalNotePicker";

const HASHTAG_RESULT_LIMIT = 8;

export interface HashTagItem {
  /** Tag name, no leading "#" — always the bare stored form (TagEditor.tsx convention). */
  name: string;
  /** True for the synthesized "새 태그 만들기: '…'" row appended when nothing matches exactly. */
  isNew: boolean;
}

/**
 * Pure filter — exported for unit tests. `counts` is tag_counts' raw `{name: count}` map; sorted
 * by frequency desc (ties broken alphabetically for a stable order), then substring-filtered by
 * `query` (case-insensitive, like filterSlashItems in slashCommand.tsx). A trailing "create new"
 * entry is appended when the trimmed query is non-empty and no existing tag matches it exactly
 * (case-sensitive — the same identity rule TagEditor.tsx's tag_names arrays use elsewhere).
 */
export function filterHashTagCandidates(
  counts: Record<string, number>,
  query: string,
  limit = HASHTAG_RESULT_LIMIT,
): HashTagItem[] {
  const q = query.trim();
  const ql = q.toLowerCase();
  const byFrequency = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
  const filtered = ql ? byFrequency.filter((name) => name.toLowerCase().includes(ql)) : byFrequency;
  const items: HashTagItem[] = filtered.slice(0, limit).map((name) => ({ name, isNew: false }));
  if (q && !byFrequency.includes(q)) {
    items.push({ name: q, isNew: true });
  }
  return items;
}

async function fetchHashTagCandidates(query: string): Promise<HashTagItem[]> {
  const r = await call<{ counts: Record<string, number> }>("tag_counts");
  return filterHashTagCandidates(r.counts ?? {}, query);
}

/**
 * Selection handler — exported separately from the Extension so it's unit-testable without
 * mounting a real TipTap editor (same split as slashCommand.tsx's SlashItem.run functions).
 *
 * After replacing the trigger text, an extra trailing space is inserted (the plan's own snippet
 * omits it, but leaving it out re-opens this very popup immediately: @tiptap/suggestion's match
 * regex is `char + [^space,char]*`, so a cursor sitting right after "#tagname" with no space still
 * matches "#tagname" as a fresh, unbroken trigger+query and reopens the menu on the same
 * transaction. wikiLink.tsx hits the same class of problem and also appends a trailing text node
 * after its inserted result).
 */
export function insertHashTagSelection(editor: Editor, range: Range, item: HashTagItem): void {
  const tagName = item.name.trim();
  if (!tagName) return;

  editor.chain().focus().deleteRange(range).insertContent(`#${tagName} `).run();

  const activeNote = useNotesStore.getState().activeNote;
  if (!activeNote) return; // 활성 노트가 아예 없으면(이론상 도달 안 함 — EditorPanel이 그 경우
  // 에디터 자체를 안 그린다) 본문 치환만 하고 태그 등록은 건너뛴다.
  const current = activeNote.note.tag_names ?? [];
  if (current.includes(tagName)) return;
  // 전량 교체 계약(note_set_tags: 배열 전체를 덮어쓴다) — 반드시 기존 tag_names를 먼저 읽어
  // append 해야 한다. setTags(stores/notesActive.ts:657)가 그 계약 + refreshTagCounts()를 이미
  // 캡슐화하므로 그대로 재사용(초안 노트라면 setTags 내부의 ensureMaterialized 경로가 처리).
  void useNotesStore.getState().setTags([...current, tagName]);
}

const HashTagMenuList = forwardRef<SuggestionListRef, { items: HashTagItem[]; command: (item: HashTagItem) => void }>(
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
        {items.map((item, i) => (
          <button
            key={item.isNew ? `__create__:${item.name}` : item.name}
            type="button"
            role="option"
            aria-selected={i === selected}
            data-selected={i === selected}
            className="menu-row menu-item"
            onMouseEnter={() => setSelected(i)}
            onClick={() => command(item)}
            style={{ color: "inherit" }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {item.isNew ? t("editor.hashtag_create_new", { query: item.name }) : `#${item.name}`}
            </span>
          </button>
        ))}
      </div>
    );
  }
);
HashTagMenuList.displayName = "HashTagMenuList";

export const HashTag = Extension.create({
  name: "hashTag",

  addOptions() {
    return {
      suggestion: {
        char: "#",
        // startOfLine 없음(기본 false) — 태그는 줄 중간에도 나와야 한다(§W5 결정).
        pluginKey: new PluginKey("hashTag"),
        debounce: INTERNAL_PICKER_DEBOUNCE_MS,
        // 코드 블록 안에서는 안 뜬다 — slashCommand.tsx의 allow와 같은 이유(코드/경로에 쓰인
        // "#"이 태그 팝업을 열면 안 된다).
        allow: ({ state, range }: { state: import("@tiptap/pm/state").EditorState; range: Range }) =>
          !state.doc.resolve(range.from).parent.type.spec.code,
        items: async ({ query }: { query: string }) => {
          try {
            return await fetchHashTagCandidates(query);
          } catch {
            // tag_counts 실패해도 "새 태그 만들기"는 여전히 제안할 수 있다 — 기존 목록만 빈다.
            return filterHashTagCandidates({}, query);
          }
        },
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: HashTagItem }) => {
          insertHashTagSelection(editor, range, props);
        },
        render: createSuggestionRender<HashTagItem>(HashTagMenuList),
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
