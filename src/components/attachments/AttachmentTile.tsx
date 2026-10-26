import React from "react";
import { IconClose } from "../icons";

// Task 1: related-note/attachment/source tiles shrunk from 64x64 -> 48x48.
export const TILE = 48;

/** Task 2 (hover enlarge): prefers-reduced-motion is handled entirely by tokens.css's `.hovprev`
 * rule (base opacity/transform toggle + a `@media (prefers-reduced-motion: reduce)` override on
 * the same selector) — no JS media-query listener or prop drilling needed here. */
function HoverFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      // floating 미리보기(SINGLE-SHEET ACRYLIC CONTRACT) — 배경은 .overlay 소유: flat=불투명,
      // acrylic=시트 톤(최소 알파 0.92)+블러.
      className="hovprev overlay"
      aria-hidden="true"
      style={{
        position: "absolute",
        top: "calc(-1 * var(--space-5))",
        left: "calc(-1 * var(--space-5))",
        width: `calc(${TILE}px + var(--space-5) * 2)`,
        height: `calc(${TILE}px + var(--space-5) * 2)`,
        zIndex: "var(--z-tooltip)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        border: "1px solid var(--accent)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-lg)",
      }}
    >
      {children}
    </div>
  );
}

export interface TileLabelProps {
  /** Pre-sized icon element — callers pass e.g. `<IconPin size={16} strokeWidth={1.8} />`
   * (content, 16px) or `size={22} strokeWidth={1.6}` (hover-enlarge, 22px). */
  icon: React.ReactNode;
  text: string;
  /** true for the 22px hover-enlarge variant (roomier gap/padding, clips overflow);
   * false/omitted for the 16px in-tile content variant. */
  hover?: boolean;
  /** Ext-style labels (SOURCE/ATTACHMENT file extension) render upper-cased. */
  uppercase?: boolean;
}

/** Canonical icon-over-ellipsized-label block shared by every tile-content and
 * hover-enlarge block in the attachments bar (source/attachment/sheet/footnotes/region tiles).
 * Picks the Sheet/FootnotesTileItem content styling (gap 4, `padding: "0 var(--space-2xs)"`, `maxWidth: 100%`
 * on the wrapper) as canonical — it was the majority shape before this extraction; Source/Region/
 * AttachmentTileItem had each dropped or relocated one of those three props. */
export function TileLabel({ icon, text, hover, uppercase }: TileLabelProps) {
  return (
    <div
      style={
        hover
          ? {
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "var(--space-2)",
              padding: "var(--space-3)",
              maxWidth: "100%",
              overflow: "hidden",
            }
          : { display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--space-2xs)", padding: "0 var(--space-2xs)", maxWidth: "100%" }
      }
    >
      {icon}
      <span
        style={{
          fontSize: "var(--text-2xs)",
          lineHeight: 1,
          fontWeight: 600,
          color: "var(--muted)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: "100%",
          ...(uppercase ? { textTransform: "uppercase" as const } : {}),
        }}
      >
        {text}
      </span>
    </div>
  );
}

export interface AttachmentTileProps {
  /** Tooltip shown on hover (native `title`). */
  title: string;
  /** Accessible name — only the "Notes liées" tiles set this (they're keyboard-operable). */
  ariaLabel?: string;
  role?: string;
  tabIndex?: number;
  /** W7-g: 이벤트를 그대로 넘긴다 — 첨부 다중선택이 Ctrl/Cmd/Shift 를 읽어야 한다. */
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  /** 이미지 타일 → 에디터 드래그 시작점(attachmentImageDrag.ts). 임계값 미달이면 아무 일도
   * 안 하므로 일반 클릭(onClick)과 공존한다 — 이미지 타일에만 넘겨진다. */
  onPointerDown?: (e: React.PointerEvent) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  /** "섹션으로 가져오기" 승격 메뉴 — 사료 타일은 항상, 첨부 타일은 승격 가능한 것만 넘긴다
   * (AttachmentsTilesStrip.tsx::canPromoteAttachment). 생략하면 브라우저 기본 컨텍스트 메뉴. */
  onContextMenu?: (e: React.MouseEvent) => void;
  /** Tile-body tint (icon color when no thumbnail is shown). */
  color: string;
  opacity?: number;
  /** Background of the content-clip layer. **Omit it** for ordinary tiles — in-flow surfaces own
   * only their hairline, never a fill (SINGLE-SHEET 계약 "in-flow: no background at all"). The one
   * caller that still passes a value is the image tile, whose `--img-ph-*` gradient is not a
   * surface but the placeholder standing in for a thumbnail that has not decoded yet. Until
   * 2026-09-12 five callers passed `"var(--surface)"` here, which routed around the contract's
   * inline-background ban (`check-surface-contract.mjs` ④ only sees literal `background:
   * "var(--surface)"`, not a prop) and painted a patch brighter than the tinted body behind it. */
  contentBackground?: string;
  /** Small icon/label content shown inside the 48x48 clipped box. */
  content: React.ReactNode;
  /** Larger content shown in the hover-enlarge frame. */
  hoverContent: React.ReactNode;
  /** Small pinned-link dot — only "Notes liées" manual tiles show this. */
  marker?: boolean;
  /** Smart connection suggestion badge/action (e.g. 💡 button for pending overlap suggestions). */
  smartBadge?: React.ReactNode;
  /** Owner spec (6차 QA): true when this tile's item is the one currently shown in the
   * preview panel — drives the `data-active` border highlight (tokens.css) and, when set,
   * exposes `aria-pressed` so assistive tech gets the same on/off signal as the visual one. */
  active?: boolean;
  /** W7-g 다중선택됨 — `active`(프리뷰에 떠 있음)와는 다른 축이라 표시도 따로 준다. */
  selected?: boolean;
  /** Omit to render the tile with no delete affordance (e.g. auto-suggested related notes). */
  onDelete?: (e: React.MouseEvent) => void;
  deleteLabel?: string;
  /** Only the "Notes liées" delete button stops propagation on keydown (it sits inside a
   * keyboard-operable tile with its own Enter/Space handling). */
  deleteStopsKeyDownPropagation?: boolean;
}

/** Shared skeleton for the three attachment-bar tile kinds (source / attachment / related-note):
 * a content-clip layer (48x48, clipped), a hover-enlarge preview frame, and — outside the clipped
 * box — an optional delete-x button. Preserves the hard-won details from the original three
 * blocks: the delete-x lives OUTSIDE the clipped box at `zIndex: calc(var(--z-tooltip) + 1)`,
 * opacity is owned by the CSS `.attach-x` rule (never set inline here), the outer tile is
 * `overflow: visible` with only the inner content layer clipped, and the delete control stays a
 * real `<button>` so it's keyboard-reachable regardless of the tile's own tabIndex. */
export function AttachmentTile({
  title,
  ariaLabel,
  role,
  tabIndex,
  onClick,
  onDoubleClick,
  onKeyDown,
  onPointerDown,
  onContextMenu,
  color,
  opacity,
  contentBackground,
  content,
  hoverContent,
  marker,
  smartBadge,
  onDelete,
  deleteLabel,
  deleteStopsKeyDownPropagation,
  active,
  selected,
}: AttachmentTileProps) {
  return (
    <div
      className="attach"
      role={role}
      tabIndex={tabIndex}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      aria-label={ariaLabel}
      aria-pressed={active !== undefined ? active : undefined}
      aria-selected={selected || undefined}
      data-active={active ? "true" : undefined}
      data-multi-selected={selected ? "true" : undefined}
      title={title}
      style={{
        position: "relative",
        width: TILE,
        height: TILE,
        color,
        ...(opacity !== undefined ? { opacity } : {}),
        // 다중선택 표시는 outline — data-active 의 border 와 겹쳐 보인다(테두리는 상자 가장자리,
        // 링은 그 안쪽이라 둘 다 남는다). offset 이 **음수**인 이유(오너 결정 2026-09-10): 밖으로
        // 나간 링은 타일 스트립의 스크롤러(AttachmentsTilesStrip 의 overflowX:auto, 좌우 패딩 0)
        // 경계에서 잘렸다 — 첫 타일의 왼쪽과 모든 타일의 위아래가. 안쪽 링은 구조적으로 안 잘린다.
        ...(selected ? { outline: "2px solid var(--accent)", outlineOffset: -2 } : {}),
      }}
    >
      {/* Content clip layer: overflow:hidden must live here, not on the tile itself — the delete
          X and HoverFrame below are absolutely positioned *outside* the 48x48 box on purpose, and
          a tile-level overflow:hidden would clip them too (it's the same containing block, so
          there's no CSS way to exempt them). */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: contentBackground,
          overflow: "hidden",
          borderRadius: "inherit",
        }}
      >
        {content}
      </div>
      <HoverFrame>{hoverContent}</HoverFrame>
      {/* subtle marker: manual links (removable, pinned by the user) get a small dot — auto
          suggestions (not removable) stay undotted. */}
      {marker && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 4,
            left: 4,
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--accent)",
          }}
        />
      )}
      {smartBadge && (
        <div
          style={{
            position: "absolute",
            top: -6,
            left: -6,
            zIndex: "calc(var(--z-tooltip) + 1)",
          }}
        >
          {smartBadge}
        </div>
      )}
      {onDelete && (
        <button
          type="button"
          className="attach-x"
          onClick={onDelete}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={deleteStopsKeyDownPropagation ? (e) => e.stopPropagation() : undefined}
          aria-label={deleteLabel}
          title={deleteLabel}
          style={{
            position: "absolute",
            top: 2,
            right: 2,
            zIndex: "calc(var(--z-tooltip) + 1)",
            width: 16,
            height: 16,
            border: "none",
            padding: 0,
            borderRadius: "50%",
            background: "var(--accent)",
            color: "var(--on-accent)",
            boxShadow: "0 1px 3px rgba(0, 0, 0, 0.35)",
            display: "grid",
            placeItems: "center",
            cursor: "pointer",
          }}
        >
          <IconClose size={10} strokeWidth={2.4} />
        </button>
      )}
    </div>
  );
}
