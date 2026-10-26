/**
 * PLAN-2026-09-18-nl-dates.md §W3b — typing nudge chip. **Live editor only**: registered in
 * EditorPanel.tsx's `useEditor({ extensions: [...] })` list next to SlashCommand/WikiLink, never
 * in editorExtensions.ts's `PREVIEW_EXTENSIONS` (that list is shared with the read-only preview
 * panel and MobileNote — this in-document chip/Decoration must never be there). 폰 에디터의 같은 기능은
 * 문서 밖 칩 줄(MobileInputChips)로 따로 들어간다 — docs/PLAN-2026-10-07-mobile-typing-nudges.md
 * (판정은 lib/typingNudges.ts 의 순수 함수를 공유하고, 페이로드는 lib/noteDatePayload.ts 를 같이 쓴다).
 *
 * Flow: every doc change resets a ~700ms debounce (mirrors EditorPanel's own autosave debounce).
 * When the doc goes quiet, the plugin reparses ONLY the textblock (paragraph) the caret currently
 * sits in — never the whole document, so opening an old note never lights up unrelated paragraphs
 * (`state.doc.resolve(selection.from)` → that block's start/end → `textBetween`). A high-confidence
 * `parseNlDate` (§W1) match that doesn't already overlap a `date` mark (§W3a) becomes a "candidate";
 * once the caret has moved past the matched span (not while it's still inside — the user may still
 * be editing it), the whole textblock gets a soft highlight and a single "일정으로 등록" bubble
 * (`Decoration.widget`) appears at the line's end. 2026-09-19 후속(오너): the chip used to sit right
 * after the matched date span and echo it ("12.11 · 등록") — read as "only the date gets
 * registered", when `note_date_add`'s payload actually carries the rest of the line as the title
 * too (`buildNoteDateAddPayload`'s `label`). Framing the full line + a plain action bubble (no
 * repeated date text — it's already sitting right there in the body) says "this whole line" instead.
 * Any further doc change, the caret leaving the paragraph, or Escape dismisses it — a fresh debounce
 * cycle re-shows it later if still warranted, so no separate long-lived dismiss state is kept (plan
 * doc's own framing: "다음 디바운스 사이클이 다시 필요하면 다시 띄운다").
 *
 * Accept (click, no popover — D4): mirrors autoFootnote.ts's "find range → call → setMark" idiom —
 * `note_date_add` (remind: true per D4), then `DateMark` on the matched range, then
 * `showUndoToast`. The undo callback is a special case vs. dateWrite.ts's usual "undo = rewrite the
 * row" idiom: since this undo is unwinding a link *this nudge itself just created* (not a generic
 * delete elsewhere), it also strips the `date` mark it just applied — CLAUDE.md 함정 9 / plan doc's
 * own note that W3a's "dangling marks are fine" posture doesn't apply to undoing your own action.
 *
 * §W4 (PLAN-2026-09-18-nl-dates.md) — full-auto opt-in (`date_nudge_auto` / `dateNudgeAuto`,
 * default OFF). When on, `buildDecos` never builds the chip widget (so nothing ever flashes on
 * screen), and the plugin's `view().update()` edge-detects the same `shown` transition
 * (false→true) that would otherwise reveal the chip and calls `acceptCandidate` directly — same
 * function the click handler uses, so `showUndoToast` (and its mark-stripping undo) still applies.
 * "Auto" only skips the confirm step, not the safety net (D4: 완전 자동은 확인 절차 생략이지
 * 되돌리기까지 없앤다는 뜻이 아니다). The trigger is deferred one tick (`setTimeout(..., 0)`)
 * rather than dispatched synchronously from inside `update()` — same reasoning as this file's own
 * debounce timer: avoid re-entrant `view.dispatch()` calls from within ProseMirror's own update
 * cycle. A staleness check (`nudgeKey.getState(view.state) !== cur`, the plugin-state object
 * captured when the tick was scheduled) skips the call if another transaction already changed the
 * nudge state by the time the tick fires.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { parseNlDate, type NlDateParseResult, type NlDateLocale } from "../../lib/nlDate";
import { findDateMarkRanges } from "./dateMark";
import { getActiveEditor } from "../../lib/aiSectionBridge";
import { useSettingsStore } from "../../stores/settings";
import { useNotesStore } from "../../stores/notes";
import { call } from "../../lib/invoke";
import type { NoteDateAddInput } from "../../lib/commands.gen";
import { bumpNoteQueryVersion } from "../../lib/noteQuery";
import { showUndoToast } from "../../lib/undo";
import { buildNoteDateAddPayload } from "../../lib/noteDatePayload";
import { t } from "../../i18n/t";

const DEBOUNCE_MS = 700;
const nudgeKey = new PluginKey<NudgeState>("briseDateNudge");

/** Mirrors SelectionContextMenu.tsx's `uiLangToNlDateLocale` (same tiny mapping). Kept as a local
 *  copy rather than an import so this plugin file doesn't pull in that large component module. */
function uiLangToNlDateLocale(uiLang: string): NlDateLocale {
  return uiLang === "ko" || uiLang === "fr" ? uiLang : "en";
}

interface NudgeCandidate {
  /** Textblock (paragraph) bounds this candidate was parsed from — used to detect "caret left the
   *  paragraph" (dismiss) without re-parsing. */
  blockFrom: number;
  blockTo: number;
  /** Absolute doc positions of the matched date/time span. */
  matchFrom: number;
  matchTo: number;
  parsed: NlDateParseResult;
}

interface NudgeState {
  candidate: NudgeCandidate | null;
  /** Candidate exists but caret is still inside matchRange — parsed, not yet shown. */
  shown: boolean;
  decos: DecorationSet;
  /** 2026-09-19 후속(검증 중 발견) — 이 상태를 낳은 docChanged 트랜잭션이 TipTap의
   *  `setContent(..., { emitUpdate: false })`(노트 열기/전환, MARKDOWN_SET_CONTENT_OPTIONS)였는지.
   *  true면 `view().update()`가 디바운스를 아예 걸지 않는다 — 안 그러면 옛 노트를 열었을 때
   *  캐럿이 우연히 미등록 날짜 문구 위에 놓이면 타이핑을 한 글자도 안 했는데 700ms 뒤 유령
   *  넛지가 뜬다("타이핑 중" 설계 의도와 어긋남). 진짜 사용자 입력 트랜잭션은 `preventUpdate`
   *  메타가 없으므로(TipTap 코어: `tr.setMeta("preventUpdate", !emitUpdate)`) 평소 흐름은
   *  그대로다. */
  suppressDebounce: boolean;
}

type NudgeMeta = { type: "dismiss" } | { type: "result"; candidate: NudgeCandidate | null };

const EMPTY_STATE: NudgeState = {
  candidate: null,
  shown: false,
  decos: DecorationSet.empty,
  suppressDebounce: false,
};

function computeShown(caretPos: number, candidate: NudgeCandidate): boolean {
  return caretPos >= candidate.matchTo;
}

/**
 * Click handler — runs outside any ProseMirror transaction lifecycle (async), so every doc access
 * after the first `await` goes through `getActiveEditor()` + `editor.isDestroyed` (CLAUDE.md 함정
 * 2), never the `view` captured at widget-build time.
 */
function acceptCandidate(candidate: NudgeCandidate, view: EditorView): void {
  // Hide immediately — the user already acted on it; don't leave a stale chip visible during the
  // await, and a second click can't double-submit.
  if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(nudgeKey, { type: "dismiss" } as NudgeMeta));

  const editor = getActiveEditor();
  const noteId = useNotesStore.getState().activeNote?.note.id;
  if (!editor || !noteId) return;

  const { parsed, matchFrom, matchTo } = candidate;
  const payload: NoteDateAddInput = { note_id: noteId, ...buildNoteDateAddPayload(parsed) };

  void (async () => {
    let res: { id: string };
    try {
      // call()'s signature takes Record<string, unknown> — NoteDateAddInput has no index
      // signature of its own, same reason every other call() site in this codebase either inlines
      // a literal or (like here) casts a built-up typed object at the boundary.
      res = await call<{ id: string }>("note_date_add", payload as unknown as Record<string, unknown>);
    } catch {
      // call() already toasted AppError.
      return;
    }
    if (editor.isDestroyed) return;

    const docSize = editor.state.doc.content.size;
    const from = Math.min(matchFrom, docSize);
    const to = Math.min(matchTo, docSize);
    if (from < to) {
      // autoFootnote.ts's range→mark idiom.
      editor.chain().setTextSelection({ from, to }).setMark("date", { id: res.id }).run();
    }
    bumpNoteQueryVersion();

    const dateId = res.id;
    showUndoToast(t("editor.date_nudge_undo_label"), () => {
      void (async () => {
        if (!editor.isDestroyed) {
          // Unlike W3a's general "dangling marks are fine" posture, THIS undo is unwinding a mark
          // this nudge itself just created — strip it so no dangling mark is left behind.
          const ranges = findDateMarkRanges(editor.state.doc, dateId);
          if (ranges.length) {
            let chain = editor.chain();
            for (const r of ranges) chain = chain.setTextSelection(r).unsetMark("date");
            chain.run();
          }
        }
        try {
          await call("note_date_remove", { id: dateId });
          bumpNoteQueryVersion();
        } catch {
          // call() already toasted.
        }
      })();
    });
  })();
}

function buildChipDom(candidate: NudgeCandidate, view: EditorView): HTMLElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.setAttribute("data-testid", "date-nudge-chip");
  chip.className = "brise-date-nudge-chip";
  chip.textContent = t("editor.date_nudge_bubble_label");
  chip.style.cssText =
    // type-scale-exempt: cssText 문자열이라 var(--space-2)/line-height:1.6 을 생값으로 오탐한다
    "display:inline-flex;align-items:center;margin-left:var(--space-1);padding:0 var(--space-2);line-height:1.6;" +
    "border-radius:var(--radius-sm);font-size:0.85em;cursor:pointer;user-select:none;" +
    "vertical-align:baseline;white-space:nowrap;" +
    "background:color-mix(in srgb, var(--info) 16%, transparent);color:var(--info);" +
    "border:1px solid color-mix(in srgb, var(--info) 35%, transparent);";
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  chip.addEventListener("mousedown", stop);
  chip.addEventListener("click", (e) => {
    stop(e);
    acceptCandidate(candidate, view);
  });
  return chip;
}

function buildDecos(doc: PMNode, candidate: NudgeCandidate | null, shown: boolean): DecorationSet {
  if (!candidate || !shown) return DecorationSet.empty;
  // 오너 결정(2026-09-20) — dateNudgeEnabled=false 는 dateNudgeAuto 보다 우선("off" beats
  // "auto"): 꺼져 있으면 자동 등록도 칩도 전부 없다. 아래 auto 검사보다 먼저 두는 것 자체가 그
  // 우선순위를 코드로 표현한다. 방어선 — 정상 경로는 아래 view().update()의 첫 줄이 더 일찍
  // 막아 이 지점까지 오지 않는다(파싱 자체를 안 한다).
  if (!useSettingsStore.getState().dateNudgeEnabled) return DecorationSet.empty;
  // §W4 — full-auto mode never shows the chip: view().update() edge-detects this same `shown`
  // transition and calls acceptCandidate directly instead (see file header comment).
  if (useSettingsStore.getState().dateNudgeAuto) return DecorationSet.empty;
  const { blockFrom, blockTo, matchFrom, matchTo } = candidate;
  return DecorationSet.create(doc, [
    // 오너 2026-09-19: 매치된 날짜 구간에만 붙는 칩("12.11 · 등록")은 날짜만 등록되는 느낌을
    // 줬다 — 실제로는 buildNoteDateAddPayload 가 문단 나머지를 제목(label)으로도 함께 보낸다.
    // 매치 구간이 아니라 문단 전체(blockFrom~blockTo)를 은은하게 감싸 "이 줄 전체가 후보"임을
    // 보여주고, 버블은 줄 끝(blockTo)에 하나만 둔다 — 날짜 재표기(중복) 없이 순수 CTA.
    Decoration.inline(blockFrom, blockTo, {
      style:
        "background:color-mix(in srgb, var(--info) 10%, transparent);border-radius:var(--radius-sm);",
      "data-testid": "date-nudge-line-frame",
    }),
    Decoration.widget(blockTo, (view) => buildChipDom(candidate, view), {
      side: 1,
      // Let our own DOM listeners fully own clicks inside the chip instead of ProseMirror trying
      // to resolve a caret position from the event first.
      stopEvent: () => true,
      key: `date-nudge:${matchFrom}:${matchTo}`,
    }),
  ]);
}

/** Reparse the caret's own textblock and dispatch the result (or a clearing null). Reads
 *  `view.state` fresh at call time (fired from a timer, not a closured stale state). */
function runParse(view: EditorView): void {
  if (view.isDestroyed) return;
  const { state } = view;
  const $pos = state.doc.resolve(state.selection.from);
  if (!$pos.parent.isTextblock) return;
  const blockFrom = $pos.start();
  const blockTo = $pos.end();
  const text = state.doc.textBetween(blockFrom, blockTo, "\n", "\n");

  let candidate: NudgeCandidate | null = null;
  if (text.trim()) {
    const locale = uiLangToNlDateLocale(useSettingsStore.getState().uiLang);
    const parsed = parseNlDate(text, locale);
    if (parsed && parsed.confidence === "high") {
      const matchFrom = blockFrom + parsed.matchRange[0];
      const matchTo = blockFrom + parsed.matchRange[1];
      if (matchTo > matchFrom && matchTo <= blockTo) {
        const markType = state.schema.marks.date;
        const overlapsExisting = !!markType && state.doc.rangeHasMark(matchFrom, matchTo, markType);
        if (!overlapsExisting) {
          candidate = { blockFrom, blockTo, matchFrom, matchTo, parsed };
        }
      }
    }
  }

  view.dispatch(view.state.tr.setMeta(nudgeKey, { type: "result", candidate } as NudgeMeta));
}

export const DateNudge = Extension.create({
  name: "briseDateNudge",

  addProseMirrorPlugins() {
    return [
      new Plugin<NudgeState>({
        key: nudgeKey,
        state: {
          init: () => EMPTY_STATE,
          apply(tr, prev) {
            const meta = tr.getMeta(nudgeKey) as NudgeMeta | undefined;
            if (meta?.type === "dismiss") return EMPTY_STATE;
            if (meta?.type === "result") {
              if (!meta.candidate) return EMPTY_STATE;
              const shown = computeShown(tr.selection.from, meta.candidate);
              return {
                candidate: meta.candidate,
                shown,
                decos: buildDecos(tr.doc, meta.candidate, shown),
                suppressDebounce: false,
              };
            }
            if (tr.docChanged) {
              // Any doc change invalidates the current candidate right away — a fresh debounce
              // cycle (scheduled in the plugin view's update() below) recomputes after quiet,
              // UNLESS this was a programmatic load (note open/switch — preventUpdate meta, see
              // suppressDebounce's own doc comment) — view().update() reads this flag to skip
              // arming the timer for that one transaction.
              const suppressDebounce = tr.getMeta("preventUpdate") === true;
              if (!prev.candidate && prev.suppressDebounce === suppressDebounce) return prev;
              return { candidate: null, shown: false, decos: DecorationSet.empty, suppressDebounce };
            }
            // Selection-only transaction: flip shown/hidden, or dismiss if the caret left the
            // paragraph the candidate was parsed from.
            if (!prev.candidate) return prev;
            const $sel = tr.doc.resolve(tr.selection.from);
            const stillInBlock =
              $sel.parent.isTextblock &&
              $sel.start() === prev.candidate.blockFrom &&
              $sel.end() === prev.candidate.blockTo;
            if (!stillInBlock) return EMPTY_STATE;
            const shown = computeShown(tr.selection.from, prev.candidate);
            if (shown === prev.shown) return prev;
            return {
              candidate: prev.candidate,
              shown,
              decos: buildDecos(tr.doc, prev.candidate, shown),
              suppressDebounce: prev.suppressDebounce,
            };
          },
        },
        props: {
          decorations(state) {
            return nudgeKey.getState(state)?.decos;
          },
          handleKeyDown(view, event) {
            if (event.key !== "Escape") return false;
            const st = nudgeKey.getState(view.state);
            if (!st?.candidate) return false;
            view.dispatch(view.state.tr.setMeta(nudgeKey, { type: "dismiss" } as NudgeMeta));
            return true;
          },
        },
        view(editorView) {
          let timer: ReturnType<typeof setTimeout> | null = null;
          const clear = () => {
            if (timer !== null) {
              clearTimeout(timer);
              timer = null;
            }
          };
          // 오너 결정(2026-09-20) — dateNudgeEnabled 를 끄는 순간 이미 떠 있는 칩(있다면)을 다음
          // 키 입력을 기다리지 않고 바로 지운다. update()는 트랜잭션이 있어야만 불리므로(다음
          // 문서/선택 변경 전까지 안 불림) 설정 스토어를 직접 구독해 "off로 넘어가는" edge에서
          // dismiss 메타 트랜잭션을 쏜다 — dateNudgeAuto가 view().update() 안에서 이미 쓰는
          // "getState()를 그때그때 읽는" 관용구와 달리, 이건 트랜잭션 바깥(설정 변경)에서 오는
          // 이벤트라 구독이 필요하다. 켜는 쪽(off→on)은 아무것도 하지 않는다 — 꺼진 동안은 애초에
          // 아무것도 안 보였으므로 되살릴 화면 상태가 없고, 다음 디바운스 사이클이 정상적으로
          // 다시 계산한다.
          const unsubscribeEnabled = useSettingsStore.subscribe((state, prevSettings) => {
            if (prevSettings.dateNudgeEnabled === state.dateNudgeEnabled) return;
            if (state.dateNudgeEnabled) return;
            clear();
            if (editorView.isDestroyed) return;
            if (nudgeKey.getState(editorView.state)?.candidate) {
              editorView.dispatch(editorView.state.tr.setMeta(nudgeKey, { type: "dismiss" } as NudgeMeta));
            }
          });
          return {
            update(viewNow, prevState) {
              // 오너 결정(2026-09-20) — off면 아무것도 하지 않는다: 라인 프레임도, 버블도, auto
              // 등록도. 플러그인 업데이트 경로의 가장 이른 지점에서 막아 파싱 작업 자체가 안
              // 일어나게 한다(디바운스 타이머도 안 건다) — "off"가 dateNudgeAuto 보다 우선이라는
              // 규칙이 아래 §W4 auto 트리거 블록까지 아예 도달을 안 하는 것으로 자동 보장된다.
              if (!useSettingsStore.getState().dateNudgeEnabled) return;
              if (viewNow.state.doc !== prevState.doc) {
                clear();
                // 프로그램적 로드(노트 열기/전환)는 디바운스를 아예 안 건다 — suppressDebounce
                // doc comment 참고. 사용자가 실제로 타이핑한 트랜잭션엔 이 플래그가 없다.
                if (nudgeKey.getState(viewNow.state)?.suppressDebounce) return;
                timer = setTimeout(() => {
                  timer = null;
                  runParse(viewNow);
                }, DEBOUNCE_MS);
              }

              // §W4 — full-auto opt-in: fire on the same `shown` edge (false→true) that would
              // otherwise reveal the chip, whether it arrives via a fresh "result" (debounce just
              // fired with the caret already past the match) or a selection-only transaction (caret
              // moved past the match afterwards). buildDecos() already keeps the chip itself from
              // ever rendering in this mode, so this is the only trigger. Deferred a tick to stay
              // out of ProseMirror's own update cycle; re-checked for staleness when it fires.
              const cur = nudgeKey.getState(viewNow.state);
              const wasShown = nudgeKey.getState(prevState)?.shown ?? false;
              if (cur?.shown && cur.candidate && !wasShown && useSettingsStore.getState().dateNudgeAuto) {
                const candidate = cur.candidate;
                setTimeout(() => {
                  if (viewNow.isDestroyed) return;
                  if (nudgeKey.getState(viewNow.state) !== cur) return; // 그 사이 상태가 바뀌었다.
                  acceptCandidate(candidate, viewNow);
                }, 0);
              }
            },
            // Editor instances in this app persist across note/section switches (useEditor has no
            // deps array — CLAUDE.md 함정 2), so this only fires on real unmount (e.g. EditorPanel
            // itself unmounting) — but it's the only thing standing between a pending timer and a
            // dangling setTimeout callback closing over a destroyed view, so it still matters.
            destroy() {
              clear();
              unsubscribeEnabled();
            },
          };
        },
      }),
    ];
  },
});
