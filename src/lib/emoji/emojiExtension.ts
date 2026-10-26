import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { bundledKeyFor, emojiSrc } from "./emojiCore";

export const EMOJI_STYLE_META = "EMOJI_STYLE_CHANGED";

// Why a decoration plugin, not an emoji node: the doc stays pure unicode text, so save
// (mdSerialize)/reload (setContent) need zero emoji-awareness and render is identical whether the
// emoji was just picked or loaded from body_md. A node would only re-render styled if its parseHTML
// matched the stored markup — but we store the bare glyph, which setContent feeds back as text, so
// nodes would silently revert to the OS glyph after a reload.

const key = new PluginKey("brise-emoji");

// Grapheme segmenter groups ZWJ/skin-tone sequences into one unit so multi-codepoint emoji key
// correctly. WebView2 (Chromium) has Intl.Segmenter; guard anyway for non-Tauri test envs. Typed
// locally because the project's TS lib target predates the Intl.Segmenter declarations.
interface Segmenter {
  segment(input: string): Iterable<{ segment: string; index: number }>;
}
const IntlSeg = Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => Segmenter };
const seg: Segmenter | null = IntlSeg.Segmenter
  ? new IntlSeg.Segmenter(undefined, { granularity: "grapheme" })
  : null;

// Fast pre-check so we only segment text that actually contains a pictographic char.
const PICTO = /\p{Extended_Pictographic}/u;

// ponytail: W2-fallback (WORKORDER-2026-08-23 Q1 owner decision).
// Editor inline emoji decorations (Fluent SVG widgets over font-size:0 glyphs) cause two distinct issues:
// 1) Caret & Selection Loss: font-size:0 collapses glyph geometry to zero width, making text selection
//    highlight invisible and caret placement immediately after an emoji impossible.
//    Candidate (a) [background-image on inline span with color:transparent] fails in Chromium/WebView2
//    because COLRv0/COLRv1 Segoe UI Emoji ignores text color transparency and superimposes both glyph and SVG.
//    Candidate (b) [visibility:hidden] preserves box size but Chromium suppresses ::selection highlight.
//    Candidate (c) [opacity:0 on glyph] also renders selection highlight transparent (invisible).
// 2) Performance: Typing in paragraphs with dozens/hundreds of emoji incurred O(emoji_count) Intl.Segmenter
//    rescan and DOM widget reconstruction on every keystroke.
// Per owner decision, editor body falls back cleanly to OS native glyphs (pure unicode in doc).
// Note tree icons (.em-img--tree) and EmojiPicker remain styled because they are outside contenteditable.
export const ENABLE_EDITOR_EMOJI_DECORATIONS = false;

export function scanEmojiDecorations(doc: PMNode, fromPos = 0, toPos = doc.content.size): Decoration[] {
  if (!ENABLE_EDITOR_EMOJI_DECORATIONS || !seg) return [];
  const decos: Decoration[] = [];
  doc.nodesBetween(fromPos, toPos, (node, pos) => {
    if (!node.isText || !node.text || !PICTO.test(node.text)) return;
    const text = node.text;
    for (const { segment, index } of seg.segment(text)) {
      if (!PICTO.test(segment)) continue;
      const matched = bundledKeyFor(segment);
      if (!matched) continue; // not a known emoji key → leave native glyph
      const srcUrl = emojiSrc(matched);
      if (!srcUrl) continue; // not bundled and no downloaded Color pack → leave native glyph

      const from = pos + index;
      const to = from + segment.length;
      // Collapse the real glyph (kept in the doc for editing/serialization) and float the SVG/PNG.
      decos.push(Decoration.inline(from, to, { class: "em-hide" }));
      decos.push(
        Decoration.widget(
          from,
          () => {
            const img = document.createElement("img");
            img.src = srcUrl;
            img.className = "em-img";
            img.alt = segment;
            img.draggable = false;
            img.setAttribute("contenteditable", "false");
            return img;
          },
          { side: -1, key: `em:${matched}` }
        )
      );
    }
  });
  return decos;
}

export function buildDecorations(doc: PMNode): DecorationSet {
  if (!seg) return DecorationSet.empty;
  return DecorationSet.create(doc, scanEmojiDecorations(doc));
}

function updateDecorations(tr: Transaction, old: DecorationSet): DecorationSet {
  if (!seg) return DecorationSet.empty;
  if (!tr.docChanged) return old;

  // Map existing decorations through step mapping in O(log N)
  let set = old.map(tr.mapping, tr.doc);

  // For each changed step range, recompute only in the affected block boundaries
  for (const stepMap of tr.mapping.maps) {
    stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const docSize = tr.doc.content.size;
      const safeStart = Math.min(Math.max(0, newStart), docSize);
      const safeEnd = Math.min(Math.max(safeStart, newEnd), docSize);

      const $from = tr.doc.resolve(safeStart);
      const $to = tr.doc.resolve(safeEnd);
      const blockStart = $from.start($from.depth);
      const blockEnd = $to.end($to.depth);

      const oldDecosInBlock = set.find(blockStart, blockEnd);
      if (oldDecosInBlock.length > 0) {
        set = set.remove(oldDecosInBlock);
      }

      const newDecos = scanEmojiDecorations(tr.doc, blockStart, blockEnd);
      if (newDecos.length > 0) {
        set = set.add(tr.doc, newDecos);
      }
    });
  }

  return set;
}

export const EmojiRender = Extension.create({
  name: "emojiRender",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: (_, { doc }) => buildDecorations(doc),
          apply: (tr, old) => {
            if (tr.getMeta(EMOJI_STYLE_META)) {
              return buildDecorations(tr.doc);
            }
            if (tr.docChanged) {
              return updateDecorations(tr, old);
            }
            return old;
          },
        },
        props: {
          decorations(state) {
            // via the key (not `this.getState`) — `this` binding in the decorations prop is not
            // reliable across @tiptap/pm versions and silently yields no decorations when wrong.
            return key.getState(state);
          },
        },
      }),
    ];
  },
});
