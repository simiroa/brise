/**
 * Live-editor footnote mark (Wave 4 L2).
 *
 * body_md wire format SSOT is `BriseFootnote` in `src/lib/mdSerialize.ts`:
 *   `<span data-footnote="<attachment-id>">anchored text</span>`
 *
 * Prefer re-export of that mark so live editor + headless serialize never drift.
 * `FootnoteMark` is a thin extend: same name/attrs/parse/renderMarkdown, plus
 * click → preview panel signal and a visible DOM class (style only; not on disk).
 */
import { mergeAttributes, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { BriseFootnote } from "../../lib/mdSerialize";
import { call, emitNotice } from "../../lib/invoke";
import type { Attachment } from "../../lib/commands.gen";
import { useNotesStore } from "../../stores/notes";
import { navigateToSection } from "../../lib/presetBridge";
import { useUiStore } from "../../stores/ui";
import { useAiStore } from "../../stores/ai";
import { useSettingsStore } from "../../stores/settings";
import type { PromptDialogAssistAction } from "../PromptDialog";
import { t } from "../../i18n/t";

/** Schema SSOT — re-export so callers import from one place. */
export { BriseFootnote };

const footnoteClickKey = new PluginKey("briseFootnoteClick");
const footnoteHotKey = new PluginKey("briseFootnoteHot");

/* ── 각주 앵커 찾기 · hover/점프 브리지 ──────────────────────────────────────────────
 * FootnotePreview(프리뷰 패널의 각주 목록)와 라이브 에디터는 형제라 prop 경로가 없다 —
 * lib/aiSectionBridge.ts / lib/presetBridge.ts 와 같은 모듈 레벨 pub/sub 로 잇는다.
 * 앵커 위치 계산은 이 파일 하나가 소유한다(hover 가시성 판정·점프 스크롤 둘 다 같은 함수).
 */

export const FOOTNOTE_HOT_CLASS = "brise-footnote--hot";
/** 점프 후 잠깐 켜지는 강조 시간(ms). hover 강조는 시간 제한이 없다. */
export const FOOTNOTE_FLASH_MS = 1200;

// 데코레이션 spec 은 class 와 style 둘 다 싣는다 — brise-footnote 자체가 tokens.css 가 아니라
// renderHTML 인라인 스타일로 칠해지므로(이 파일 아래 참고) 강조도 같은 자리에 둔다. class 는
// 테스트/디버깅용 훅.
const HOT_DECORATION_SPEC = {
  class: FOOTNOTE_HOT_CLASS,
  style: "background-color:color-mix(in srgb, var(--accent) 25%, transparent);border-radius:3px;",
};

/**
 * 문서 안에서 attrs.id === id 인 footnote 마크가 붙은 텍스트 노드 범위들. 한 앵커가 여러 텍스트
 * 노드로 쪼개져 있을 수 있어(부분 볼드 등) 배열 — 강조는 전부, 스크롤은 [0] 기준.
 * 빈 배열 = 이 문서(=현재 보이는 섹션)에 그 앵커가 없다.
 */
export function findFootnoteRanges(doc: PMNode, id: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    if (node.marks.some((m) => m.type.name === "footnote" && m.attrs.id === id)) {
      out.push({ from: pos, to: pos + node.nodeSize });
    }
    return true;
  });
  return out;
}

/**
 * `term` 과 **글자 그대로** 일치하면서 아직 각주가 붙지 않은 첫 구간. null = 없음(모델이 지어낸
 * 단어이거나, 이미 각주가 달린 단어). findFootnoteRanges 의 역방향이라 같은 자리에 둔다 —
 * 앵커 위치 계산은 이 파일 하나가 소유한다.
 *
 * 각주 마크는 텍스트 노드 단위로 붙으므로, footnote 마크를 가진 노드는 통째로 건너뛴다
 * (= "이미 각주가 달린 단어는 건드리지 않는다").
 *
 * ponytail: 텍스트 노드 하나 안에 온전히 들어있는 경우만 찾는다 — 단어 일부만 볼드인 식으로
 * 노드가 쪼개져 있으면 그 단어는 조용히 건너뛴다(자동 각주는 못 찾은 단어를 무시하면 그만).
 * 업그레이드 경로는 블록별 textBetween 으로 평문을 만들고 오프셋→pos 로 되돌리는 것.
 */
export function findUnmarkedTermRange(
  doc: PMNode,
  term: string,
): { from: number; to: number } | null {
  const needle = term.trim();
  if (!needle) return null;
  // 배열로 받는 이유: 콜백 안에서만 대입되는 지역 변수는 TS 흐름 분석이 null 로 좁혀버린다.
  const hit: { from: number; to: number }[] = [];
  doc.descendants((node, pos) => {
    if (hit.length) return false;
    if (!node.isText || !node.text) return true;
    if (node.marks.some((m) => m.type.name === "footnote")) return true;
    const idx = node.text.indexOf(needle);
    if (idx < 0) return true;
    hit.push({ from: pos + idx, to: pos + idx + needle.length });
    return false;
  });
  return hit[0] ?? null;
}

/**
 * body_md 안에서 그 앵커를 담고 있는 섹션 id. 직렬화 형태는 BriseFootnote.renderMarkdown 의
 * `<span data-footnote="...">` 하나뿐이라 문자열 검색으로 충분하다(같은 이스케이프 적용).
 */
export function findFootnoteSectionId(
  sections: { id: string; body_md: string }[],
  id: string,
): string | null {
  const needle = `data-footnote="${String(id).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
  return sections.find((s) => s.body_md.includes(needle))?.id ?? null;
}

let hoveredId: string | null = null;
let flashId: string | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;
let revealSeq = 0;
const signalListeners = new Set<() => void>();

function emitFootnoteSignal(): void {
  for (const fn of [...signalListeners]) fn();
}

/** 에디터 쪽 플러그인이 구독한다. 테스트에서도 쓰므로 export. */
export function subscribeFootnoteSignal(fn: () => void): () => void {
  signalListeners.add(fn);
  return () => {
    signalListeners.delete(fn);
  };
}

/** 지금 강조되어야 할 각주 id — hover 가 flash 를 이긴다. */
export function hotFootnoteId(): string | null {
  return hoveredId ?? flashId;
}

/**
 * 목록 항목 hover 진입/이탈. **언마운트에서도 반드시 null 로 되돌린다**(FootnotePreview 의
 * cleanup effect) — 프리셋 브리지가 정리 없이 새어 나갔던 사고와 같은 부류.
 * 다른 섹션의 앵커를 hover 해도 아무 일도 일어나지 않는다: 현재 문서에 그 마크가 없으면
 * findFootnoteRanges 가 빈 배열이라 데코레이션이 0개다(hover 로는 섹션을 넘기지 않는다).
 */
export function setHoveredFootnote(id: string | null): void {
  if (hoveredId === id) return;
  hoveredId = id;
  emitFootnoteSignal();
}

/**
 * 목록 항목 클릭 → 에디터를 그 앵커로 이동시킨다.
 * 섹션 판정은 store 의 body_md 로 한다. 활성 섹션의 store 사본은 타이핑 중 낡을 수 있지만
 * (CLAUDE.md 함정 4: updateSectionBody 는 activeNote.sections 를 일부러 갱신하지 않는다)
 * 각주 생성 경로가 항상 reloadActive() 로 끝나므로 앵커는 언제나 store 사본에 들어있다.
 * 어디에서도 못 찾으면 섹션 전환 없이 그대로 요청만 보낸다 — 활성 섹션 라이브 문서에만 있고
 * store 사본이 낡은 경우가 여기서 구제된다.
 * ponytail: 앵커를 잘라 다른 섹션에 붙여넣고 아직 저장 전이면(양쪽 store 사본이 모두 낡음)
 * 엉뚱한 탭으로 넘어갔다가 조용히 no-op 한다. 천장은 거기까지고, 업그레이드 경로는
 * EditorPanel 의 bodyCacheRef(섹션별 최신 라이브 본문)를 이 판정에 넘겨주는 것.
 */
export async function revealFootnoteInEditor(id: string): Promise<void> {
  const sections = useNotesStore.getState().activeNote?.sections ?? [];
  const sectionId = findFootnoteSectionId(sections, id);
  // navigateToSection → EditorPanel 의 switchSection: 이미 활성인 섹션이면 스스로 no-op 한다.
  if (sectionId) await navigateToSection(sectionId);
  flashId = id;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashTimer = null;
    flashId = null;
    emitFootnoteSignal();
  }, FOOTNOTE_FLASH_MS);
  revealSeq += 1;
  emitFootnoteSignal();
}

function scrollToFootnote(view: EditorView, id: string): void {
  const ranges = findFootnoteRanges(view.state.doc, id);
  // 앵커가 이 문서에 없다(마크가 지워졌거나 섹션 전환이 실패했다) — 조용히 아무것도 안 한다.
  if (!ranges.length) return;
  // 접힌 selection: 앵커 텍스트를 통째로 선택하면 TextBubbleMenu 가 떠서 점프가 시끄러워진다.
  const tr = view.state.tr
    .setSelection(TextSelection.create(view.state.doc, ranges[0].from))
    .scrollIntoView();
  view.dispatch(tr);
}

function buildHotDecorations(doc: PMNode, id: string | null): DecorationSet {
  if (!id) return DecorationSet.empty;
  const ranges = findFootnoteRanges(doc, id);
  if (!ranges.length) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    ranges.map((r) => Decoration.inline(r.from, r.to, HOT_DECORATION_SPEC)),
  );
}

/**
 * Live mark registered in the editor. Wire format identical to BriseFootnote
 * (name `"footnote"`, attr `id` ↔ `data-footnote`, renderMarkdown HTML island).
 * Class/style on renderHTML are DOM-only — getMarkdown still uses inherited renderMarkdown.
 */
export const FootnoteMark = BriseFootnote.extend({
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "brise-footnote",
        // Inline so no shared tokens.css edit is required (that file is not L2-owned).
        // Dotted underline + accent reads as a footnote anchor without a separate superscript node.
        // transition: hover/점프 강조(HOT_DECORATION_SPEC)가 부드럽게 켜지도록 base 쪽에 둔다 —
        // 데코레이션이 붙는 시점에 transition 을 같이 주면 첫 프레임이 이미 최종색이라 안 먹는다.
        style:
          "cursor:pointer;text-decoration:underline dotted;color:var(--accent);" +
          "transition:background-color var(--dur-med) ease;",
      }),
      0,
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: footnoteClickKey,
        props: {
          // Reveal footnote in the preview panel. Return false so the caret still moves —
          // same "signal only" posture as AttachmentsBar tile click → setPreviewItem.
          // 목록 뷰 하나만 존재하므로 focusId 로 "열고 그 항목으로 스크롤+강조"를 요청한다.
          handleDOMEvents: {
            click(_view, event) {
              const el = (event.target as HTMLElement | null)?.closest?.(
                "span[data-footnote]",
              ) as HTMLElement | null;
              if (!el) return false;
              const id = el.getAttribute("data-footnote");
              if (!id) return false;
              useUiStore.getState().setPreviewItem({ kind: "footnotes", focusId: id });
              return false;
            },
          },
        },
      }),
      // hover/점프 강조 — DOM classList 를 직접 만지는 대신 데코레이션인 이유: 마크 span 은
      // ProseMirror 가 소유해서 (타이핑·setContent 등) 재렌더 때마다 수동으로 붙인 class 가
      // 조용히 날아간다. 데코레이션은 문서 상태에서 매번 다시 계산되므로 그 문제가 없다.
      // 이 확장을 쓰는 에디터(EditorPanel·MobileNote·SectionPreview)마다 플러그인이 하나씩 붙어
      // 각자 자기 문서만 본다 — 앵커가 없는 문서는 데코레이션 0개라 그냥 조용하다.
      new Plugin({
        key: footnoteHotKey,
        state: {
          init: () => ({ id: null as string | null, decos: DecorationSet.empty }),
          apply: (tr, prev: { id: string | null; decos: DecorationSet }) => {
            const meta = tr.getMeta(footnoteHotKey) as { id: string | null } | undefined;
            if (!meta && (!tr.docChanged || !prev.id)) return prev;
            const id = meta ? meta.id : prev.id;
            return { id, decos: buildHotDecorations(tr.doc, id) };
          },
        },
        props: {
          // key 경유 — this 바인딩은 @tiptap/pm 버전에 따라 불안정하다(emojiExtension.ts 주석).
          decorations(state) {
            return (footnoteHotKey.getState(state) as { decos: DecorationSet } | undefined)?.decos;
          },
        },
        view(view) {
          // 마운트 시점의 seq 를 기준선으로 — 이전에 쌓인 점프 요청을 뒤늦게 재생하지 않는다.
          let seenSeq = revealSeq;
          const sync = () => {
            const want = hotFootnoteId();
            const cur =
              (footnoteHotKey.getState(view.state) as { id: string | null } | undefined)?.id ?? null;
            if (want !== cur) view.dispatch(view.state.tr.setMeta(footnoteHotKey, { id: want }));
            if (revealSeq !== seenSeq) {
              seenSeq = revealSeq;
              if (flashId) scrollToFootnote(view, flashId);
            }
          };
          const unsubscribe = subscribeFootnoteSignal(sync);
          return { destroy: unsubscribe };
        },
      }),
    ];
  },
});

/**
 * Create a footnote attachment then apply the mark on a captured selection range.
 * Shared by TextBubbleMenu + SelectionContextMenu so both paths stay identical.
 *
 * After any await, checks `editor.isDestroyed` before editor.commands (CLAUDE.md).
 */
export async function applyFootnoteFromSelection(
  editor: Editor,
  range: { from: number; to: number },
  bodyText: string,
): Promise<void> {
  const text = bodyText.trim();
  if (!text) return;

  const anchorText = editor.state.doc.textBetween(range.from, range.to, "\n");
  if (!anchorText.trim()) return;

  const noteId = await useNotesStore.getState().ensureMaterialized();
  if (!noteId) {
    emitNotice(t("editor.note_required_for_section"));
    return;
  }

  // Generated input: anchor_text is `string?` (optional) — always have selection text here.
  let att: Attachment;
  try {
    att = await call<Attachment>("attachment_add_footnote", {
      note_id: noteId,
      text,
      anchor_text: anchorText,
    });
  } catch {
    // call() already toasted AppError
    return;
  }

  if (editor.isDestroyed) return;

  editor
    .chain()
    .focus()
    .setTextSelection({ from: range.from, to: range.to })
    .setMark("footnote", { id: att.id })
    .run();

  // reloadActive() flushes the pending autosave debounce (registerFlush → flushRef, which reads
  // the CURRENT editor doc via mdSerializeEditor — already includes the mark just applied above)
  // before re-fetching, then repaints from that fresh body_md — same ordering EditorPanel's
  // pasteImageFile path uses after .setImage().run(). Without this, note_get would race the 700ms
  // debounce and refetch the pre-mark body, silently dropping the footnote mark on repaint. Also
  // the only way the new attachment reaches AttachmentsBar/previewResolver (both read
  // activeNote.attachments, which attachment_add_footnote alone never refreshes).
  await useNotesStore.getState().reloadActive();
}

function footnoteTargetLangLabel(uiLang: string): string {
  if (uiLang === "ko") return "한국어";
  if (uiLang === "fr") return "français";
  return "English";
}

const FOOTNOTE_EXPLAIN_PROMPT =
  "아래 텍스트(각주를 달려는 단어나 구절)가 무엇을 뜻하는지 간결하게 설명하세요. 각주 본문에 바로 쓸 수 있도록 " +
  "1~3문장으로만 답하고, 설명 외의 서론·맺음말은 붙이지 마세요.";

/**
 * Footnote dialog's "번역"/"설명" quick actions — shared by TextBubbleMenu + SelectionContextMenu
 * so both call sites' AI wiring can't drift (same reasoning as applyFootnoteFromSelection above).
 * `aiAvailable` is the caller's already-refreshed translate-gate check (stores/ai.ts's
 * translateGateOk) — undefined here (not an empty array) so PromptDialog renders no assist row
 * at all rather than a row of buttons that would just fail quietly on click.
 */
export function buildFootnoteAssistActions(
  anchorText: string,
  aiAvailable: boolean,
): PromptDialogAssistAction[] | undefined {
  const text = anchorText.trim();
  if (!aiAvailable || !text) return undefined;
  return [
    {
      key: "translate",
      label: t("ai.translate"),
      run: () => {
        const lang = footnoteTargetLangLabel(useSettingsStore.getState().uiLang);
        const prompt =
          `다음 텍스트를 ${lang}로 자연스럽게 번역하세요. 번역 결과만 출력하고 설명·따옴표·부연은 붙이지 마세요.\n\n${text}`;
        return useAiStore.getState().generateFromPrompt(prompt, null);
      },
    },
    {
      key: "explain",
      label: t("editor.footnote_ai_explain"),
      run: () => useAiStore.getState().generateFromPrompt(FOOTNOTE_EXPLAIN_PROMPT, text),
    },
  ];
}
