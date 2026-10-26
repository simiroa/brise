/**
 * 브리핑 머리줄 B — 문구(명언·지식·내 노트 인용). PLAN-2026-10-19 §6 · GRILL R4.
 *
 * 팩 선택은 노트북 키 `phrase_pack_id`(설정 스토어 phrasePackId). 번들·사용자 팩은 lib/phrasePacks 가
 * 파일에서 읽으므로 이 창에서도 그대로 동작한다.
 *
 * **'내 노트 인용'은 서버가 고른다**(briefing_note_quote). 대시보드의 옛 PhraseRow 는 noteIndex 의 snippet 을
 * 읽었는데 트리 요약은 snippet 이 비어 있어 후보가 늘 0 이었고, 그때 **기록 없이** 지식 팩으로 떨어졌다
 * (§2.4 ③ — 한 번도 동작하지 않은 기능). 여기서는 떨어지지 않는다: 인용할 노트가 없으면 그렇다고 말하고
 * reportFallback 을 남긴다(CLAUDE.md 규칙 11). 조회 실패는 오류 상태 + 다시 시도.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n/t";
import { callSilent } from "../lib/invoke";
import { reportFallback } from "../lib/diag";
import { requestOpenNoteInMain } from "../lib/openNoteInMain";
import { storedTitleOrEmpty } from "../lib/noteTitle";
import { useSettingsStore } from "../stores/settings";
import { PHRASE_PACK_OFF, findPack, loadAllPhrasePacks, pickPhrase, type PhrasePack } from "../lib/phrasePacks";
import type { BriefingNoteQuoteOutput } from "../lib/commands.gen";
import { IconCheck, IconCopy, IconRefresh } from "../components/icons";

export const NOTE_QUOTES_PACK_ID = "bundled:note-quotes";

type QuoteState =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "phrase"; text: string; source: string | null }
  | { kind: "note"; text: string; title: string; noteId: string }
  | { kind: "empty" }
  | { kind: "error" };

export function QuoteLine() {
  const packId = useSettingsStore((s) => s.phrasePackId);
  const workspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  const [packs, setPacks] = useState<PhrasePack[] | null>(null);
  const [state, setState] = useState<QuoteState>({ kind: "loading" });
  const [copied, setCopied] = useState(false);
  const seq = useRef(0); // 늦게 도착한 응답이 새 요청을 덮지 않게
  const lastNoteId = useRef<string | null>(null);
  const packsRef = useRef<PhrasePack[] | null>(null);
  packsRef.current = packs;

  useEffect(() => {
    let cancelled = false;
    void loadAllPhrasePacks().then((list) => {
      if (!cancelled) setPacks(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const pick = useCallback(
    async (prevText: string | null) => {
      const my = ++seq.current;
      if (packId === PHRASE_PACK_OFF) return setState({ kind: "off" });
      if (packId === NOTE_QUOTES_PACK_ID) {
        if (!workspaceId) return; // 설정이 아직 안 실렸다 — 실린 뒤 다시 돈다.
        try {
          const res = await callSilent<BriefingNoteQuoteOutput>("briefing_note_quote", {
            workspace_id: workspaceId,
            ...(lastNoteId.current ? { exclude_note_id: lastNoteId.current } : {}),
          });
          if (my !== seq.current) return;
          if (!res.quote) {
            reportFallback("briefing", "note_quote_empty", "no quotable note in notebook");
            return setState({ kind: "empty" });
          }
          lastNoteId.current = res.quote.note_id;
          setState({ kind: "note", text: res.quote.text, title: storedTitleOrEmpty(res.quote.title), noteId: res.quote.note_id });
        } catch {
          // callSilent 가 이미 진단에 남겼다 — 화면은 오류 + 다시 시도.
          if (my === seq.current) setState({ kind: "error" });
        }
        return;
      }
      const packs = packsRef.current;
      if (!packs) return setState({ kind: "loading" });
      const pack = findPack(packs, packId);
      const item = pack ? pickPhrase(pack, prevText) : null;
      if (!item?.text) return setState({ kind: "off" }); // 팩이 없거나 비었다 — 이 줄을 걷는다.
      setState({ kind: "phrase", text: item.text, source: item.source ?? null });
    },
    [packId, workspaceId],
  );

  // 팩 목록 도착은 파일 팩에만 의미가 있다 — 노트 인용은 그걸 기다리지도, 그걸로 다시 부르지도 않는다.
  const packsKey = packId === NOTE_QUOTES_PACK_ID ? null : packs;
  useEffect(() => {
    void pick(null);
  }, [pick, packsKey]);

  const text = state.kind === "phrase" || state.kind === "note" ? state.text : null;
  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      reportFallback("briefing", "quote_copy_failed", "clipboard unavailable");
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  if (state.kind === "off") return null;
  return (
    <div className="brf-quote" data-testid="brf-quote" aria-live="polite">
      <p className="brf-quote-text" data-testid="brf-quote-text">
        {state.kind === "loading" && <span className="brf-quote-muted">{t("briefing.loading")}</span>}
        {state.kind === "empty" && <span className="brf-quote-muted" data-testid="brf-quote-empty">{t("briefing.quote_note_empty")}</span>}
        {state.kind === "error" && (
          <span className="brf-quote-muted" role="alert">
            {t("briefing.quote_failed")}{" "}
            <button type="button" className="brf-link-btn" onClick={() => void pick(null)}>
              {t("briefing.retry")}
            </button>
          </span>
        )}
        {text && <span>“{text}”</span>}
      </p>
      <span className="brf-quote-meta">
        {state.kind === "phrase" && state.source && <span className="brf-quote-source">— {state.source}</span>}
        {state.kind === "note" && (
          <button
            type="button"
            className="brf-link-btn brf-quote-source"
            data-testid="brf-quote-source"
            title={t("briefing.quote_open_note")}
            onClick={() => void requestOpenNoteInMain(state.noteId)}
          >
            — {state.title || t("briefing.recent_untitled")}
          </button>
        )}
        {text && (
          <button type="button" className="icon-btn icon-btn--sm" data-testid="brf-quote-copy" aria-label={t("briefing.quote_copy")} title={t("briefing.quote_copy")} onClick={() => void copy()}>
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </button>
        )}
        {(text || state.kind === "empty") && (
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            data-testid="brf-quote-refresh"
            aria-label={t("briefing.quote_refresh")}
            title={t("briefing.quote_refresh")}
            onClick={() => void pick(text)}
          >
            <IconRefresh size={14} />
          </button>
        )}
      </span>
    </div>
  );
}
