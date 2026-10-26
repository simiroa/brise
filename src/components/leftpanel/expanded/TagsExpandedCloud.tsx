import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { List, type ListImperativeAPI, type RowComponentProps } from "react-window";
import { useNotesStore } from "../../../stores/notes";
import { useSearchStore } from "../../../stores/search";
import { folderColorCss } from "../../../lib/ui";
import { setTagColor } from "../../../lib/noteActions";
import { TagColorDialog } from "../../ContextMenuDialogs";
import { t } from "../../../i18n/t";
import { chipStyle, addChipStyle, draftInputStyle } from "../yearfilter/shared";
import { IconPlus } from "../../icons";
import {
  ADD_TAG_KEY,
  TAG_CLOUD_ROW_HEIGHT,
  packTagsIntoRows,
} from "./tagsCloudLayout";
import { useElementSize } from "../../../lib/useElementSize";

export interface TagsExpandedCloudProps {
  tags: string[];
  tagCounts: Map<string, number>;
  maxLines?: number;
}

interface CloudRowProps {
  rows: string[][];
  selectedTags: string[];
  tagCounts: Map<string, number>;
  tagColors: Record<string, number> | null | undefined;
  adding: boolean;
  draft: string;
  onDraftChange: (val: string) => void;
  onCommitAdd: () => void;
  onCancelAdd: () => void;
  onStartAdd: () => void;
  onToggle: (name: string, additive: boolean) => void;
  onColorPick: (name: string) => void;
  hasMovedRef: React.RefObject<boolean>;
  displayTagsCount: number;
}

function CloudChipRow({
  index,
  style,
  rows,
  selectedTags,
  tagCounts,
  tagColors,
  adding,
  draft,
  onDraftChange,
  onCommitAdd,
  onCancelAdd,
  onStartAdd,
  onToggle,
  onColorPick,
  hasMovedRef,
  displayTagsCount,
}: RowComponentProps<CloudRowProps>): React.ReactElement | null {
  const row = rows[index];
  if (!row) return null;

  return (
    <div
      style={{
        ...style,
        display: "flex",
        flexWrap: "nowrap",
        gap: "var(--space-1)",
        alignItems: "center",
        paddingRight: "var(--space-2xs)",
        boxSizing: "border-box",
      }}
    >
      {row.map((tg) => {
        if (tg === ADD_TAG_KEY) {
          if (adding) {
            return (
              <input
                key="__add_input__"
                data-testid="tag-add-input"
                autoFocus
                value={draft}
                onChange={(e) => onDraftChange(e.target.value)}
                onBlur={onCommitAdd}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onCommitAdd();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    onCancelAdd();
                  }
                }}
                placeholder={t("search.tag_add_placeholder")}
                style={{ ...draftInputStyle, width: 110, flex: "0 0 auto" }}
              />
            );
          }
          return (
            <span key="__add_wrapper__" style={{ display: "inline-flex", alignItems: "center", flex: "0 0 auto" }}>
              {displayTagsCount === 0 && (
                <span
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--faint)",
                    marginRight: "var(--space-1)",
                  }}
                >
                  {t("search.tags_none")}
                </span>
              )}
              <button
                type="button"
                data-testid="tag-add-button"
                onClick={() => {
                  if (hasMovedRef.current) return;
                  onStartAdd();
                }}
                title={t("search.tag_add")}
                aria-label={t("search.tag_add")}
                style={addChipStyle}
              >
                <IconPlus size={11} strokeWidth={2.2} />
              </button>
            </span>
          );
        }

        const active = selectedTags.includes(tg);
        const hue = tagColors?.[tg];
        const baseStyle = chipStyle(active);
        const tagColor = hue !== undefined && hue !== null ? folderColorCss(hue) : null;
        // Content-sized: packTagsIntoRows already decided how many fit this row, so a
        // short tag must not reserve a full column.
        //
        // Shrink (`0 1 auto`), not `0 0 auto`: the row is nowrap, and packing runs on
        // an estimated chip width against the *outer* measured width — the List's
        // scrollbar and this row's own paddingRight take ~11px the packer never saw.
        // Shrink lets an over-packed row ellipsise instead of overflowing, and absorbs
        // every source of estimation error rather than one tuned constant.
        const third: React.CSSProperties = {
          flex: "0 1 auto",
          maxWidth: "100%",
          minWidth: 0,
          overflow: "hidden",
          boxSizing: "border-box",
        };
        const finalStyle: React.CSSProperties = tagColor
          ? {
              ...baseStyle,
              ...third,
              color: active ? "var(--accent)" : tagColor,
              borderColor: active
                ? "var(--accent)"
                : `color-mix(in srgb, ${tagColor} 40%, var(--divider))`,
              background: active
                ? "color-mix(in srgb,var(--accent) 12%,transparent)"
                : `color-mix(in srgb, ${tagColor} 8%, transparent)`,
            }
          : { ...baseStyle, ...third };

        return (
          <button
            type="button"
            key={tg}
            data-tag-chip={tg}
            // Ctrl/Cmd is the platform's add-to-selection modifier; Shift is accepted too
            // because it is the one people reach for first and costs nothing to honour.
            onClick={(e) => {
              if (hasMovedRef.current) return;
              onToggle(tg, e.ctrlKey || e.metaKey || e.shiftKey);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              onColorPick(tg);
            }}
            style={finalStyle}
          >
            {active && (
              <span
                aria-hidden="true"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--accent)",
                  marginRight: "var(--space-1)",
                  flexShrink: 0,
                }}
              />
            )}
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
            >
              {tg}
            </span>
            <span style={{ opacity: 0.7, marginLeft: "var(--space-1)", flexShrink: 0 }}>
              {tagCounts.get(tg) ?? 0}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Virtualised tag cloud — packs chips into rows, then only mounts the
 * viewport slice. Supports drag-to-pan, maxLines capping, and inline tag addition.
 */
export function TagsExpandedCloud({ tags, tagCounts, maxLines }: TagsExpandedCloudProps) {
  const tagColors = useNotesStore((s) => s.tagColors);
  const selectedTags = useSearchStore((s) => s.selectedTags);
  const selectTag = useSearchStore((s) => s.selectTag);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [colorPickerTag, setColorPickerTag] = useState<string | null>(null);

  const displayTags = useMemo(() => {
    const set = new Set(tags);
    const result = [...tags];
    for (const st of selectedTags) {
      if (!set.has(st)) {
        set.add(st);
        result.push(st);
      }
    }
    return result;
  }, [tags, selectedTags]);

  const itemsToPack = useMemo(() => [...displayTags, ADD_TAG_KEY], [displayTags]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const { height: listHeight, width: listWidth } = useElementSize(wrapRef, {
    height: maxLines === 2 ? 56 : 120,
    width: 160,
  });

  const rows = useMemo(
    () => packTagsIntoRows(itemsToPack, tagCounts, listWidth, 4, adding),
    [itemsToPack, tagCounts, listWidth, adding],
  );

  const cancelAdd = useCallback(() => {
    setAdding(false);
    setDraft("");
  }, []);

  const commitAdd = useCallback(() => {
    const name = draft.trim();
    cancelAdd();
    if (name) {
      const current = useSearchStore.getState().selectedTags;
      if (!current.includes(name)) {
        selectTag(name, true);
      }
    }
  }, [draft, cancelAdd, selectTag]);

  const onToggle = useCallback(
    (name: string, additive: boolean) => selectTag(name, additive),
    [selectTag],
  );
  const onColorPick = useCallback((name: string) => setColorPickerTag(name), []);

  const handleColorSubmit = async (hue: number | null) => {
    if (!colorPickerTag) return;
    const tagToUpdate = colorPickerTag;
    setColorPickerTag(null);
    await setTagColor(tagToUpdate, hue);
  };

  const listRef = useRef<ListImperativeAPI | null>(null);
  const dragStartRef = useRef<{ clientY: number; scrollTop: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const hasMovedRef = useRef(false);

  useEffect(() => {
    const onMove = (e: globalThis.MouseEvent) => {
      const start = dragStartRef.current;
      const el = listRef.current?.element;
      if (!start || !el) return;
      const dy = e.clientY - start.clientY;
      if (Math.abs(dy) > 3) hasMovedRef.current = true;
      el.scrollTop = start.scrollTop - dy;
    };
    const onUp = () => {
      dragStartRef.current = null;
      setIsPanning(false);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, []);

  const handlePanMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const el = listRef.current?.element;
    if (!el) return;
    hasMovedRef.current = false;
    dragStartRef.current = { clientY: e.clientY, scrollTop: el.scrollTop };
    setIsPanning(true);
  }, []);

  const rowProps: CloudRowProps = useMemo(
    () => ({
      rows,
      selectedTags,
      tagCounts,
      tagColors,
      adding,
      draft,
      onDraftChange: setDraft,
      onCommitAdd: commitAdd,
      onCancelAdd: cancelAdd,
      onStartAdd: () => setAdding(true),
      onToggle,
      onColorPick,
      hasMovedRef,
      displayTagsCount: displayTags.length,
    }),
    [
      rows,
      selectedTags,
      tagCounts,
      tagColors,
      adding,
      draft,
      commitAdd,
      cancelAdd,
      onToggle,
      onColorPick,
      displayTags.length,
    ],
  );

  const rowHeight = useMemo(() => {
    if (maxLines === 2 && rows.length >= 2) {
      return Math.max(1, listHeight / 2);
    }
    if (maxLines === 2 && rows.length === 1) {
      return Math.max(1, listHeight);
    }
    return TAG_CLOUD_ROW_HEIGHT;
  }, [maxLines, rows.length, listHeight]);

  return (
    <div
      ref={wrapRef}
      data-testid="tags-cloud-wrap"
      onMouseDown={handlePanMouseDown}
      style={{
        position: "relative",
        width: "100%",
        cursor: isPanning ? "grabbing" : "grab",
        ...(maxLines === 2
          ? {
              maxHeight: "calc((var(--text-xs) * 1.3 + var(--space-1) * 2 + 2px) * 2 + var(--space-1))",
              height:
                rows.length <= 1
                  ? "calc(var(--text-xs) * 1.3 + var(--space-1) * 2 + 2px)"
                  : "calc((var(--text-xs) * 1.3 + var(--space-1) * 2 + 2px) * 2 + var(--space-1))",
            }
          : {
              flex: 1,
              minHeight: 0,
            }),
      }}
    >
      <List
        listRef={listRef}
        className="tag-strip-pan"
        rowComponent={CloudChipRow}
        rowCount={rows.length}
        rowHeight={rowHeight}
        rowProps={rowProps}
        overscanCount={2}
        style={{
          height: listHeight,
          width: "100%",
          scrollbarWidth: "none",
          msOverflowStyle: "none",
        }}
      />
      {colorPickerTag && (
        <TagColorDialog
          initialHue={tagColors?.[colorPickerTag] ?? null}
          onCancel={() => setColorPickerTag(null)}
          onSubmit={handleColorSubmit}
        />
      )}
    </div>
  );
}
