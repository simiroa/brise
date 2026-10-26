import React from "react";
import { type RowComponentProps } from "react-window";
import { folderColorCss } from "../../../lib/ui";
import { noteIconComp } from "../../../lib/noteIcons";
import type { Folder } from "../../../lib/commands.gen";
import {
  IconFolder,
  IconFolderOpen,
  IconPlus,
  IconStar,
  IconCaret,
  IconTrash,
  // W7-f: no dedicated "archive" glyph among the current lucide re-exports (icons.tsx is a
  // shared file, out of scope this wave) — IconBook stands in (already used for the note-icon
  // palette, unused elsewhere as UI chrome).
  IconBook,
  IconLock,
  IconCheckMark,
} from "../../icons";
import { t } from "../../../i18n/t";
import { NoteIconControl } from "../NoteIconControl";
import type { TreeRow } from "./rows";
import { TreeHeaderRow } from "./TreeHeaderRow";
import { TreeRowBadges } from "./TreeRowBadges";
import { TreeRowInlineEditor } from "./TreeRowInlineEditor";

import { HighlightedText, splitByQuery, splitSnippet } from "./highlight";

import { startNoteDrag, noteDropTargetProps } from "../../../lib/noteDrag";
import { DRAG_THRESHOLD_PX } from "../../../lib/pointerContract";
import { useAiGlow, AI_GLOW_KEYS } from "../../../stores/ai";
import { displayTitle } from "../../../stores/notes";
import { useUiStore } from "../../../stores/ui";
import { beginLongPress, cancelLongPress, consumeLongPress } from "../../../lib/longPress";
import "./treeRow.css";

/**
 * 폴더 행 길게 누르기 임계값 — treeRow.css 의 채움 애니메이션 길이와 같아야 한다.
 * 노트 아이콘 메뉴(lib/longPress 의 기본 400ms)보다 짧다: 아이콘은 행 안의 15px 글리프라
 * 오발동을 막을 여유가 필요하지만, 폴더 행은 이미 그것만 겨냥해 누르고 있는 큰 표적이다.
 */
const FOLDER_LONG_PRESS_MS = 300;

export type ListRowProps = {
  rows: TreeRow[];
  searchActive: boolean;
  favoritesOpen: boolean;
  favoriteCount: number;
  trashCount: number;
  // W7-f: 아카이브 행 카운트 — trashCount와 동일 패턴.
  archiveCount: number;
  activeId: string | null;
  /**
   * W7-g 다중선택된 노트 id 들. 이 컴포넌트는 훅을 쓸 수 없으므로(react-window 가 인스턴스를
   * 인덱스마다 재사용한다 — 파일 상단 주석 참고) 스토어를 구독하지 않고 Set 을 통째로 받아
   * `selectedIds.has(n.id)` 로 자기 행의 boolean 만 읽는다. rowProps 는 하나의 객체라 행마다
   * 다른 boolean 을 내려보낼 방법이 없다.
   */
  selectedIds: ReadonlySet<string>;
  /** Find-next cursor note id (independent of activeId / selectNote). */
  matchCursorNoteId: string | null;
  folderNameById: Map<string, string>;
  revealedNoteId?: string | null;
  // Inline rename (double-click / F2) — replaces the old context-menu "Rename" item. State is
  // lifted to notetree/index.tsx (not local to this row) because react-window recycles this
  // component instance across row indices as the user scrolls; local edit state would follow the
  // DOM slot, not the note/folder being edited. Only one row can be mid-edit at a time, so a
  // single id + draft pair is enough (works for both notes and folders since ids never collide).
  editingId: string | null;
  editingDraft: string;
  onEditingDraftChange: (value: string) => void;
  onStartEdit: (id: string, isFolder: boolean, initialValue: string) => void;
  onCommitEdit: (id: string, isFolder: boolean, draft: string) => void;
  onEditBlur: (id: string, isFolder: boolean, draft: string) => void;
  onCancelEdit: () => void;
  // Wave 2: inbox(미분류) 섹션 헤더. favorites 와 같은 패턴 — pinned open/close 토글과 카운트.
  inboxOpen: boolean;
  inboxCount: number;
  // Wave 2.2: 드래그 드롭 타깃 식별용 — inbox 헤더도 drop target 이라 folder id 만으론 부족.
  inboxId: string | null;
  searchQuery: string;
  onToggleFavorites: () => void;
  onToggleInbox: () => void;
  onToggleFolder: (f: Folder) => void;
  onOpenTrash: () => void;
  onOpenArchive: () => void;
  onOpenCtx: (id: string, x: number, y: number) => void;
  /**
   * 노트 행 클릭. 수식키를 그대로 실어 보낸다 — 다중선택 규칙(Ctrl/Cmd=토글, Shift=범위,
   * 수식키 없음=기존 단일선택+열기)의 판단은 전부 notetree/index.tsx 가 한다. 세 번째 인자는
   * react-window 가 이 컴포넌트에 내려주는 `index`(클릭된 행의 실제 위치) 그대로 — 즐겨찾기
   * 노트처럼 같은 id 가 두 곳에 그려질 때 Shift 범위가 그 위치로 어느 쪽을 구분한다.
   */
  onSelectNote: (id: string, mods: { toggle: boolean; range: boolean }, index: number) => void;
  // Wave 2: 폴더 row hover 시 등장하는 "+" 가 호출. target folder id 명시.
  onNewNoteInFolder: (folderId: string) => void;
  // Wave 2.2: 트리 안에서 노트를 다른 폴더로 드래그-드롭. (noteId, targetFolderId) →
  // 동일 폴더면 no-op, 아니면 note_update + loadTree (ContextMenu 의 move-to-folder 와
  // 정확히 같은 post-move 갱신 패턴). 호출은 메모 안정성을 위해 rowProps 경유.
  onMoveNote: (noteId: string, targetFolderId: string) => void;
  loadTree: () => Promise<void>;
  selectNote: (id: string) => Promise<void>;
};

/**
 * 검색/AI 제외는 폴더 설정 모달에서만 켜지고 트리에는 아무 흔적도 남지 않는 상태였다 — 몇 달 뒤
 * "왜 이 노트들이 검색에 안 걸리지"가 되는 조용한 오작동이라 행에서 보여야 한다.
 * 어느 제외가 걸렸든 자물쇠 글리프 하나로만 표시하고, 어느 쪽인지는 tooltip 이 말한다:
 * 12px 에서 돋보기(IconSearch)와 반짝이(IconAi)는 서로 구분되는 실루엣이 아니라 둘 다 "작은 점"
 * 으로만 읽히고, 두 개를 나란히 놓으면 좁은 사이드바 행에서 자리만 두 배로 먹는다.
 * 반환값 null = 표시할 것 없음(정상 폴더).
 */
function folderExclusionLabel(f: Folder): string | null {
  if (f.search_excluded && f.ai_excluded) return t("tree.folder_excluded_both");
  if (f.search_excluded) return t("tree.folder_excluded_search");
  if (f.ai_excluded) return t("tree.folder_excluded_ai");
  return null;
}

function TreeListRowImpl({
  index,
  style,
  rows,
  searchActive,
  favoritesOpen,
  favoriteCount,
  trashCount,
  archiveCount,
  activeId,
  selectedIds,
  matchCursorNoteId,
  folderNameById,
  revealedNoteId,
  editingId,
  editingDraft,
  onEditingDraftChange,
  onStartEdit,
  onCommitEdit,
  onEditBlur,
  onCancelEdit,
  inboxOpen,
  inboxCount,
  inboxId,
  searchQuery,
  onToggleFavorites,
  onToggleInbox,
  onToggleFolder,
  onOpenTrash,
  onOpenArchive,
  onOpenCtx,
  onSelectNote,
  onNewNoteInFolder,
  onMoveNote,
  loadTree,
  selectNote,
}: RowComponentProps<ListRowProps>): React.ReactElement | null {
  const row = rows[index];
  const noteId = row?.kind === "note" ? row.note.id : null;
  const folderId = row?.kind === "folder" ? row.folder.id : null;
  const isNoteGlow = useAiGlow(noteId ? AI_GLOW_KEYS.note(noteId) : null);
  const isFolderGlow = useAiGlow(folderId ? AI_GLOW_KEYS.folder(folderId) : null);
  // 폴더 행을 길게 누르면 폴더 설정 모달 — 우클릭 메뉴와 같은 곳으로 가는 두 번째 문이다.
  // 상태가 boolean 이 아니라 "지금 눌리고 있는 폴더 id" 인 이유: react-window 가 이 컴포넌트
  // 인스턴스를 인덱스마다 재사용하므로, 누른 채 목록이 스크롤돼 슬롯에 다른 폴더가 들어오면
  // boolean 은 남의 행에 그대로 남는다.
  // 타이머·발동 플래그는 lib/longPress.ts 한 벌을 쓴다(노트 아이콘 메뉴·모바일 다중선택과 같은
  // 제스처 엔진). 여기 남는 state 는 "채워지는 막대를 그릴 행"뿐이다.
  const [pressingId, setPressingId] = React.useState<string | null>(null);
  const endLongPress = () => {
    cancelLongPress();
    setPressingId(null);
  };

  if (!row) return null;

  // 드롭 대상은 DOM 속성으로만 표시한다 — 실제 처리는 notetree/index.tsx 가 한 번 등록한
  // 핸들러가 맡는다(행 컴포넌트는 react-window 가 재사용하므로 훅/구독을 두지 않는다).
  void onMoveNote;

  const wrap = (node: React.ReactNode) => (
    <div style={{ ...style, display: "flex", alignItems: "stretch" }}>{node}</div>
  );

  // Active note = left accent bar + data-selected (existing). Match cursor = full-ring inset
  // outline so both can sit on the same row without collapsing into one state.
  // W7-g: 다중선택은 세 번째 축 — 배경 틴트로만 표시한다(왼쪽 바 = 활성, 링 = 검색 커서와
  // 겹치지 않게). 활성/커서보다 진한 틴트라 셋이 동시에 걸려도 읽힌다.
  const noteRowStyle = (
    id: string,
    indented: boolean,
    isMatchCursor: boolean,
    multiSelected: boolean,
    isRevealed = false
  ): React.CSSProperties => {
    const shadows: string[] = [];
    if (id === activeId) shadows.push("inset 2px 0 0 var(--accent)");
    if (isMatchCursor) shadows.push("inset 0 0 0 1.5px var(--accent)");
    if (isRevealed) shadows.push("inset 0 0 0 2px var(--accent)");
    return {
      gap: "var(--space-3)",
      padding: indented
        ? "var(--space-2) var(--sidebar-pad) var(--space-2) 24px"
        : "var(--space-2) var(--sidebar-pad) var(--space-2) var(--space-3)",
      position: "relative",
      boxShadow: shadows.length > 0 ? shadows.join(", ") : undefined,
      background: isRevealed
        ? "color-mix(in srgb, var(--accent) 24%, transparent)"
        : multiSelected
          // W7-g: 체크마크 글리프(아래 렌더)가 이제 다중선택 신호를 지므로 배경 틴트는
          // 24%(공개)/10%(검색 커서)와 뭉개지지 않도록 18%→12%로 낮췄다.
          ? "color-mix(in srgb, var(--accent) 12%, transparent)"
          : isMatchCursor && id !== activeId
            ? "color-mix(in srgb, var(--accent) 10%, transparent)"
            : undefined,
      transition: "background var(--dur-slow) ease, box-shadow var(--dur-slow) ease",
      height: "100%",
      width: "100%",
    };
  };

  switch (row.kind) {
    case "note": {
      const n = row.note;
      const indented = row.indented;
      const isMatchCursor = matchCursorNoteId === n.id;
      const multiSelected = selectedIds.has(n.id);
      const isRevealed = revealedNoteId === n.id;

      // Inline rename: double-click (or F2 while focused) swaps the whole row for a plain div +
      // input — a <button> can't safely host a nested <input> (activation/focus quirks), so the
      // editing row drops the button/onClick/onPointerDown entirely. That alone satisfies "click
      // and drag must not fire while editing": there's simply no handler left to fire.
      if (editingId === n.id) {
        return wrap(
          <div
            className="treerow menu-row menu-item"
            data-selected={n.id === activeId}
            style={noteRowStyle(n.id, indented, isMatchCursor, false, isRevealed)}
          >
            <NoteIconControl
              noteId={n.id}
              icon={n.icon}
              size={indented ? 15 : 16}
              loadTree={loadTree}
              selectNote={selectNote}
              activeNoteId={activeId}
            />
            <TreeRowInlineEditor
              id={n.id}
              isFolder={false}
              draft={editingDraft}
              onDraftChange={onEditingDraftChange}
              onCommit={onCommitEdit}
              onBlur={onEditBlur}
              onCancel={onCancelEdit}
              fontSize="var(--text-md)"
              fontWeight={400}
            />
          </div>
        );
      }

      // 드래그는 포인터 이벤트 기반이다(lib/noteDrag.ts) — HTML5 DnD 는 tauri 창의
      // dragDropEnabled 기본값 때문에 웹뷰까지 이벤트가 오지 않아 못 쓴다. 그 이유는
      // noteDrag.ts 상단 주석 참고. 여기서는 startNoteDrag 만 걸고 드롭 대상은 속성으로 표시한다.
      return wrap(
        <button
          type="button"
          id={searchActive ? `search-match-${n.id}` : undefined}
          className="treerow menu-row menu-item"
          data-selected={n.id === activeId}
          data-multi-selected={multiSelected || undefined}
          aria-selected={multiSelected || undefined}
          data-match-cursor={isMatchCursor || undefined}
          data-revealed={isRevealed || undefined}
          data-ai-glow={isNoteGlow || undefined} /* "active" | "fading" */
          data-ai-glow-inset="true"
          // W3: 섹션 탭을 여기 놓으면 그 노트의 마지막 섹션으로 옮겨진다(section_move). 처리는
          // 에디터의 useSectionActions 가 등록한 드롭 핸들러 하나가 맡는다 — 섹션 드래그는
          // 에디터가 떠 있을 때만 시작되므로 트리는 대상 표시만 하면 된다. 노트 드래그는 이
          // 대상을 아예 못 보게 noteDrag.ts 의 findTargetAt 이 걸러낸다.
          {...noteDropTargetProps(`note:${n.id}`)}
          // Ctrl/Cmd/Shift 클릭은 다중선택 제스처다 — 드래그를 시작하지 않는다(누른 채 살짝
          // 움직이기만 해도 4px 임계값을 넘겨 고스트가 뜨고 노트가 엉뚱한 폴더로 떨어졌다).
          onPointerDown={(e) => {
            if (e.ctrlKey || e.metaKey || e.shiftKey) {
              // Shift 범위 선택이 사이드바 텍스트를 파랗게 긁어놓지 않도록 — 텍스트 선택은
              // pointerdown 에서 시작하므로 click 단계의 preventDefault 로는 늦다.
              e.preventDefault();
              return;
            }
            startNoteDrag(e, n.id, displayTitle(n.title));
            // W5: 터치엔 우클릭이 없다 — 롱프레스(400ms, lib/longPress 기본값)로 같은 컨텍스트
            // 메뉴를 연다. startNoteDrag 가 같은 pointerdown 에서 이미 4px 임계 대기를 걸어 두므로
            // (noteDrag.ts) 그 임계를 넘겨 드래그가 실제로 시작되면 이 타이머도 취소한다 — 같은
            // DRAG_THRESHOLD_PX 를 재사용(새 상수 금지). pointerup/leave/cancel 에서도 반드시
            // 취소해 평소 클릭(짧게 눌렀다 뗌)이 뒤늦게 메뉴를 열지 않게 한다.
            if (e.button !== 0) return;
            const startX = e.clientX;
            const startY = e.clientY;
            const onMove = (ev: PointerEvent) => {
              if (
                Math.abs(ev.clientX - startX) >= DRAG_THRESHOLD_PX ||
                Math.abs(ev.clientY - startY) >= DRAG_THRESHOLD_PX
              ) {
                stop();
              }
            };
            const stop = () => {
              cancelLongPress();
              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", stop);
              window.removeEventListener("pointercancel", stop);
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", stop);
            window.addEventListener("pointercancel", stop);
            beginLongPress(() => onOpenCtx(n.id, startX, startY));
          }}
          onPointerLeave={() => cancelLongPress()}
          onClick={(e) => {
            // 길게 눌러 메뉴가 떴으면 뒤따르는 click 은 삼킨다 — 안 그러면 메뉴가 열리면서
            // 노트도 같이 열린다(폴더 행의 같은 규약, 위 folder 분기 참고).
            if (consumeLongPress()) return;
            onSelectNote(n.id, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey }, index);
          }}
          onDoubleClick={() => onStartEdit(n.id, false, n.title)}
          onKeyDown={(e) => {
            if (e.key === "F2") {
              e.preventDefault();
              onStartEdit(n.id, false, n.title);
            }
          }}
          // ponytail: 다중선택 중 우클릭도 그 한 행의 단일 메뉴를 연다(선택 전체에 대한 메뉴가
          // 아니다). 일괄 액션은 하단 액션 바가 전담하므로 메뉴를 이중화하지 않는다 — 컨텍스트
          // 메뉴까지 선택 인지시키려면 ContextMenu 의 모든 항목이 N개용 분기를 갖게 된다.
          onContextMenu={(e) => {
            e.preventDefault();
            onOpenCtx(n.id, e.clientX, e.clientY);
          }}
          style={noteRowStyle(n.id, indented, isMatchCursor, multiSelected, isRevealed)}
        >
          {multiSelected ? (
            // W7-g: 다중선택은 아이콘 자리를 체크마크로 바꿔 배경 틴트와 다른 축으로 신호한다
            // (활성/커서/공개가 전부 배경-계열이라 겹치면 뭉개지던 문제). 상태는 행의
            // aria-selected 가 이미 실어 나르므로 여기 글리프는 장식일 뿐이다.
            <IconCheckMark
              data-testid="note-multiselect-check"
              size={indented ? 15 : 16}
              strokeWidth={1.8}
              aria-hidden
              style={{ color: "var(--accent)", flex: "none" }}
            />
          ) : (
            <NoteIconControl
              noteId={n.id}
              icon={n.icon}
              size={indented ? 15 : 16}
              loadTree={loadTree}
              selectNote={selectNote}
              activeNoteId={activeId}
            />
          )}
          {indented ? (
            <span
              style={{
                fontSize: "var(--text-md)",
                fontWeight: 400,
                flex: 1,
                minWidth: 0,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {displayTitle(n.title)}
            </span>
          ) : (
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: "var(--text-md)",
                  fontWeight: 400,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                <HighlightedText
                  segments={splitByQuery(displayTitle(n.title), searchQuery)}
                />
              </div>
              <div style={{ fontSize: "var(--text-label)", color: "var(--muted)" }}>
                {row.folderLabel ?? folderNameById.get(n.folder_id) ?? t("tree.notes_fallback")} ·{" "}
                {n.year}
              </div>
              {n.snippet && (
                <div
                  style={{
                    fontSize: "var(--text-label)",
                    color: "var(--muted)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  <HighlightedText segments={splitSnippet(n.snippet)} />
                </div>
              )}
            </div>
          )}
          <TreeRowBadges
            exportedAt={n.exported_at}
            isFavorite={n.is_favorite}
            status={n.status}
            hasImage={n.has_image}
            tagNames={n.tag_names}
          />
        </button>
      );
    }
    case "draft":
      // 아직 저장 전인 새 노트 자리표시 — 항상 활성 상태(에디터가 이미 열려 있다)라 선택
      // 표시만 하고 클릭/드래그/컨텍스트 메뉴는 붙이지 않는다. 첫 타이핑에 실제 노트 행으로
      // 교체된다.
      return wrap(
        <div
          className="treerow menu-row menu-item"
          data-selected
          style={{ ...noteRowStyle("", true, false, false), boxShadow: "inset 2px 0 0 var(--accent)" }}
        >
          <span
            style={{
              fontSize: "var(--text-md)",
              fontWeight: 400,
              flex: 1,
              minWidth: 0,
              marginLeft: 22,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              color: "var(--muted)",
              fontStyle: "italic",
            }}
          >
            {t("note.untitled_note")}
          </span>
        </div>
      );
    case "inbox_hdr": {
      // Wave 2: "미분류" pinned 헤더 — favorites_hdr 와 동일 모양이지만 폴더 아이콘 + chevron
      // 컨벤션으로 "정식 폴더가 아닌 헤더" 임을 시각화. 폴더 chrome 위 1행 자리(트리 최상단)
      // 라 일반 폴더 row 와 라인 높이를 똑같이 유지.
      // Wave 2.2: inbox 도 drop target — inboxId 가 아직 없으면(boot 직후 lazy 전) drop 자체를
      // 거부(inboxId 가 비어 있으면 컨테이너 핸들러가 무시한다). 시각적
      // 하이라이트는 folder row 와 동일 토큰 재사용.
      return wrap(
        <TreeHeaderRow
          icon={
            inboxOpen ? (
              <IconFolderOpen
                size={15}
                strokeWidth={1.8}
                style={{ color: "var(--accent)" }}
              />
            ) : (
              <IconFolder
                size={15}
                strokeWidth={1.8}
                style={{ color: "var(--accent)" }}
              />
            )
          }
          caret={inboxOpen ? "down" : "right"}
          label={t("tree.inbox")}
          count={inboxCount}
          onClick={() => {
            // W5: 폴더 행과 같은 규약 — 길게 눌러 메뉴가 떴으면 뒤따르는 click(펼침/접힘)을 삼킨다.
            if (consumeLongPress()) return;
            onToggleInbox();
          }}
          buttonProps={{
            // W7-d: 미분류 우클릭 → AI 진입점(ContextMenu.tsx의 isInbox 분기). 폴더 row와 동일하게
            // onOpenCtx 재사용 — inboxId 를 note/folder id 자리에 넘긴다(아직 hydrate 전이라
            // inboxId 가 없으면 그냥 무시).
            onContextMenu: (e) => {
              e.preventDefault();
              if (inboxId) onOpenCtx(inboxId, e.clientX, e.clientY);
            },
            // W5: 터치엔 우클릭이 없다 — 롱프레스(400ms 기본값)로 같은 컨텍스트 메뉴를 연다. 폴더
            // 행과 달리 드래그 소스가 아니므로(드롭 타깃일 뿐) 임계값 추적이 필요 없다 — 폴더 행의
            // endLongPress 와 같은 형태로 충분하다.
            onPointerDown: (e) => {
              if (e.button !== 0) return;
              const x = e.clientX;
              const y = e.clientY;
              beginLongPress(() => {
                if (inboxId) onOpenCtx(inboxId, x, y);
              });
            },
            onPointerUp: cancelLongPress,
            onPointerLeave: cancelLongPress,
            onPointerCancel: cancelLongPress,
            ...noteDropTargetProps(`folder:${inboxId ?? ""}`),
          }}
        />
      );
    }
    case "favorites_hdr":
      return wrap(
        <TreeHeaderRow
          icon={
            <IconStar
              size={15}
              strokeWidth={1.8}
              style={{
                color: "var(--accent)",
                fill: favoritesOpen ? "var(--accent)" : "none",
              }}
            />
          }
          caret={favoritesOpen ? "down" : "right"}
          label={t("tree.favorites")}
          count={favoriteCount}
          onClick={onToggleFavorites}
        />
      );
    case "trash":
      return wrap(
        <TreeHeaderRow
          icon={<IconTrash size={15} strokeWidth={1.8} style={{ color: "var(--faint)" }} />}
          label={t("trash.title")}
          count={trashCount}
          onClick={onOpenTrash}
        />
      );
    case "archive":
      return wrap(
        <TreeHeaderRow
          icon={<IconBook size={15} strokeWidth={1.8} style={{ color: "var(--faint)" }} />}
          label={t("archive.title")}
          count={archiveCount}
          onClick={onOpenArchive}
        />
      );
    case "divider":
      return (
        <div style={style}>
          <div
            style={{
              height: 1,
              background: "var(--divider)",
              margin: "var(--space-2) var(--sidebar-pad) var(--space-2) var(--space-3)",
            }}
          />
        </div>
      );
    case "folder": {
      const f = row.folder;
      if (editingId === f.id) {
        return wrap(
          <div
            className="menu-row menu-item"
            style={{
              gap: "var(--space-3)",
              padding: "var(--space-2) var(--sidebar-pad) var(--space-2) var(--space-3)",
              color: "var(--text)",
              height: "100%",
              width: "100%",
            }}
          >
            <IconCaret
              dir={f.is_open ? "down" : "right"}
              size={13}
              style={{ color: "var(--faint)" }}
            />
            {(() => {
              const Glyph = noteIconComp(f.icon, IconFolder);
              return (
                <Glyph
                  size={15}
                  strokeWidth={1.8}
                  style={{ color: f.color_hue != null ? folderColorCss(f.color_hue) : "var(--accent)" }}
                />
              );
            })()}
            <TreeRowInlineEditor
              id={f.id}
              isFolder={true}
              draft={editingDraft}
              onDraftChange={onEditingDraftChange}
              onCommit={onCommitEdit}
              onBlur={onEditBlur}
              onCancel={onCancelEdit}
              fontSize="var(--text-md)"
              fontWeight={600}
            />
          </div>
        );
      }
      const exclusionLabel = folderExclusionLabel(f);
      return wrap(
        <div
          role="button"
          tabIndex={0}
          // "treerow" 는 노트 행과 같은 표식일 뿐 아니라, treeRow.css 가 folder-count 를 항상
          // 보이게 override 할 때 tokens.css 원본(.menu-row.menu-item, 3-class)보다 확실히
          // 높은 특이도(4-class)를 내려는 용도도 겸한다 — 아래 카운트/"+" 주석 참고.
          className={`treerow menu-row menu-item${pressingId === f.id ? " folder-longpress" : ""}`}
          data-ai-glow={isFolderGlow || undefined} /* "active" | "fading" */
          data-ai-glow-inset="true"
          // 왼쪽 버튼으로 행 자체를 누른 동안만 카운트한다 — 우클릭은 컨텍스트 메뉴 몫이고,
          // 행 안의 "+"(새 노트) 는 자기 click 만 stopPropagation 하고 pointerdown 은 올려보내므로
          // 여기서 걸러내지 않으면 "+" 를 오래 누른 것도 폴더 설정을 연다.
          onPointerDown={(e) => {
            if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
            setPressingId(f.id);
            beginLongPress(() => {
              setPressingId(null);
              useUiStore.getState().openFolderFiles(f.id);
            }, FOLDER_LONG_PRESS_MS);
          }}
          onPointerUp={endLongPress}
          onPointerLeave={endLongPress}
          onPointerCancel={endLongPress}
          onClick={() => {
            // 길게 눌러 모달이 떴으면 뒤따라오는 click 은 삼킨다 — 안 그러면 모달을 열면서
            // 폴더가 같이 접힌다.
            if (consumeLongPress()) return;
            onToggleFolder(f);
          }}
          onDoubleClick={() => onStartEdit(f.id, true, f.name)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggleFolder(f);
            } else if (e.key === "F2") {
              e.preventDefault();
              onStartEdit(f.id, true, f.name);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            onOpenCtx(f.id, e.clientX, e.clientY);
          }}
          {...noteDropTargetProps(`folder:${f.id}`)}
          style={{
            gap: "var(--space-3)",
            padding: "var(--space-2) var(--sidebar-pad) var(--space-2) var(--space-3)",
            color: "var(--text)",
            height: "100%",
            width: "100%",
            position: "relative",
          }}
        >
          <IconCaret
            dir={f.is_open ? "down" : "right"}
            size={13}
            style={{ color: "var(--faint)", transition: "transform var(--dur-med)" }}
          />
          {/* 글리프는 순수 표시다 — 예전엔 클릭하면 색 프리셋 팝오버가 떴지만, 색·아이콘·규칙·
              제외가 모두 폴더 설정 모달(우클릭)에 모인 뒤로는 두 벌 두지 않는다. 핸들러가 없으니
              클릭은 그대로 행으로 올라가 폴더가 열리고 닫힌다(편집 중 브랜치와 같은 렌더). */}
          {(() => {
            const Glyph = noteIconComp(f.icon, IconFolder);
            return (
              <Glyph
                size={15}
                strokeWidth={1.8}
                style={{ flex: "none", color: f.color_hue != null ? folderColorCss(f.color_hue) : "var(--accent)" }}
              />
            );
          })()}
          <span style={{ fontSize: "var(--text-md)", fontWeight: 600 }}>{f.name}</span>
          {/* 검색/AI 제외 표식. 폴더명 바로 뒤(카운트 셀의 marginLeft:auto 앞) 라 폴더의 속성으로
              읽힌다. 정상 폴더에서는 아예 렌더되지 않으므로 기존 행 레이아웃은 그대로다.
              핸들러를 달지 않는다 — 클릭은 그대로 부모로 올라가 폴더 열기/닫기가 된다. */}
          {exclusionLabel && (
            <span
              role="img"
              aria-label={exclusionLabel}
              title={exclusionLabel}
              style={{
                display: "inline-flex",
                alignItems: "center",
                flex: "none",
                marginLeft: "calc(-1 * var(--space-1))",
                color: "var(--faint)",
              }}
            >
              <IconLock size={12} strokeWidth={2} aria-hidden />
            </span>
          )}
          {/* "+"(왼쪽, hover 전용)와 카운트(오른쪽, 항상 보임) — 별도 셀. 예전엔 동일 grid 셀을
              공유해(평소 카운트, hover 시 "+") hover 중엔 카운트가 아예 안 보였다(tokens.css
              806~808줄 — 그 절반은 treeRow.css 가 무효화한다, 코멘트 참고). marginLeft:auto 로
              폴더명과의 거리는 그대로 유지. */}
          <span
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: "var(--space-1)",
            }}
          >
            <button
              type="button"
              className="folder-add-btn"
              aria-label={t("tree.add_note_here")}
              title={t("tree.add_note_here")}
              onClick={(e) => {
                e.stopPropagation();
                onNewNoteInFolder(f.id);
              }}
              style={{
                width: 22,
                height: 22,
                border: 0,
                background: "transparent",
                color: "var(--accent)",
                borderRadius: "var(--radius-sm)",
                cursor: "pointer",
                // display 는 tokens.css 가 소유 — 인라인 display:none 은 hover 규칙(클래스)보다
                // 우선순위가 높아 + 가 영영 안 보이는 버그가 됐었다.
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
              }}
            >
              <IconPlus size={13} strokeWidth={2.2} />
            </button>
            <span
              className="folder-count"
              style={{
                fontSize: "var(--text-2xs)",
                fontWeight: 600,
                color: "var(--faint)",
                // E8: --surface-soft 는 사이드바에서 바탕과 **글자 그대로 같은 값**이라
                // CR 1.000 — 배경 선언이 완전한 no-op 이었고, acrylic 에서는 반대로 반투명
                // 시트 위 불투명 패치가 되어 이 알약만 데스크톱을 가렸다. --surface-raised
                // (중성 반투명)로 옮겨 ⓘ 힌트 뱃지와 같은 어휘를 쓴다.
                background: "var(--surface-raised)",
                padding: "0 var(--space-2)",
                borderRadius: "var(--radius-pill)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {f.note_count}
            </span>
          </span>
        </div>
      );
    }
    case "search_pending":
      return wrap(
        <div
          role="status"
          style={{
            padding: "var(--space-6) var(--space-3)",
            textAlign: "center",
            color: "var(--faint)",
            fontSize: "var(--text-sm)",
            width: "100%",
          }}
        >
          {t("search.searching")}
        </div>
      );
    case "search_empty":
    case "empty_filter":
      return wrap(
        <div
          style={{
            padding: "var(--space-6) var(--space-3)",
            textAlign: "center",
            color: "var(--faint)",
            fontSize: "var(--text-sm)",
            width: "100%",
          }}
        >
          {row.kind === "search_empty" && row.keyword ? t("search.no_results_keyword") : t("search.no_notes_in_range")}
        </div>
      );
    case "empty_workspace":
      return wrap(
        <div
          style={{
            padding: "var(--space-6) var(--space-3)",
            textAlign: "center",
            color: "var(--faint)",
            fontSize: "var(--text-sm)",
            lineHeight: 1.5,
            width: "100%",
          }}
        >
          {t("tree.empty_workspace")}
        </div>
      );
    case "skeleton": {
      const idx = row.index;
      const indented = idx === 1 || idx === 2 || idx === 5;
      const widthPct = [55, 70, 40, 65, 50, 75, 45][idx % 7];
      return wrap(
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            padding: indented
              ? "var(--space-2) var(--space-3) var(--space-2) 24px"
              : "var(--space-2) var(--space-3)",
            height: "100%",
            width: "100%",
          }}
        >
          <div
            className="skeleton-bar"
            style={{
              width: indented ? 14 : 16,
              height: indented ? 14 : 16,
              flex: "none",
            }}
          />
          <div
            className="skeleton-bar"
            style={{
              height: 12,
              width: `${widthPct}%`,
              flex: "none",
            }}
          />
        </div>
      );
    }
    default:
      return null;
  }
}

export const TreeListRow = React.memo(
  TreeListRowImpl
) as unknown as (props: RowComponentProps<ListRowProps>) => React.ReactElement | null;
