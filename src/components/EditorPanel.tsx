import { RemoteChangeBanner } from "./RemoteChangeBanner";
import { Suspense, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import Placeholder from "@tiptap/extension-placeholder";
import { SlashCommand } from "./editor/slashCommand";
import { WikiLink } from "./editor/wikiLink";
import { HashTag } from "./editor/hashTag";
import { DateNudge } from "./editor/dateNudge";
import { SectionTabBar } from "./editor/SectionTabBar";
import { BodyCollapseToggle } from "./BodyCollapseToggle";
import { createStableRectAnchor } from "./editor/stableAnchor";
import { TaskListDashInputRule } from "./editor/taskListDashInputRule";
import { MdAutoformatGate } from "./editor/mdAutoformatGate";
import { useNotesStore, markSnapshotDirty } from "../stores/notes";
import { useUiStore } from "../stores/ui";
import { call, emitNotice } from "../lib/invoke";
import { openExternalUrl } from "../lib/urls";
import { LinkNudge, type LinkNudgeCtx } from "./common/LinkNudge";
import { fetchNoteSummary } from "../lib/noteSummaries";
import { registerActiveSectionGetter, registerActiveEditor, registerSectionInserter, prepareAiInsertNoteId } from "../lib/aiSectionBridge";
import { PREVIEW_EXTENSIONS } from "../lib/editorExtensions";
import { mdSerializeEditor } from "../lib/mdSerialize";
import { reportFallback } from "../lib/diag";
import { clearSaveFailed, hasSaveFailed, markSaveFailed } from "../lib/sectionSaveFailures";
import { isSectionGated } from "../lib/sectionTokens";
import { requestOpenNoteInMain } from "../lib/openNoteInMain";
import { useAiGlow, AI_GLOW_KEYS } from "../stores/ai";
import type { AskAiTarget } from "./AskAiModal";
import { usePresetsStore } from "../stores/presets";
import { registerApplyPreset, registerSectionNavigator } from "../lib/presetBridge";
import { t } from "../i18n/t";
import type { Section } from "../lib/commands.gen";
import { diagramBody } from "./diagram/diagramStarter";
import { emptySheet, serializeSheet } from "../lib/sheet/types";
import { isSheetBodyEmpty } from "../lib/sheet/isSheetBodyEmpty";
import { useEditorPaste } from "./editor/useEditorPaste";




import "../styles/emoji.css";
import { EmojiRender, EMOJI_STYLE_META } from "../lib/emoji/emojiExtension";
import { subscribeEmojiRender } from "../lib/emoji/emojiCore";
import { useSettingsStore, type EditorWidth } from "../stores/settings";
import { useTabsStore } from "../stores/tabs";
import { useSectionActions } from "./editor/useSectionActions";
import { paintSectionBody, unchangedSinceLoad, useSectionEditor } from "./editor/useSectionEditor";
import { EditorGhostOverlay } from "./editor/EditorGhostOverlay";
import { EditorDropOverlay } from "./editor/EditorDropOverlay";
// 실험적 — 오너가 보고 뺄 수 있다(2026-09-20). editorWordCount 프리퍼런스 실효 게이트.
import { WordCountBar } from "./editor/WordCountBar";
// 2026-08-12: was a local component in this file; the 관계도 hint bar is the second caller.
import { CheatsheetPopover, type CheatsheetItem, Key, Sep } from "./common/CheatsheetPopover";
// Toolbar/bubble UI — owner QA 6, item 8 code split: moved out of the former monolithic
// Toolbar.tsx into editor/toolbar/* (FixedToolbar, TextBubbleMenu, TableMenu, ImageBubble,
// popover primitives + the shared button components they're all built from).
import { FixedToolbar } from "./editor/toolbar/FixedToolbar";
import { TextBubbleMenu } from "./editor/toolbar/TextBubbleMenu";
import { ImageBubbleMenu } from "./editor/toolbar/ImageBubble";
import { TableBubbleMenu, TableContextMenu, type TableContextMenuOpen } from "./editor/toolbar/TableMenu";
import { TranslatePanel } from "./editor/TranslateControls";
// Wave 6A: selection clipboard + right-click selCtx menu extracted from this file.
import {
  copyEditorSelection,
  cutEditorSelection,
  pasteEditorSelection,
} from "./editor/selectionClipboard";
import {
  SelectionContextMenu,
  type SelectionContextMenuOpen,
} from "./editor/SelectionContextMenu";
// PLAN-2026-09-18-nl-dates.md §W2 — "/날짜" 슬래시 커맨드와 "일정으로 등록" 선택 메뉴가 공용으로
// 여는 팝오버(lib/dateEntryBridge.ts 구독). SelectionContextMenu 와 같은 자리, 같은 마운트 방식.
import { DateEntryPopover } from "./editor/DateEntryPopover";
// PLAN-2026-09-18-nl-dates.md §W6 — "/지역" 슬래시 커맨드가 여는 팝오버(lib/regionEntryBridge.ts
// 구독). DateEntryPopover와 같은 자리, 같은 마운트 방식.
import { RegionEntryPopover } from "./editor/RegionEntryPopover";
// 섹션 분리 창(1단계) — 배타 소유: 분리된 섹션은 본 창에서 편집하지도 저장하지도 않는다.
import { useSectionWindowsStore, isSectionDetached, registerSectionReturnedHook } from "../stores/sectionWindows";
import { registerBodyCacheDiscardHook } from "../lib/sectionTokens";
import { DetachedSectionPlaceholder } from "./editor/DetachedSectionPlaceholder";

// ponytail: 오너 QA7: 본문 가림. 되살리려면 이 상수만 true로 변경.
const TEXT_BUBBLE_ENABLED = false;

// Re-export extracted overlays and helpers for test compatibility and clean interface.
export {
  renderPresetGhostHtml,
  resolveGhostBody,
  EditorGhostOverlay,
} from "./editor/EditorGhostOverlay";
export { EditorDropOverlay } from "./editor/EditorDropOverlay";

/** Exported for testing. Which section is "active" for render purposes — prefers the section
 *  matching the tracked id, falls back to the last section (mirrors the note-load effect's own
 *  "no match yet" fallback below) so this never throws on a note's first paint. Determines
 *  whether EditorPanel renders the diagram component or the Tiptap editor for the current tab. */
export function resolveActiveSection(sections: Section[], activeId: string | undefined): Section {
  return sections.find((s) => s.id === activeId) ?? sections[sections.length - 1];
}

/** Exported for testing. Owner QA 6, item 4 ("toolbar image insert doesn't land at the caret"):
 *  found a mechanism that plausibly explains the report, not a reproduction of it — the note-load
 *  effect must not call setContent() — which rebuilds the whole ProseMirror doc and resets the
 *  live selection — when nothing actually changed. That effect fires on ANY new `activeNote`
 *  object reference, including the one reloadActive() produces right after an insert it already
 *  flushed to the server; without this guard, an insert can land correctly and then have the
 *  caret jump away from under the user on the very next reload. True only when the note-load
 *  effect is about to redundantly repaint the SAME section with content that's already live in
 *  the editor — a real section/note switch, or a genuinely different incoming body (an AI insert
 *  into the mounted section, etc.), still repaints normally. */
export function shouldSkipReloadRepaint(
  sameNote: boolean,
  currentSectionId: string | undefined,
  currentKind: string | undefined,
  nextSectionId: string,
  incomingBody: string,
  liveBody: string
): boolean {
  return (
    sameNote &&
    currentSectionId === nextSectionId &&
    currentKind === "text" &&
    incomingBody === liveBody
  );
}

/** Exported for testing. 실험적 — 오너가 보고 뺄 수 있다(2026-09-20). linkOpenOnClick 프리퍼런스가
 *  켜졌을 때, "조합키 없는 맨 클릭"으로 http(s) 링크를 열지 결정한다. Ctrl/Cmd+클릭(오너
 *  2026-09-10 규칙)은 이 함수와 무관하게 항상 연다 — 호출부가 그 분기를 별도로 갖는다. */
export function shouldOpenLinkOnPlainClick(opts: {
  /** settings.linkOpenOnClick — 꺼져 있으면(기본값) 무조건 false, 오늘까지의 동작 그대로. */
  pref: boolean;
  /** MouseEvent.button — 0(주 버튼)이 아니면 절대 열지 않는다. */
  button: number;
  /** editor.isEditable — 잠긴(content_locked) 노트는 오늘까지의 동작(맨 클릭으로 안 열림)을
   *  그대로 유지한다. */
  editable: boolean;
  /** 이 클릭이 텍스트 드래그 선택을 막 끝낸 mouseup 인가(window.getSelection() 이 비어있지
   *  않음) — 문단 선택 제스처가 이 분기로 새지 않도록. */
  endsTextSelection: boolean;
  /** 클릭 대상이 링크 편집 팝오버(FixedToolbar 의 LinkButton 등, data-editor-pop) 내부인가. */
  onLinkEditUi: boolean;
}): boolean {
  return (
    opts.pref &&
    opts.button === 0 &&
    opts.editable &&
    !opts.endsTextSelection &&
    !opts.onLinkEditUi
  );
}

/** Exported for testing. 실험적 — 오너가 보고 뺄 수 있다(2026-09-20). editorWidth 프리퍼런스의
 *  CSS 클래스 매핑(공백 접두 — 호출부가 그대로 문자열에 이어붙인다). editorFullWidth 가 켜져
 *  있으면 이 값과 무관하게 항상 "" — 전체 너비가 이긴다(설정 화면이 이미 그 상태의 컨트롤을
 *  잠근다). tokens.css 쪽 `.editor-fullwidth` 규칙이 `.editor-width-narrow`/`-wide` 보다 뒤에
 *  오는 소스 순서도 같은 방향의 2차 안전장치 — 이 함수가 1차(JS 레벨에서 클래스 자체를 안 붙임). */
export function editorWidthClassName(editorFullWidth: boolean, editorWidth: EditorWidth): string {
  if (editorFullWidth) return "";
  if (editorWidth === "narrow") return " editor-width-narrow";
  if (editorWidth === "wide") return " editor-width-wide";
  return "";
}

/** Exported for testing. The exact section_create_with_body payload the "+" picker's "관계도"
 *  option sends — kept as a pure function so the picker's contract (kind + starter JSON IR body,
 *  formerly a starter mermaid body before the 2026-09-04 JSON IR rebuild) is testable without
 *  mounting the full Tiptap-backed EditorPanel. */
export function buildDiagramSectionArgs(
  noteId: string,
  bodyMd?: string
): { note_id: string; body_md: string; kind: "diagram" } {
  return { note_id: noteId, body_md: diagramBody(bodyMd), kind: "diagram" };
}

export function buildSheetSectionArgs(
  noteId: string,
  bodyMd?: string
): { note_id: string; body_md: string; kind: "sheet" } {
  return { note_id: noteId, body_md: bodyMd ?? serializeSheet(emptySheet()), kind: "sheet" };
}

/** Exported for testing. The section_create_with_body payload the AI-insert bridge
 * (lib/aiSectionBridge.ts's registerSectionInserter, called by aiPresets.ts's runAiAction) sends
 * — forwards an optional kind (aiPresets.ts's 관계도 만들기/diagram preset passes "diagram") the
 * same way buildDiagramSectionArgs does for the manual "+" picker. Omitted kind is the pre-existing
 * behavior for ai_cleanup_text/ai_generate_from_prompt (always "text", unchanged).
 * aiOrigin (W5 section provenance, docs/PLAN-2026-08-30-ai-surface-and-clients.md §3 W5):
 * the calling action's id (BUILTIN_DEFS, or "translate"/"prompt" for the flows that don't have
 * a preset row) — undefined for inserts that aren't actual AI output (blank sections, template
 * skeletons, raw link-reader text). Forwarded as-is to ai_origin; the branch logic itself lives
 * server-side (specs/commands/sections.yaml section_create_with_body). */
export function buildAiInsertSectionArgs(
  noteId: string,
  name: string,
  bodyMd: string,
  kind?: "text" | "diagram" | "sheet",
  aiOrigin?: string
): { note_id: string; name: string; body_md: string; kind?: "text" | "diagram" | "sheet"; ai_origin?: string } {
  return {
    note_id: noteId,
    name,
    body_md: kind === "diagram" ? diagramBody(bodyMd) : kind === "sheet" ? (bodyMd || serializeSheet(emptySheet())) : bodyMd,
    kind,
    ai_origin: aiOrigin,
  };
}


// Paste pipeline pure helpers — defined in editor/useEditorPaste.ts and re-exported here
// so EditorPanel.paste.test.tsx and external consumers preserve identical import contract.
export {
  derivePasteImageName,
  shouldPasteClipboardImages,
  shouldSuggestSheetFromPaste,
  soleFilePathFromPasteText,
  isPasteStillOnTarget,
} from "./editor/useEditorPaste";
import { DiagramSection, SheetSection, AskAiModal } from "../lazySurfaces";

/** Wave 2-2: Right-bottom statistics area '?' popover for verified markdown input rules.
 *  Rules only list prefixes that inputRules.test.ts proves fire with our schema
 *  (TaskItem nested:true). N2-6: `- [ ] ` (the GFM habit people actually type) is listed
 *  instead of the bare `[ ] ` form — TaskListDashInputRule (taskListDashInputRule.ts) makes it
 *  fire too, on top of the stock bare form, which still works but isn't what people reach for.
 *  Called at render time (not a module constant) so a UI-language switch re-reads it. */
const verifiedRules = (): CheatsheetItem[] => [
  { heading: t("editor.cheatsheet_heading_markdown") },
  { rule: "# ", desc: t("editor.heading_1") },
  { rule: "> ", desc: t("editor.blockquote") },
  { rule: "- ", desc: t("editor.bullet_list") },
  { rule: "1. ", desc: t("editor.ordered_list") },
  { rule: "- [ ] ", desc: t("editor.task") },
  { rule: "```", desc: t("editor.code_block") },
  { rule: "---", desc: t("editor.divider") },

  { heading: t("editor.cheatsheet_heading_format") },
  {
    rule: [Key(t("common.key_ctrl")), Sep("+"), Key("B")],
    desc: t("editor.bold"),
  },
  {
    rule: [Key(t("common.key_ctrl")), Sep("+"), Key("I")],
    desc: t("editor.italic"),
  },
  {
    rule: [Key(t("common.key_ctrl")), Sep("+"), Key(t("common.key_shift")), Sep("+"), Key("X")],
    desc: t("editor.strikethrough"),
  },
  {
    rule: [Key(t("common.key_ctrl")), Sep("+"), Key("E")],
    desc: t("editor.code_inline"),
  },
  {
    rule: [Key(t("common.key_ctrl")), Sep("+"), Key("Z"), Sep("/"), Key("Y")],
    desc: t("editor.sheet_cheat_undo_redo_desc"),
  },
];

/** 배타 소유 가드(자동저장·flush 공용) — 분리된 섹션이면 true, 저장하지 않는다. 라이브 문서가 마지막
 *  저장본과 다르면 그 편집은 어디에도 남지 않으므로 진단에 기록한다(함정 11). 정상 경로에선 분리 중 본 창
 *  에디터가 플레이스홀더 뒤에 숨어 있고 여는 동안은 잠겨 있어(openSectionWindow) 이 기록이 없어야 한다. */
export function dropIfDetached(sec: { id: string; body: string }, editor: Editor): boolean {
  if (!isSectionDetached(sec.id)) return false;
  if (mdSerializeEditor(editor) !== sec.body) reportFallback("section_window", "detached_edit_dropped");
  return true;
}

/** inDetachedWindow: 섹션 분리 창(#/section, src/section/SectionWindowApp.tsx)에서 단독으로 돌 때 —
 *  그 창의 스토어엔 섹션 하나만 실려 있고 탭 바(추가/삭제/이동/분리)는 본 창 몫이라 그리지 않는다. */
export function EditorPanel({ inDetachedWindow = false }: { inDetachedWindow?: boolean } = {}) {
  // 좁은 선택자로 구독 — 이전엔 전체 스토어를 구독해, 사이드바 검색창에 한 글자 칠 때마다
  // (setQuery/searchResults 갱신) Tiptap 트리 전체를 품은 이 에디터가 매번 리렌더됐다.
  const activeNote = useNotesStore((s) => s.activeNote);
  const newNote = useNotesStore((s) => s.newNote);
  // Gates for the eager empty-state draft effect below — must not fire mid-boot (App.tsx hasn't
  // restored the persisted tab yet) or mid note-switch (selectNote's discardDraft() nulls
  // activeNote before the real note lands; firing here would race it and clobber the switch).
  const isBooting = useNotesStore((s) => s.isBooting);
  const loadingNoteId = useNotesStore((s) => s.loadingNoteId);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  // N1-3 (owner QA 6, item 1): the scroll container every bubble/popover must track. State (not a
  // plain useRef) — a ref's `.current` would still be null the first time any BubbleMenu's plugin
  // registers if this component happens not to re-render again after mount (see item 3's own
  // finding: `shouldRerenderOnTransaction` is off by default here, so a bare ref could silently
  // stay bound to the stale null → `window` fallback forever). A callback-ref-driven state update
  // guarantees the one extra render that delivers the real element to every consumer below.
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  // 파일 드롭존 히트테스트 rect — 섹션 종류(텍스트/시트/관계도)와 무관하게 항상 마운트되는
  // 최상위 컨테이너(아래 return의 루트 div)를 가리킨다. scrollEl과 같은 이유로 callback-ref
  // 기반 state: 마운트 시점의 첫 렌더에서 EditorDropOverlay가 이미 이 값을 prop으로 필요로
  // 하므로(plain ref라면 아직 null인 채로 넘어가 하위 컴포넌트가 그 첫 프레임을 놓친다), 실제
  // DOM 노드가 붙는 즉시 한 번 더 리렌더되도록 한다.
  const [dropContainerEl, setDropContainerEl] = useState<HTMLDivElement | null>(null);
  // Item 3: editor width toggle (comfortable ↔ full-width) — see tokens.css's
  // `.editor-desktop`/`.editor-fullwidth` rules for the CSS side.
  const editorFullWidth = useSettingsStore((s) => s.editorFullWidth);
  // 실험적 — 오너가 보고 뺄 수 있다(2026-09-20). editorWidth(narrow/normal/wide) — CSS 쪽은
  // tokens.css 의 `.editor-width-narrow`/`.editor-width-wide` 규칙(editor-fullwidth 바로 위).
  const editorWidth = useSettingsStore((s) => s.editorWidth);
  const editorWordCount = useSettingsStore((s) => s.editorWordCount);
  const previewItem = useUiStore((s) => s.previewItem);
  // 분리된 섹션 id 들 — 본 창에서만 채워진다(분리 창은 이 스토어를 시작하지 않는다, sectionWindows.ts).
  const detachedIds = useSectionWindowsStore((s) => s.ids);

  // Paste pipeline extracted to editor/useEditorPaste.ts (docs/PLAN-2026-09-13-separation-of-concerns.md §4-a).
  // editorRef breaks the circularity between useEditor and its handlePaste editorProp.
  const editorRef = useRef<Editor | null>(null);
  const { handlePaste: handleImagePaste } = useEditorPaste(
    () => editorRef.current,
    () => sectionRef.current,
    (nudge) => setLinkNudge(nudge),
    (noteId, sec) => appendSectionLocally(noteId, sec),
    (sec) => switchSection(sec),
    buildAiInsertSectionArgs
  );

  const editor = useEditor({
    extensions: [
      // Schema-affecting extensions (StarterKit/Markdown/TaskList/Link/BriseImage/Table/…, ~15
      // entries) are the same PREVIEW_EXTENSIONS the ghost preview (renderPresetGhostHtml above)
      // and SectionPreview.tsx use — Wave R1-b dedup, was a third hand-synced copy of the same
      // list (StarterKit codeBlock/link opts, Table renderWrapper, Link's note:// protocol, …).
      // See editorExtensions.ts/mdSerialize.ts's markdownSchemaExtensions for the shared source.
      // 표 열 너비 드래그(오너 2026-09-21)는 라이브 에디터만 — resizable:true 는 여기서 Table
      // 하나의 옵션만 재구성해 오버라이드한다(configure()는 같은 name 을 유지, 새 확장을
      // 추가하지 않는다 — 확장 매니저는 이름 중복을 dedup 하지 않아 Table 을 통째로 하나 더
      // 넣으면 columnResizing/tableEditing 플러그인이 두 벌 붙는다). 헤드리스 고스트
      // (EditorGhostOverlay)·SectionPreview 는 이 배열 밖이라 그대로 PREVIEW_EXTENSIONS의
      // resizable:false 를 쓴다(tokens.css 의 .column-resize-handle/.resize-cursor 참고).
      ...PREVIEW_EXTENSIONS.map((ext) => (ext.name === "table" ? ext.configure({ resizable: true }) : ext)),
      // Everything below is interactive-only — no schema/mark of its own, so none of it changes
      // what mdSerializeEditor/mdSerializeHtml has to handle (kept out of PREVIEW_EXTENSIONS for
      // exactly that reason; see editorExtensions.ts/mdSerialize.ts's own comments).
      // 함수형 — 이 에디터는 deps 없이 한 번만 만들어지므로 문자열로 넘기면 마운트 시점의 언어로
      // 굳는다(설정 로드 전이면 영어). 함수는 데코레이션을 다시 계산할 때마다 t() 를 새로 읽는다.
      Placeholder.configure({ placeholder: () => t("editor.body_placeholder") }),
      EmojiRender,
      // Wave 3 — "/" insert menu and "[[" wiki-link autocomplete. Pure additions: neither
      // extension defines a node/mark of its own (slash commands invoke existing toggle
      // commands; wiki-links insert a plain Link mark), so nothing here changes what
      // mdSerializeHtml has to handle beyond the note:// passthrough rule already in place.
      SlashCommand,
      WikiLink,
      // §W5 (PLAN-2026-09-18-nl-dates.md) — "#" tag autocomplete, no mark/schema of its own
      // (plain "#tagname" text, same as WikiLink/SlashCommand above).
      HashTag,
      // N2-6: GFM habit accommodation — "- [ ] "/"- [x] " (not just bare "[ ] ") becomes a
      // checklist item too. Pure addition, no schema change — see taskListDashInputRule.ts.
      TaskListDashInputRule,
      // §W3b (PLAN-2026-09-18-nl-dates.md) — typing nudge chip for natural-language dates. Live
      // editor only, deliberately NOT in PREVIEW_EXTENSIONS (see dateNudge.ts header).
      DateNudge,
      // 오너 결정(2026-09-20) — 마크다운 자동 서식(editor_md_autoformat) 킬 스위치. 라이브
      // 에디터 본문에서만 — 읽기 전용 프리뷰(PREVIEW_EXTENSIONS)에는 넣지 않는다(mdAutoformatGate.ts
      // 헤더 참고).
      MdAutoformatGate,
    ],
    content: "",
    editorProps: {
      // 네이티브 브라우저 맞춤법 검사 — nspell/워커/데코레이션 제거(Wave 6-b), OS/WebView2 사전이
      // 대신 밑줄을 그린다. SpellcheckToggle이 이 속성을 런타임에 직접 토글한다.
      attributes: { spellcheck: "true" },
      handlePaste: handleImagePaste,
    },
    onUpdate: ({ editor }) => {
      if (!sectionRef.current) {
        // 빈 상태(열린 노트 없음)에서 사용자가 입력 에디터에 바로 타이핑을 시작한 경우 —
        // 첫 keystroke에서 초안 노트를 만든다(stores/notes.ts의 newNote 흐름 재사용).
        // bridgeAutoCreateDraft 자체가 재진입을 막으므로 여기서는 조건 없이 그냥 부른다.
        if (!useNotesStore.getState().activeNote && !editor.isEmpty) {
          void bridgeAutoCreateDraft();
        }
        return;
      }
      // 다이어그램/시트 섹션은 EditorContent를 아예 렌더하지 않으므로(각 전용 컴포넌트가 대신 그림)
      // 실사용자 타이핑으로는 여기 닿을 수 없다 — 그래도 방어선으로 둔다.
      if (sectionRef.current.kind !== "text") return;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      useNotesStore.getState().setSavedState("saving");
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        const sec = sectionRef.current;
        if (!sec) return;
        // 배타 소유 — 분리된 섹션은 새 창이 저장한다. 여기서 쓰면 그 창의 편집을 stale 본문으로 덮는다.
        if (dropIfDetached(sec, editor)) return;
        const body_md = mdSerializeEditor(editor);
        // 섹션 전환 후 되돌아와도 최신 편집분을 복원할 수 있도록 로컬 캐시에 기록.
        bodyCacheRef.current[sec.id] = body_md;
        if (unchangedSinceLoad(sec, body_md, editor)) {
          useNotesStore.getState().setSavedState("saved");
          return;
        }
        sec.body = body_md;
        useNotesStore.getState().updateSectionBody(sec.id, body_md);
      }, 700);
    },
  });
  editorRef.current = editor;

  // N1-2: selection BubbleMenu 앵커 — (from,to) 가 그대로인 문서 변경(굵게/제목 토글)에는 rect 를
  // 다시 묻지 않는다(stableAnchor.ts 참고). 에디터 인스턴스당 하나, 렌더마다 재생성하지 않는다.
  const textAnchorRef = useRef(createStableRectAnchor());
  // 활성 섹션 추적 + flush 배선 — editor/useSectionEditor.ts (MobileNote.tsx와 공유; 그 파일이
  // ref+state 미러와 registerFlush 배선의 byte-for-byte 동일 부분만 뽑아낸 이유를 설명한다).
  // kind: 다이어그램 섹션 동안 onUpdate/flushRef가 Tiptap 경로를 타지 않도록 하는 유일한 판별
  // 소스(id만으로는 구분 불가). onSet 콜백: 데스크탑만의 사정 — 메모이즈된 BubbleMenu 앵커
  // (textAnchorRef)는 ProseMirror 위치(from,to)로 캐시되어 있어, setContent()가 다른 섹션/노트의
  // 내용으로 갈아끼우면 같은 (from,to) 가 무관한 텍스트를 가리킬 수 있다 — 에디터 내용을 교체하는
  // 모든 경로(이 콜백을 타는 note-load effect·switchSection; registerApplyPreset의 제자리 적용과
  // 빈 상태 clearContent 는 이 경로를 타지 않으므로 각자 직접 리셋한다)가 다음 BubbleMenu 표시가
  // 처음부터 다시 계산하도록 먼저 메모를 지운다.
  const { sectionRef, activeSectionId, setActiveSection, setActiveSectionId, timeoutRef, flushRef } =
    useSectionEditor<string>(() => {
      textAnchorRef.current = createStableRectAnchor();
    });
  // 섹션별 최신 본문 캐시 — store 는 타이핑 중 activeNote 를 갱신하지 않으므로(커서 튐 방지),
  // 섹션 전환 시 이 캐시로 편집분을 복원한다. 노트가 바뀌면 초기화.
  const bodyCacheRef = useRef<Record<string, string>>({});
  const prevNoteIdRef = useRef<string | null>(null);
  // Empty-state ("no note open") bridging — see onUpdate's `!sectionRef.current` branch below
  // and the note-load effect. skipNextContentLoadRef: the caller (bridgeAutoCreateDraft) already
  // painted the editor itself (the user's own typing, still live in the DOM) — set right before
  // it, tells the next note-load effect run to sync sectionRef/bodyCache from the *live* editor
  // instead of re-running setContent, which would otherwise clobber whatever was typed during the
  // newNote() await. autoCreateRef: re-entrancy guard so a burst of onUpdate events (fast typing)
  // before the first newNote() resolves doesn't fire a second one.
  const skipNextContentLoadRef = useRef(false);
  const autoCreateRef = useRef(false);

  // sectionCtx's "AI에게 묻기" row target (AskAiModal.tsx) — lives here; SectionTabBar opens
  // via onAskAi callback. Separate from SelectionContextMenu's PromptDialog-based flow (aiAskCtx).
  const [askAiTarget, setAskAiTarget] = useState<AskAiTarget | null>(null);
  // SectionTabBar reports rename / delete-confirm / section context-menu open so BubbleMenu and
  // the selection context menu can suppress themselves (same gate as pre-extract inline state).
  const [tabUiBusy, setTabUiBusy] = useState(false);
  // SelectionContextMenu (editor/SelectionContextMenu.tsx) owns selCtx/aiAskCtx; reports busy
  // so BubbleMenu can hide. openRef is bound by the menu to the editor surface onContextMenu.
  const [selMenuBusy, setSelMenuBusy] = useState(false);
  const [tableMenuBusy, setTableMenuBusy] = useState(false);
  const openTableMenuRef = useRef<TableContextMenuOpen | null>(null);
  const openSelMenuRef = useRef<SelectionContextMenuOpen | null>(null);
  // 링크 넛지(editor/LinkNudge.tsx) — 붙여넣기 직후와 링크 우클릭이 **같은 상태 하나**를 연다.
  const [linkNudge, setLinkNudge] = useState<LinkNudgeCtx | null>(null);

  // 분리 창이 닫혀 섹션이 돌아올 때 — 이 캐시가 분리 전 본문을 들고 있다. 비우지 않으면 note-load
  // effect 가 DB 에서 다시 읽은 본문 대신 캐시를 칠하고, 다음 타이핑이 그걸로 새 창의 편집을 덮는다.
  // 스토어가 reloadActive() **전에** 동기로 부른다(sectionWindows.ts 헤더의 순서).
  useEffect(
    () =>
      registerSectionReturnedHook((id) => {
        delete bodyCacheRef.current[id];
      }),
    [],
  );
  // D2② — 같은 이유. 서버에서 바뀐 섹션(reloadActive)·충돌 "내 글 복사" 섹션의 캐시를 남기면 다시 읽은
  // 서버본 위에 낡은 본문이 다시 그려지고, 새 토큰을 받은 다음 타이핑이 원격 편집을 덮는다. 시트 편집기는
  // 마운트 때만 본문을 읽으므로(useSheetState) 그 섹션이 열려 있으면 다시 마운트한다.
  const [sheetRemount, setSheetRemount] = useState(0);
  useEffect(
    () =>
      registerBodyCacheDiscardHook((id) => {
        delete bodyCacheRef.current[id];
        if (sectionRef.current?.id === id && sectionRef.current.kind === "sheet") setSheetRemount((r) => r + 1);
      }),
    [],
  );

  useEffect(() => {
    return subscribeEmojiRender(() => {
      if (editor) {
        const { tr } = editor.state;
        tr.setMeta(EMOJI_STYLE_META, true);
        editor.view.dispatch(tr);
      }
    });
  }, [editor]);

  // 현재 섹션의 pending 편집을 즉시 flush — 섹션 전환/노트 전환/창 close 공용 경로.
  // 최신 editor/sectionRef 를 항상 참조하도록 ref 에 담아 매 렌더 갱신(stale closure 방지).
  // flushRef 자체(ref)와 registerFlush 배선은 useSectionEditor 가 소유 — 여기서는 매 렌더
  // 실제 구현을 갱신만 한다.
  flushRef.current = async () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    const sec = sectionRef.current;
    if (!sec || !editor) return;
    // 비텍스트(다이어그램/시트) 섹션은 각자 디바운스+언마운트 flush로 저장을 소유한다.
    if (sec.kind !== "text") return;
    // 배타 소유 — 분리된 섹션은 새 창이 저장한다(onUpdate 의 같은 가드 참고).
    if (dropIfDetached(sec, editor)) return;
    const body_md = mdSerializeEditor(editor);
    bodyCacheRef.current[sec.id] = body_md;
    const mustSend = hasSaveFailed(sec.id) && !isSectionGated(sec.id);
    // 원문 비교만 하면 정규형이 아닌 본문은 손대지 않아도 flushAll 마다 다시 써진다(unchangedSinceLoad).
    if (unchangedSinceLoad(sec, body_md, editor) && !mustSend) return;
    const prev = sec.body;
    sec.body = body_md;
    useNotesStore.getState().setSavedState("saving");
    let failedWrite = false;
    try {
      await useNotesStore.getState().updateSectionBody(sec.id, body_md);
      failedWrite = useNotesStore.getState().savedState === "failed" && !isSectionGated(sec.id);
    } catch {
      failedWrite = true;
    }
    const live = sectionRef.current ?? sec;
    if (failedWrite) {
      sec.body = prev;
      if (live !== sec && live.body === body_md) live.body = prev;
      markSaveFailed(live.id);
    } else if (!isSectionGated(live.id)) {
      clearSaveFailed(sec.id);
      clearSaveFailed(live.id);
    }
  };

  // 노트가 바뀌면: 캐시 초기화 → 에디터에 현재/마지막 섹션 내용 주입.
  // 같은 노트 내 activeNote 재설정(예: reloadActive) 시에는 현재 섹션을 유지.
  useEffect(() => {
    // isDestroyed: StrictMode/HMR 재마운트 직후 이 effect 가 파괴된 인스턴스로 발화할 수 있고,
    // 그 위에서 .commands 를 읽으면 TipTap 내부 commandManager 가 null 이라
    // "Cannot read properties of null (reading 'commands')" 로 패널 전체가 ErrorBoundary 에 잡힌다
    // (온보딩 직후 첫 노트에서 실제 발생). SectionPreview.tsx 와 같은 가드.
    if (!editor || editor.isDestroyed) return;
    if (!activeNote) {
      // 빈 상태(열린 노트 없음) — 직전 노트의 잔여 내용이 남아있으면 지운다. 에디터
      // 인스턴스는 노트 유무와 무관하게 마운트 시 한 번만 생성돼 계속 살아있으므로(useEditor
      // 호출은 조건부가 아님), 지우지 않으면 빈 상태의 "입력 에디터"에 이전 노트가 그대로
      // 남아 보인다. sectionRef.current가 이미 null이면(최초 마운트) 빈 트랜잭션을 피한다.
      if (sectionRef.current !== null) {
        editor.commands.clearContent(true);
        textAnchorRef.current = createStableRectAnchor(); // N1-2: see setActiveSection above
        sectionRef.current = null;
        setActiveSectionId(null);
      }
      return;
    }
    const sections = activeNote.sections;
    if (!sections.length) return;
    if (prevNoteIdRef.current !== activeNote.note.id) {
      bodyCacheRef.current = {};
      prevNoteIdRef.current = activeNote.note.id;
      usePresetsStore.getState().clearHovered();
    }
    const cur = sectionRef.current;
    const sameNote = cur && sections.some((s) => s.id === cur.id);
    const next = sameNote
      ? sections.find((s) => s.id === cur!.id)!
      : sections[sections.length - 1];
    if (skipNextContentLoadRef.current) {
      skipNextContentLoadRef.current = false;
      // bridgeAutoCreateDraft가 방금 빈 상태 에디터에서 사용자가 직접 타이핑한 내용으로 이
      // 노트를 만들었다 — 그 타이핑이 authoritative 소스이므로 여기서 setContent로 다시
      // 덮어쓰면 newNote() await 도중 더 친 키 입력을 잃는다. 라이브 에디터에서 그대로 읽어
      // ref만 맞춘다(재렌더 없음).
      const body = mdSerializeEditor(editor);
      // bridgeAutoCreateDraft always materializes the first (always kind='text') section of a
      // brand-new draft — `next` here can only be kind='text', so no diagram guard needed.
      sectionRef.current = { id: next.id, body, kind: next.kind };
      bodyCacheRef.current[next.id] = body;
      return;
    }
    const body = bodyCacheRef.current[next.id] ?? next.body_md;
    // Owner QA 6, item 4 ("toolbar image insert doesn't land at the caret") — a plausible
    // contributor found while auditing this path, not a confirmed reproduction of the report:
    // reloadActive() (used by both the paste-image and toolbar-image-insert paths, and any future
    // caller) always flushes pending edits before re-fetching, then replaces `activeNote` with a
    // NEW object reference — even when nothing the user didn't already save changed. That
    // reference change alone re-runs this effect and used to unconditionally fall through to
    // setContent() below, which rebuilds the whole ProseMirror doc and resets the selection to a
    // default position. Even when the insert itself lands at the right spot, the caret could jump
    // away from under the user right after — which would read as "the insert didn't go where I
    // clicked" even though the node was placed correctly. Skip the repaint when we're already
    // showing this exact section and the incoming body is byte-identical to what's already live —
    // there's nothing to redraw and no reason to disturb the selection. A genuine external change
    // (AI insert into the mounted section, etc.) still has a different body and still repaints
    // normally.
    if (shouldSkipReloadRepaint(!!sameNote, cur?.id, cur?.kind, next.id, body, mdSerializeEditor(editor))) {
      sectionRef.current = { id: next.id, body, kind: next.kind };
      return;
    }
    setActiveSection(next.id, body, next.kind);
    if (next.kind !== "text") {
      // 다이어그램/시트 섹션 — Tiptap에는 아무것도 싣지 않는다(전용 컴포넌트가 직접 렌더).
      return;
    }
    // contentType markdown + emitUpdate: false — programmatic load, not a user edit. Without
    // emitUpdate:false, onUpdate arms the 700ms autosave; without contentType markdown, body_md
    // would be treated as HTML and **bold**/lists would die as plain text (P0-1). paintSectionBody also
    // records the painted doc as the save paths' "nothing changed" baseline (useSectionEditor.ts).
    paintSectionBody(editor, sectionRef.current, body);
  }, [activeNote, editor]);

  // 빈 상태 브리지 1 — 프리셋 리스트(PresetList, SourcePanel 쪽)가 이 콜백을 통해 노트를
  // 즉시 생성한다. lib/presetBridge.ts를 통해서만 호출되는, aiSectionBridge.ts와 같은 형태의
  // 형제 컴포넌트 간 브리지. 마운트 시 한 번 등록 — activeNote 유무와 무관하게 항상 반응 가능해야
  // 하므로(프리셋은 정확히 노트가 없을 때만 쓰인다) 렌더 중이 아니라 effect에서 등록한다.
  useEffect(() => {
    if (!editor) return;
    return registerApplyPreset(async ({ title, bodyMd, landing }) => {
      // Business logic (apply onto an existing empty note in place vs. spin up a fresh draft —
      // never note_create when a draft is already open) lives in the store, see
      // notes.ts::applyPreset. It returns the target section id only when it edited an EXISTING
      // note in place — that path doesn't change activeNote's identity (updateSectionBody's
      // non-draft branch is caret-safe by design), so the note-load effect above never fires to
      // repaint the editor and we must sync it here. The fresh-draft path DOES change activeNote
      // (same as any other note switch) and that effect already repaints it — don't double-sync.
      const secId = await useNotesStore.getState().applyPreset(bodyMd, title, landing);
      if (editor.isDestroyed) return; // await 뒤 — 파괴된 인스턴스의 .commands 는 throw (CLAUDE.md 함정 2)
      if (secId && sectionRef.current?.id === secId) {
        // Presets are prose templates — the section they land in-place on is always kind='text'.
        sectionRef.current = { id: secId, body: bodyMd, kind: "text" };
        bodyCacheRef.current[secId] = bodyMd;
        textAnchorRef.current = createStableRectAnchor(); // N1-2: see setActiveSection above
        paintSectionBody(editor, sectionRef.current, bodyMd);
      }
      editor.commands.focus();
    });
  }, [editor]);

  // PRESET TARGET STATE publisher — the single source PresetList (row enabled/disabled + reason)
  // and the hover ghost above both read (stores/presets.ts::PresetTargetState). Read from the LIVE
  // ProseMirror doc, never from notes.activeBodyEmpty: that flag only moves after the 700ms
  // autosave debounce (so a just-typed character or a just-cleared body wouldn't count) and is
  // wrong for multi-section notes (the store's sections stay stale by design).
  // `transaction` (not `update`) is the right event: it also fires for programmatic
  // setContent/clearContent, which pass emitUpdate:false and would otherwise leave this stale
  // after a note load / preset apply. Extra fires on bare caret moves are free — setTargetState
  // no-ops on an unchanged value. activeSectionId in the deps covers the one transition that
  // emits nothing at all: switching TO a diagram section skips setContent entirely.
  useEffect(() => {
    if (!editor) return;
    const publish = () => {
      const sec = sectionRef.current;
      if (sec?.kind === "diagram") {
        const isEmpty = !sec.body || !sec.body.trim();
        usePresetsStore.getState().setActiveEditorState("diagram", isEmpty);
      } else if (sec?.kind === "sheet") {
        const isEmpty = isSheetBodyEmpty(sec.body);
        usePresetsStore.getState().setActiveEditorState("sheet", isEmpty);
      } else {
        const isEmpty = editor.isEmpty;
        usePresetsStore.getState().setActiveEditorState("text", isEmpty);
      }
    };
    publish();
    editor.on("transaction", publish);
    return () => {
      if (!editor.isDestroyed) editor.off("transaction", publish);
    };
  }, [editor, activeSectionId, activeNote]);

  useEffect(() => {
    return registerSectionNavigator(async (sectionId) => {
      const n = useNotesStore.getState().activeNote;
      if (!n) return;
      const target = n.sections.find((s) => s.id === sectionId);
      if (target) {
        await switchSection(target);
      }
    });
  }, [activeNote, editor]);

  // 빈 상태 브리지 2 — 노트가 하나도 없는 상태에서 사용자가 입력 에디터에 바로 타이핑을
  // 시작하면(아래 onUpdate) 첫 keystroke에서 호출된다. newNote()가 끝난 뒤 그 시점의 라이브
  // 에디터 내용(=이미 친 것 전부, await 도중 더 친 것까지 포함)을 그대로 초안 섹션에 반영한다.
  const bridgeAutoCreateDraft = async () => {
    if (autoCreateRef.current) return;
    autoCreateRef.current = true;
    try {
      skipNextContentLoadRef.current = true;
      await useNotesStore.getState().newNote();
      if (!useNotesStore.getState().activeNote) {
        skipNextContentLoadRef.current = false; // newNote()가 no-op — 동기화할 것 없음
        return;
      }
      const body_md = mdSerializeEditor(editor!);
      useNotesStore.getState().setSavedState("saving");
      if (body_md.trim()) {
        await useNotesStore.getState().updateSectionBody("draft_sec", body_md);
      }
    } finally {
      autoCreateRef.current = false;
    }
  };

  // R1: 본문 자동저장 registerFlush 배선 — useSectionEditor 가 소유(위).

  // Draft-page model (Aperçu owner feedback item 2): whenever nothing is open (0 tabs, settled
  // post-boot, not mid-switch) the editor must show a real draft, not a special empty-state
  // branch — section tabs/toolbar/title area never disappear or change shape. newNote() without
  // a folderId only sets local draft state (no IPC — see notes.ts) and is a no-op when a draft is
  // already open, so this can't double-fire or leave a DB trace on its own. Typing still reaches
  // this same draft via the ordinary autosave path below, same as before this effect existed.
  useEffect(() => {
    if (isBooting || loadingNoteId !== null || activeTabId !== null || activeNote) return;
    void newNote();
  }, [isBooting, loadingNoteId, activeTabId, activeNote, newNote]);

  const isEditorGlow = useAiGlow(activeNote ? AI_GLOW_KEYS.editor(activeNote.note.id) : null);

  // Task 1: Ctrl + K / Cmd + K global AI trigger
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        e.stopPropagation();

        if (!activeNote) {
          setAskAiTarget({ kind: "new" });
          return;
        }

        const sec = resolveActiveSection(activeNote.sections, activeSectionId ?? undefined);
        if (sec?.kind === "diagram") {
          setAskAiTarget({
            kind: "section",
            sectionId: sec.id,
            sectionName: sec.name,
            sectionBody: sec.body_md,
            isDiagram: true,
            diagramMounted: true,
          });
        } else if (sec?.kind === "sheet") {
          setAskAiTarget({
            kind: "section",
            sectionId: sec.id,
            sectionName: sec.name,
            sectionBody: sec.body_md,
            isDiagram: false,
            diagramMounted: false,
            isSheet: true,
            sheetMounted: true,
          });
        } else if (editor && !editor.state.selection.empty) {
          const { from, to } = editor.state.selection;
          const selectedText = editor.state.doc.textBetween(from, to, " ");
          if (selectedText.trim()) {
            setAskAiTarget({
              kind: "selection",
              selectedText: selectedText.trim(),
              from,
              to,
            });
          } else {
            setAskAiTarget({
              kind: "section",
              sectionId: sec?.id ?? "s1",
              sectionName: sec?.name ?? "Section",
              sectionBody: sec?.body_md ?? "",
              isDiagram: false,
              diagramMounted: false,
            });
          }
        } else if (sec) {
          setAskAiTarget({
            kind: "section",
            sectionId: sec.id,
            sectionName: sec.name,
            sectionBody: sec.body_md,
            isDiagram: false,
            diagramMounted: false,
          });
        } else {
          setAskAiTarget({
            kind: "note",
            noteId: activeNote.note.id,
            noteTitle: activeNote.note.title,
          });
        }
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown, true);
      usePresetsStore.getState().clearHovered();
    };
  }, [activeNote, activeSectionId, editor]);

  // 더보기 메뉴 "내용잠금" — useEditor 는 deps 배열이 없어 노트 전환에도 인스턴스가 유지되므로
  // (CLAUDE.md 함정 2: TipTap 인스턴스 수명), useEditor 초기 옵션의 editable 만으로는 노트를
  // 전환해도 안 바뀐다. content_locked 가 바뀔 때마다 setEditable 을 직접 불러 반영한다 — 섹션
  // 추가/삭제(SectionTabBar.tsx)는 별도로 막는다(여기는 본문 타이핑/서식만).
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(!activeNote?.note.content_locked);
  }, [editor, activeNote?.note.content_locked]);

  // switchSection lives here (not in useSectionActions below) because it also drives the note-load
  // effect's kin above and needs bodyCacheRef/setActiveSection/flushRef, all EditorPanel-local. It's
  // still just a plain value — passing it into a hook is fine — but the hook call right below it
  // must sit above the early return, so this does too. `if (!editor) return` substitutes for the
  // narrowing the old post-return position got for free: editor's real nullness is already handled
  // by the early return below, this is only here to satisfy the type checker at this earlier point.
  const switchSection = async (s: Section) => {
    if (!editor) return;
    usePresetsStore.getState().clearHovered();
    // Re-clicking (or re-selecting via keyboard) the already-active tab is a no-op — skip the
    // flush/getHTML/mdSerialize/setContent round-trip entirely instead of reloading identical
    // content.
    if (sectionRef.current?.id === s.id) return;
    // 분리 창은 자기 섹션 하나만 소유한다(배타 소유). 섹션을 바꾸려는 모든 길 — AI 삽입(inserter)·
    // 각주/프리셋 내비게이터·큰 붙여넣기·파일 드롭이 만든 새 섹션 — 이 여기를 지나므로 한 번에 막는다.
    // 새로 생긴 섹션은 본 창에서 보이도록 그 노트를 본 창에 연다(이미 열려 있으면 DB 에서 다시 읽는다).
    if (inDetachedWindow && sectionRef.current) {
      const noteId = useNotesStore.getState().activeNote?.note.id;
      if (noteId) {
        requestOpenNoteInMain(noteId).catch((e) => reportFallback("section_window", "open_in_main_failed", String(e)));
      }
      return;
    }
    // 전환 전 현재 섹션의 미저장 편집을 먼저 flush — 안 하면 700ms 디바운스가
    // 뒤늦게 발화할 때 이미 바뀐 섹션 기준으로 "변경 없음" 판정되어 편집분이 유실된다.
    // (flushRef 자신이 sec.kind==='diagram'이면 아무것도 안 하므로, 다이어그램 탭에서 벗어날
    // 때는 이 호출이 안전한 no-op이다 — DiagramSection이 자기 언마운트 effect에서 따로 flush한다.)
    await flushRef.current();
    if (editor.isDestroyed) return; // await 뒤 — 파괴된 인스턴스의 .commands 는 throw (CLAUDE.md 함정 2)
    const body = bodyCacheRef.current[s.id] ?? s.body_md;
    setActiveSection(s.id, body, s.kind);

    if (s.kind === "diagram") {
      const isEmpty = !body || !body.trim();
      usePresetsStore.getState().setTargetState(isEmpty ? "ready" : "diagram");
    } else if (s.kind === "sheet") {
      const isEmpty = isSheetBodyEmpty(body);
      usePresetsStore.getState().setTargetState(isEmpty ? "ready" : "has_content");
    } else {
      const isEmpty = !body || !body.trim();
      usePresetsStore.getState().setTargetState(isEmpty ? "ready" : "has_content");
    }

    if (s.kind !== "text") return; // Diagram/Sheet sections render body_md themselves — no Tiptap content to load.
    // contentType markdown + emitUpdate: false + baseline — see the note-load effect above.
    paintSectionBody(editor, sectionRef.current, body);
  };

  // Wave R3: handleAddSection/handleDeleteSection/handleReorderSection/handleDropReorder now live in
  // editor/useSectionActions.ts — this (plus the content-lock setEditable effect above) is the last
  // hook call before the early return, which is now the sole thing standing between "last hook" and
  // JSX. A hook landing after the return is no longer just a lint rule to remember: there is nothing
  // left below the return but appendSectionLocally/handleAddDiagramSection (plain functions, not
  // hooks), registrations, and markup, so a stray hook there would be as visually odd as one dropped
  // into the middle of the JSX itself.
  const { appendSectionLocally, handleDeleteSection, handleReorderSection, handleMoveSection } =
    useSectionActions(sectionRef, switchSection, bodyCacheRef);

  // !editor: the Tiptap instance is only ever null before its own async init settles (useEditor's
  // contract) — not a distinct UI state. !activeNote: a transient loading frame (the effect above is
  // already in flight to fill it), same class of early-return.
  if (!editor || !activeNote) return null;

  // AI 드롭다운(TitleBar) 브리지 — "에디터 내용 정리"/"프롬프트 박스"가 결과를 새 탭에 넣을 때
  // handleAddSection과 완전히 같은 경로(section_create* → appendSectionLocally → switchSection)를
  // 타도록 두 콜백을 매 렌더 갱신 등록한다. TitleBar는 형제 컴포넌트라 이 함수들을 직접 호출할
  // 수 없어 lib/aiSectionBridge.ts를 통해서만 이어진다 — switchSection 등 기존 코어 로직은
  // 그대로 호출만 할 뿐 그 정의는 전혀 손대지 않는다(순수 추가).
  // 분리된 섹션은 "활성"이 아니다 — AI 삽입·각주 등이 숨은 에디터에 써 넣고 저장까지 가면 새 창의
  // 편집을 덮는다(배타 소유).
  registerActiveSectionGetter(() => {
    const sec = sectionRef.current;
    return sec && !isSectionDetached(sec.id) ? { id: sec.id, body_md: sec.body } : null;
  });
  // 자동 각주(editor/autoFootnote.ts)는 body_md 스냅샷이 아니라 라이브 문서에 마크를 붙여야 한다 —
  // 위 getter 의 "비텍스트는 산문이 아니다" 판정은 그대로 따른다.
  registerActiveEditor(() =>
    sectionRef.current?.kind === "text" && !isSectionDetached(sectionRef.current.id) ? editor : null,
  );
  registerSectionInserter(async (name, body_md, targetNoteId, kind, aiOrigin) => {
    // targetNoteId is the note the AI request was launched against — never insert into whatever
    // is active at response time (mid-flight note switch). prepareAiInsertNoteId either restores
    // that note (policy a) or abandons with a notice; never quiet-writes to another note.
    const id = await prepareAiInsertNoteId(targetNoteId);
    if (!id) return null;
    const newSec = await call<Section>(
      "section_create_with_body",
      buildAiInsertSectionArgs(id, name, body_md, kind, aiOrigin)
    );
    appendSectionLocally(id, newSec);
    markSnapshotDirty();
    await switchSection(newSec);
    return newSec;
  });

  // handleDeleteSection/handleReorderSection/handleMoveSection — editor/useSectionActions.ts
  // (destructured above, alongside handleAddSection/appendSectionLocally).

  // Selection clipboard — editor/selectionClipboard.ts (BubbleMenu). Right-click selCtx menu
  // (excerpt / ask AI) lives in editor/SelectionContextMenu.tsx.
  const copySelection = () => copyEditorSelection(editor);
  const cutSelection = () => cutEditorSelection(editor);
  const pasteSelection = () => pasteEditorSelection(editor);


  const activeSection = resolveActiveSection(activeNote.sections, activeSectionId ?? undefined);
  const isDetachedActive = !!activeSection && detachedIds.includes(activeSection.id);
  const isDiagramActive = activeSection?.kind === "diagram";
  const isSheetActive = activeSection?.kind === "sheet";

  return (
    <div
      ref={setDropContainerEl}
      style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", height: "100%", position: "relative" }}
      // AI 빛줄기(tokens.css AI-GLOW › BEAM)는 스크롤하지 않는 이 컨테이너에 건다 — 예전처럼 아래
      // 스크롤 컨테이너에 걸면 절대 위치 링이 본문과 함께 스크롤되어 사라진다.
      data-ai-glow={isEditorGlow || undefined} /* "active" | "fading" */
      data-ai-glow-beam="true"
    >
      {/* 파일 드롭존 — 섹션 종류(텍스트/시트/관계도)와 무관하게 이 컨테이너 전체가 항상 하나의
          존이다(탭 바 위도 포함). 존 인스턴스는 반드시 하나여야 겹쳐서 같은 드롭이 두 번
          처리되는 사고를 막는다 — 텍스트 전용이던 예전 위치(스크롤 컨테이너 안)에서 여기로
          옮긴 것이지 추가한 것이 아니다. */}
      <EditorDropOverlay
        editor={editor}
        sectionRef={sectionRef}
        containerEl={dropContainerEl}
        onImported={(s) => void switchSection(s)}
      />
      {/* 섹션 탭 — UI state/menus live in SectionTabBar; editor·flushRef CRUD stays as callbacks.
          분리 창에서는 그리지 않는다(탭 조작은 본 창 몫). */}
      {!inDetachedWindow && <SectionTabBar
        activeNote={activeNote}
        activeSectionId={activeSectionId}
        previewItem={previewItem}
        onSwitchSection={(s) => void switchSection(s)}
        onDeleteSection={(s) => void handleDeleteSection(s)}
        onReorderSection={(s, dir) => void handleReorderSection(s, dir)}
        onMoveSection={(s, targetNoteId) => void handleMoveSection(s.id, targetNoteId)}
        onAskAi={setAskAiTarget}
        onUiBusyChange={setTabUiBusy}
      />}
      <RemoteChangeBanner />
      {isDetachedActive ? (
        <DetachedSectionPlaceholder note={activeNote} section={activeSection} />
      ) : isDiagramActive ? (
        <Suspense fallback={<div style={{ flex: 1 }} />}>
          <DiagramSection key={activeSection.id} section={activeSection} />
        </Suspense>
      ) : isSheetActive ? (
        <Suspense fallback={<div style={{ flex: 1 }} />}>
          <SheetSection key={`${activeSection.id}:${sheetRemount}`} section={activeSection} />
        </Suspense>
      ) : (
        <>

      {/* Toolbar (editor/toolbar/FixedToolbar.tsx) */}
      <FixedToolbar editor={editor} noteId={activeNote.note.id} sectionRef={sectionRef} editorFullWidth={editorFullWidth} />
      <TranslatePanel />
      {/* Selection mini-toolbar (editor/toolbar/TextBubbleMenu.tsx) — appendTo/strategy "fixed"
          instead of the tiptap default (positioned relative to the editor's parent, "absolute")
          because that parent sits inside a backdrop-filter ancestor in acrylic mode, which
          creates a containing block for fixed descendants and would otherwise clip/mis-position
          this against the scroll container instead of the viewport (same reasoning as
          sectionCtx/ContextMenu below). */}
      {TEXT_BUBBLE_ENABLED && (
        <TextBubbleMenu
          editor={editor}
          scrollEl={scrollEl}
          textAnchorRef={textAnchorRef}
          // 렌더링/모달/다른 컨텍스트 메뉴가 열려 있는 동안은 숨긴다. selMenuBusy: 우클릭 메뉴 또는
          // "AI에게 요청하기" PromptDialog (editor/SelectionContextMenu.tsx) — 다이얼로그 뒤의
          // BubbleMenu 재출현 방지(이전 `!!(selCtx || aiAskCtx)` 와 동일).
          hideForOtherUi={!!(tabUiBusy || selMenuBusy || tableMenuBusy)}
          copySelection={copySelection}
          cutSelection={cutSelection}
          pasteSelection={pasteSelection}
        />
      )}

      {/* 2-6: Image selection bubble menu (editor/toolbar/ImageBubble.tsx) */}
      <ImageBubbleMenu editor={editor} scrollEl={scrollEl} />
      {/* Table menu — appears when the caret/selection is inside a table (editor/toolbar/TableMenu.tsx). */}
      <TableBubbleMenu editor={editor} scrollEl={scrollEl} />

      <div
        ref={setScrollEl}
        // editor-desktop scopes the width-toggle CSS (tokens.css) to this desktop surface only —
        // MobileNote.tsx's own `.mdbody` has no `.editor-desktop` ancestor and is untouched.
        // 실험적 — 오너가 보고 뺄 수 있다(2026-09-20): editor-width-narrow/wide 는 editorWidthClassName
        // 이 editorFullWidth 일 때 "" 를 돌려주므로 아예 안 붙는다(JS 레벨 1차 안전장치 — tokens.css
        // 의 소스 순서가 2차). "normal" 은 클래스 없이 기존 800px 규칙 그대로.
        className={`scroll editor-desktop${editorFullWidth ? " editor-fullwidth" : ""}${editorWidthClassName(editorFullWidth, editorWidth)}`}
        // position:relative — anchors the preset hover-preview ghost and drop overlay below
        // to this scroll container instead of the viewport.
        style={{ flex: 1, minHeight: 0, overflow: "auto", cursor: "text", position: "relative" }}
        onClick={(e) => {
          // 외부 링크는 **Ctrl/Cmd+클릭 하나로만** 열린다(오너 2026-09-10). 맨클릭·더블·세번클릭은
          // 전부 편집 동작으로 남는다 — 세번클릭(문단 전체 선택)은 본문 편집에서 자주 쓰는
          // 제스처라 "열기"와 같은 키를 다투게 두지 않는다. Link 확장은 openOnClick:false 라
          // 클릭으로 여는 경로가 애초에 없었고(mdSerialize.ts 의 .configure), 이 분기가 그
          // "열기"를 처음으로 되돌려 놓는다 — 대신 조합키를 요구하는 형태로.
          const httpAnchor = (e.target as HTMLElement).closest?.(
            'a[href^="http://"], a[href^="https://"]',
          ) as HTMLAnchorElement | null;
          if (httpAnchor) {
            // 조합키 없는 클릭은 여기서 확실히 끊는다: 링크가 웹뷰의 기본 활성화로 열려 앱이
            // 그 페이지로 넘어가는 일이 없어야 한다(돌아올 길이 없다).
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) void openExternalUrl(httpAnchor.href);
            else {
              // 실험적 — 오너가 보고 뺄 수 있다(2026-09-20). linkOpenOnClick 프리퍼런스: 조합키
              // 없는 맨 클릭도 연다(드래그 선택 종료·보조클릭·잠긴 노트·링크 편집 UI 는 제외 —
              // shouldOpenLinkOnPlainClick 참고). 이벤트 시점에 getState() 로 읽어 재구독 불필요.
              const sel = window.getSelection();
              if (
                shouldOpenLinkOnPlainClick({
                  pref: useSettingsStore.getState().linkOpenOnClick,
                  button: e.button,
                  editable: editor.isEditable,
                  endsTextSelection: !!sel && !sel.isCollapsed,
                  onLinkEditUi: !!(e.target as HTMLElement).closest?.("[data-editor-pop]"),
                })
              ) {
                void openExternalUrl(httpAnchor.href);
              }
            }
            return;
          }
          // Wiki-link navigation. openOnClick is false on the Link extension (see its
          // .configure comment above) — no link, note:// or otherwise, ever navigates on its
          // own; this is the one explicit, intentional exception, and it never reaches any
          // shell/OS opener (selectNote is a pure in-app store call). A non-note href here is
          // left exactly as inert as before.
          const anchor = (e.target as HTMLElement).closest?.('a[href^="note://"]');
          if (anchor) {
            e.preventDefault();
            const noteId = anchor.getAttribute("href")!.slice("note://".length);
            void (async () => {
              const summary = await fetchNoteSummary(noteId);
              if (!summary) {
                emitNotice(t("attachments.preview_note_unavailable"));
                return;
              }
              await useNotesStore.getState().selectNote(noteId);
            })();
            return;
          }
          editor.commands.focus();
        }}
        onContextMenu={(e) => {
          openTableMenuRef.current?.(e);
          if (!e.defaultPrevented) openSelMenuRef.current?.(e);
        }}
      >
        <EditorContent editor={editor} className="mdbody" style={{ height: "100%" }} />
        <EditorGhostOverlay scrollEl={scrollEl} />
      </div>

      {/* 2-2: Bottom stats bar with verified markdown rules '?' popover */}
      <div className="section-statusbar">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-7)" }}>
          {/* W24: 어시스트+첨부 일괄 접기/펼치기(ㄴ/ㄱ) — 시트/다이어그램 상태줄과 공유. */}
          <BodyCollapseToggle />
          {/* 글자 수·단어 수 — 상태줄의 **한 자리, 한 값**. 예전엔 여기서 매 렌더마다
              `doc.textContent` 로 셌는데 (1) 문단 사이에 구분자가 없어 앞 문단 끝 단어와 뒤 문단 첫
              단어가 한 단어로 붙었고 (2) `.length` 는 UTF-16 단위라 이모지·조합형 글자가 2~여러 자로
              세어졌고 (3) 큰 문서에서 렌더마다 전체 텍스트를 다시 훑었다. WordCountBar 가 디바운스해서
              그레이프임/언어별 단어 경계로 세고, 선택 영역이 있으면 그 수를 보여준다.
              실험적 — 오너가 보고 뺄 수 있다(2026-09-20): `editorWordCount`(기본 켜짐 = 오늘까지처럼
              보인다)를 끄면 이 자리가 비고 리스너도 안 달린다. 설정을 없앨 때는 조건만 지우고
              WordCountBar 는 남긴다 — 위 세 결함을 고친 쪽이 이쪽이다. */}
          {editorWordCount && <WordCountBar editor={editor} />}
          <span>{t("editor.markdown")}</span>
        </div>
        <CheatsheetPopover title={t("editor.cheatsheet_title")} items={verifiedRules()} />
      </div>
        </>
      )}

      <SelectionContextMenu
        editor={editor}
        tabUiBusy={tabUiBusy}
        flush={() => flushRef.current()}
        onBusyChange={setSelMenuBusy}
        openRef={openSelMenuRef}
        onAskAi={(target) => setAskAiTarget(target)}
        onLinkNudge={setLinkNudge}
      />
      <DateEntryPopover noteId={activeNote.note.id} />
      <RegionEntryPopover noteId={activeNote.note.id} />
      {/* 링크 넛지 — 붙여넣기 직후(handleImagePaste)와 링크 우클릭(SelectionContextMenu)이 같은
          상태를 연다. 섹션/시트/관계도 분기 밖에 둔다: 나머지 두 메뉴와 같은 자리다. */}
      <LinkNudge ctx={linkNudge} onClose={() => setLinkNudge(null)} />
      <TableContextMenu
        editor={editor}
        disabled={tabUiBusy || selMenuBusy}
        openRef={openTableMenuRef}
        onBusyChange={setTableMenuBusy}
      />

      {askAiTarget && (
        <Suspense fallback={null}>
          <AskAiModal target={askAiTarget} onClose={() => setAskAiTarget(null)} />
        </Suspense>
      )}
    </div>
  );
}
