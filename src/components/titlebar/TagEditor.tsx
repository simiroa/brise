import React, { useState, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useNotesStore } from "../../stores/notes";
import { bundledKeyFor, emojiAvailable, emojiSrc, subscribeEmojiRender } from "../../lib/emoji/emojiCore";
import type { EmojiEntry } from "../../lib/emoji/emojiManifest";
import { folderColorCss, useMenuPos } from "../../lib/ui";
import { FluidHoverHighlight, useFluidHover } from "../common/FluidHover";
import { resolveAllTags } from "../../lib/tagCounts";
import { call } from "../../lib/invoke";
import { scheduleUndoableDelete } from "../../lib/undo";
import { IconClose, IconPlus } from "../icons";
import { t } from "../../i18n/t";

export function TagEditor({
  tag_names,
  setTags,
  isGlow,
}: {
  tag_names: string[];
  setTags: (names: string[]) => Promise<void>;
  /** When AI is writing tags, each chip glows individually (not the strip). */
  isGlow?: "active" | "fading" | false;
}) {
  const notesByFolder = useNotesStore((s) => s.notesByFolder);

  const [addingTag, setAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [suggestIndex, setSuggestIndex] = useState(-1);
  // 버그 #4: 추천 드롭다운을 document.body 포털 + position:fixed로 그리기 위한 입력 refs.
  const tagInputRef = useRef<HTMLInputElement>(null);
  const [emojiList, setEmojiList] = useState<EmojiEntry[]>([]);

  useEffect(() => {
    if (!addingTag) return;
    let active = true;
    void import("../../lib/emoji/emojiManifest").then((m) => {
      if (active) setEmojiList(m.EMOJI);
    });
    return () => {
      active = false;
    };
  }, [addingTag]);

  const [, setEmojiTick] = useState(0);
  useEffect(() => {
    return subscribeEmojiRender(() => setEmojiTick((t) => t + 1));
  }, []);

  // Scale Phase 1: tag_counts IPC 우선(로드 시 1회), 실패 시 notesByFolder 클라 평탄화 폴백.
  const serverTagCounts = useNotesStore((s) => s.tagCounts);
  const tagColors = useNotesStore((s) => s.tagColors);
  const allTags = useMemo(
    () => resolveAllTags(serverTagCounts, notesByFolder),
    [serverTagCounts, notesByFolder],
  );

  const tagSuggestions = useMemo(() => {
    if (!addingTag) return [];
    const existing = new Set(tag_names);
    const q = tagDraft.trim().toLowerCase();
    let candidates = allTags.filter((tg) => !existing.has(tg));
    if (q) candidates = candidates.filter((tg) => tg.toLowerCase().includes(q));
    return candidates.slice(0, 6);
  }, [addingTag, tag_names, allTags, tagDraft]);

  const emojiMatches = useMemo(() => {
    if (!addingTag || !tagDraft.trim() || emojiList.length === 0) return [];
    const q = tagDraft.trim().toLowerCase();
    return emojiList.filter((e) => e.c.toLowerCase().includes(q)).slice(0, 8);
  }, [addingTag, tagDraft, emojiList]);

  const commitTag = () => {
    const name = tagDraft.trim().replace(/^#/, "");
    if (name && !tag_names.includes(name)) {
      void setTags([...tag_names, name]);
    }
    setTagDraft("");
    setAddingTag(false);
    setSuggestIndex(-1);
  };

  const selectSuggestion = (name: string) => {
    if (!tag_names.includes(name)) {
      void setTags([...tag_names, name]);
    }
    setTagDraft("");
    setAddingTag(false);
    setSuggestIndex(-1);
  };

  // Tier 1 undo-on-delete: for an already-materialized note, hide the tag locally NOW and delay
  // the real note_set_tags call ~5s (see src/lib/undo.ts) instead of persisting immediately —
  // "Undo" cancels the pending call outright and restores the snapshot, so the backend is never
  // touched. A draft (unmaterialized) note has nothing persisted to undo yet, so it keeps the
  // original immediate path (setTags already handles ensureMaterialized for drafts).
  const removeTag = (name: string) => {
    if (useNotesStore.getState().activeDraft) {
      void setTags(tag_names.filter((tg) => tg !== name));
      return;
    }
    const noteId = useNotesStore.getState().activeNote?.note.id;
    if (!noteId) return;
    const snapshot = tag_names;
    const next = snapshot.filter((tg) => tg !== name);
    useNotesStore.setState((s) =>
      s.activeNote ? { activeNote: { ...s.activeNote, note: { ...s.activeNote.note, tag_names: next } } } : s,
    );
    scheduleUndoableDelete({
      commit: async () => {
        await call("note_set_tags", { id: noteId, tag_names: next });
        useNotesStore.getState().patchNoteSummary(noteId, { tag_names: next });
        void useNotesStore.getState().refreshTagCounts();
      },
      onRestore: () => {
        useNotesStore.setState((s) =>
          s.activeNote && s.activeNote.note.id === noteId
            ? { activeNote: { ...s.activeNote, note: { ...s.activeNote.note, tag_names: snapshot } } }
            : s,
        );
      },
      label: t("undo.deleted_named", { name }),
    });
  };

  const onTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      if (tagSuggestions.length === 0) return;
      e.preventDefault();
      setSuggestIndex((i) => (i + 1) % tagSuggestions.length);
      return;
    }
    if (e.key === "ArrowUp") {
      if (tagSuggestions.length === 0) return;
      e.preventDefault();
      setSuggestIndex((i) => (i <= 0 ? tagSuggestions.length - 1 : i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (suggestIndex >= 0 && tagSuggestions[suggestIndex]) {
        selectSuggestion(tagSuggestions[suggestIndex]);
      } else {
        commitTag();
      }
      return;
    }
    if (e.key === "Escape") {
      setAddingTag(false);
      setTagDraft("");
      setSuggestIndex(-1);
    }
  };

  const [inputAnchor, setInputAnchor] = useState<{ x: number; y: number } | null>(null);
  const { ref: suggestRef, x: dropdownX, y: dropdownY } = useMenuPos(inputAnchor);
  const hover = useFluidHover(suggestRef, { axis: "y" });
  useLayoutEffect(() => {
    if (!addingTag) {
      setInputAnchor(null);
      return;
    }
    const update = () => {
      const el = tagInputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setInputAnchor({ x: r.left, y: r.bottom + 4 });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [addingTag, tagDraft]);

  return (
    <>
      {/* 태그 목록 — 이 행 전체가 가로 스크롤되므로 개별 wrap 없이 한 줄로 이어진다. */}
      {tag_names.map((tg, tagIndex) => {
        const key = bundledKeyFor(tg);
        const hue = tagColors?.[tg];
        const colorStyle: React.CSSProperties =
          hue !== undefined && hue !== null
            ? {
                color: folderColorCss(hue),
                borderColor: `color-mix(in srgb, ${folderColorCss(hue)} 40%, var(--divider))`,
                background: `color-mix(in srgb, ${folderColorCss(hue)} 10%, transparent)`,
              }
            : {};
        return (
          <span
            key={tg}
            className="tag tag-accent tb-tag"
            data-testid="titlebar-tag-chip"
            data-ai-glow={isGlow || undefined}
            data-ai-glow-inset="true"
            style={{
              cursor: "default",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              flex: "none",
              height: "var(--tb-chip-h)",
              boxSizing: "border-box",
              fontSize: "var(--text-xs)",
              padding: "var(--tb-chip-pt) var(--space-4) 0",
              // Subtle per-chip phase offset so the cycle travels along the row.
              // String form — React would append "px" to a number custom property.
              ["--ai-glow-stagger" as string]: String(tagIndex),
              ...colorStyle,
            }}
          >
            {key && (emojiAvailable(key) || emojiSrc(key) !== "") ? (
              <img
                className="em-img"
                src={emojiSrc(key)}
                alt={tg}
                style={{ width: "1.1em", height: "1.1em", verticalAlign: "middle" }}
              />
            ) : (
              `#${tg}`
            )}
            {/* X 버튼은 tokens.css .tb-tag-x 규칙에 의해 absolute 오버레이로 떠 있고, hover/focus 시 우상단 코너에 노출된다. */}
            <button
              type="button"
              className="tb-tag-x"
              aria-label={t("note.remove_tag", { tag: tg })}
              onClick={(e) => {
                e.stopPropagation();
                removeTag(tg);
              }}
              style={{
                width: 14,
                height: 14,
                flex: "none",
                border: "none",
                borderRadius: "50%",
                background: "var(--accent)",
                color: "var(--on-accent)",
                display: "grid",
                placeItems: "center",
                padding: 0,
                cursor: "pointer",
              }}
            >
              <IconClose size={8} strokeWidth={2.6} />
            </button>
          </span>
        );
      })}
      {addingTag ? (
        <div style={{ position: "relative", flex: "none" }}>
          <input
            ref={tagInputRef}
            autoFocus
            value={tagDraft}
            onChange={(e) => {
              setTagDraft(e.target.value);
              setSuggestIndex(-1);
            }}
            onBlur={commitTag}
            onKeyDown={onTagKeyDown}
            role="combobox"
            aria-expanded={tagSuggestions.length > 0 || emojiMatches.length > 0}
            aria-autocomplete="list"
            aria-controls="tag-suggest-list"
            style={{
              width: 100,
              height: "var(--tb-chip-h)",
              boxSizing: "border-box",
              background: "transparent",
              border: "1px solid var(--accent)",
              borderRadius: "var(--radius-sm)",
              color: "var(--text)",
              fontSize: "var(--text-xs)",
              padding: "0 var(--space-3)",
              outline: "none",
            }}
          />
          {/* 버그 #4: Row 2의 overflowY:hidden 클립을 벗어나도록 document.body 포털 +
              position:fixed(입력의 getBoundingClientRect() 기준 좌표)로 렌더한다. */}
          {(tagSuggestions.length > 0 || emojiMatches.length > 0) &&
            inputAnchor &&
            createPortal(
              <div
                ref={suggestRef}
                id="tag-suggest-list"
                className="overlay fh-host"
                role="listbox"
                aria-label={t("note.tag_suggestions")}
                onMouseDown={(e) => e.preventDefault()}
                {...hover.handlers}
                style={{
                  position: "fixed",
                  top: dropdownY,
                  left: dropdownX,
                  zIndex: "var(--z-dropdown)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 0,
                  padding: "var(--space-1)",
                  minWidth: 140,
                  maxWidth: 240,
                  maxHeight: 260,
                  overflowY: "auto",
                  boxShadow: "var(--shadow-lg)",
                }}
              >
                <FluidHoverHighlight hover={hover} />
                {tagSuggestions.map((tg, i) => (
                  <button
                    key={tg}
                    type="button"
                    className="menu-row menu-item"
                    role="option"
                    aria-selected={i === suggestIndex}
                    data-selected={i === suggestIndex}
                    onClick={() => selectSuggestion(tg)}
                    style={{
                      padding: "var(--space-2) var(--space-4)",
                      whiteSpace: "normal",
                      wordBreak: "break-word",
                    }}
                  >
                    #{tg}
                  </button>
                ))}
                {emojiMatches.length > 0 && (
                  <>
                    {tagSuggestions.length > 0 && (
                      <div className="menu-sep" />
                    )}
                    <div
                      style={{
                        padding: "var(--space-2xs) 8px",
                        fontSize: "var(--text-label)",
                        fontWeight: 600,
                        color: "var(--muted)",
                        textTransform: "uppercase",
                      }}
                    >
                      Emoji
                    </div>
                    {emojiMatches.map((em) => {
                      const key = bundledKeyFor(em.g);
                      return (
                        <button
                          key={em.u}
                          type="button"
                          className="menu-row menu-item"
                          role="option"
                          onClick={() => selectSuggestion(em.g)}
                          style={{
                            padding: "var(--space-2) var(--space-4)",
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          {key && (emojiAvailable(key) || emojiSrc(key) !== "") ? (
                            <img
                              className="em-img"
                              src={emojiSrc(key)}
                              alt={em.g}
                              style={{ width: "1.2em", height: "1.2em", flex: "none" }}
                            />
                          ) : (
                            <span style={{ fontSize: "15px", lineHeight: 1 }}>{em.g}</span>
                          )}
                          <span
                            style={{
                              fontSize: "var(--text-xs)",
                              color: "var(--text)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {em.c}
                          </span>
                        </button>
                      );
                    })}
                  </>
                )}
              </div>,
              document.body,
            )}
        </div>
      ) : (
        <button
          type="button"
          className="tag-btn tb-quiet-chip"
          data-empty="true"
          onClick={() => setAddingTag(true)}
          style={{
            flex: "none",
            boxSizing: "border-box",
            height: "var(--tb-chip-h)",
            padding: "var(--tb-chip-pt) var(--space-4) 0",
            fontFamily: "var(--font-body)",
            fontSize: "var(--text-xs)",
            fontWeight: 400,
          }}
        >
          <IconPlus size={12} strokeWidth={2.2} />
          {t("note.add_tag")}
        </button>
      )}
    </>
  );
}
