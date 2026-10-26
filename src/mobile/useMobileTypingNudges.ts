/**
 * 폰 에디터 입력 감지 훅 — docs/PLAN-2026-10-07-mobile-typing-nudges.md §1·§3.
 * 커서가 있는 텍스트 블록 하나만 `detectTypingNudges` 에 넣고, 결과를 상태로 돌려준다(칩 표시는 MobileNote).
 * 이 훅은 문서를 바꾸지 않는다 — 읽기만 한다.
 *
 * - 날짜·지역·링크: 문서가 바뀐 뒤 700ms 디바운스(데스크톱 넛지와 같다). 오래된 노트를 열기만 해서는
 *   감지하지 않는다(selectionUpdate 로는 돌리지 않는다).
 * - #태그: "입력 중 자동완성"이라 디바운스 없이 바로. 커서만 움직여도 다시 본다(# 에서 벗어나면 칩이 사라진다).
 * - IME 조합 중(`view.composing`)에는 건너뛴다. 조합이 끝나면(compositionend) 다시 본다 — 건너뛴 만큼 놓치지 않게.
 * - 무시 기억: `kind + 정규화한 텍스트` 를 노트 세션 동안 기억한다. 노트가 바뀌면 초기화(regionNudge D10 과 같은 규약).
 *   태그 칩은 질의가 바뀔 때마다 갈아 끼우는 것이라 대상이 아니다.
 * - 정책: 날짜=date_nudge_enabled/auto(`dateNudgeModeOf`), 지역=region_nudge_enabled/strict. 새 설정 키 없음.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { detectTagQuery, detectTypingNudges, type DateNudge, type TagQuery } from "../lib/typingNudges";
import type { RegionRegistryEntry } from "../lib/commands.gen";
import { loadRegionRegistry } from "../lib/regionRegistry";
import { useSettingsStore, dateNudgeModeOf } from "../stores/settings";
import { useNotesStore } from "../stores/notes";
import { callSilent } from "../lib/invoke";
import { reportFallback } from "../lib/diag";
import { useNoteWaypoints } from "../components/home/useNoteWaypoints";
import { filterHashTagCandidates, type HashTagItem } from "../components/editor/hashTag";
import { snapshotCaretParagraph } from "./mobileNudgeApply";

export const NUDGE_DEBOUNCE_MS = 700;
const TAG_CHIP_LIMIT = 3;

export type NudgeKind = "date" | "region" | "url";

export interface DateNudgeState extends DateNudge {
  paraStart: number;
  paraText: string;
}
export interface TagNudgeState {
  query: TagQuery;
  items: HashTagItem[];
  paraStart: number;
  paraText: string;
}
export interface TypingNudgeState {
  date?: DateNudgeState;
  region?: RegionRegistryEntry;
  /**
   * 날짜·지역이 감지된 문단의 시작 위치(문서 위치) — 문장 위 말풍선(MobileNudgeBubble)의 앵커.
   * 날짜는 자기 `paraStart` 가 있지만 지역(RegionRegistryEntry)은 없다. 렌더 때 커서 문단을 다시 재면 안 된다 —
   * 감지 뒤 커서가 다른 문단으로 갔는데 제안은 옛 문단 것이라 말풍선이 엉뚱한 문장 위로 뛴다.
   * 날짜·지역이 둘 다 없으면 세우지 않는다.
   */
  restParaStart?: number;
  url?: string;
  tag?: TagNudgeState;
}

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const dismissKey = (kind: NudgeKind, text: string) => `${kind}:${normalize(text)}`;

/** 무시 기억 키에 쓰는 텍스트 — 칩이 가리키는 "그것". */
export function nudgeDismissText(kind: NudgeKind, s: TypingNudgeState): string {
  if (kind === "date") return s.date ? s.date.paraText.slice(s.date.matchFrom, s.date.matchTo) : "";
  if (kind === "region") return s.region?.name ?? "";
  return s.url ?? "";
}


/**
 * @param enabled 읽기 전용·관계도·시트 섹션이면 false — 에디터가 비어 있거나 편집 대상이 아니다.
 * @param sectionKey 섹션이 바뀌면 낡은 칩을 비운다(setContent 는 update 를 내지 않는다).
 */
export function useMobileTypingNudges(
  editor: Editor | null,
  noteId: string | null,
  enabled: boolean,
  sectionKey: string | null = null,
): { state: TypingNudgeState; dismiss: (kind: NudgeKind, s: TypingNudgeState) => void } {
  const [state, setState] = useState<TypingNudgeState>({});
  const waypoints = useNoteWaypoints(noteId);
  const waypointsRef = useRef(waypoints);
  waypointsRef.current = waypoints;
  const dismissedRef = useRef(new Set<string>());
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;
  const genRef = useRef({ rest: 0, tag: 0 });
  const tagCountsRef = useRef<{ noteId: string; counts: Record<string, number> } | null>(null);

  // 노트가 바뀌면 무시 기억을 비운다 — 섹션 전환에는 살아남는다.
  useEffect(() => {
    dismissedRef.current = new Set();
    tagCountsRef.current = null;
  }, [noteId]);

  useEffect(() => {
    setState({});
    genRef.current.rest++;
    genRef.current.tag++;
    if (!editor || !noteId || !enabled) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    // 이 이펙트가 정리된 뒤(노트·섹션 전환, 언마운트)에 끝나는 비동기 작업은 결과를 버린다.
    let alive = true;
    const usable = () => alive && !editor.isDestroyed && noteIdRef.current === noteId;
    const composing = () => !!editor.view?.composing;

    const scanTag = async () => {
      if (!usable() || composing()) return;
      const gen = ++genRef.current.tag;
      const snap = snapshotCaretParagraph(editor);
      const found = snap ? detectTagQuery(snap.paraText, snap.caret) : undefined;
      if (!snap || !found) {
        setState((p) => (p.tag ? { ...p, tag: undefined } : p));
        return;
      }
      let counts = useNotesStore.getState().tagCounts;
      if (!counts) {
        if (tagCountsRef.current?.noteId === noteId) counts = tagCountsRef.current.counts;
        else {
          try {
            counts = (await callSilent<{ counts: Record<string, number> }>("tag_counts"))?.counts ?? {};
            tagCountsRef.current = { noteId, counts };
          } catch {
            reportFallback("mobile-typing-nudge", "tag_counts_failed");
            counts = {};
          }
        }
      }
      if (!usable() || gen !== genRef.current.tag) return;
      const items = filterHashTagCandidates(counts ?? {}, found.query, TAG_CHIP_LIMIT);
      setState((p) => ({
        ...p,
        tag: items.length ? { query: found, items, paraStart: snap.paraStart, paraText: snap.paraText } : undefined,
      }));
    };

    const scanRest = async () => {
      if (!usable()) return;
      // 조합 중이면 이번엔 건너뛰고 조금 뒤에 다시 — compositionend 도 다시 깨운다.
      if (composing()) {
        schedule();
        return;
      }
      const gen = ++genRef.current.rest;
      const snap = snapshotCaretParagraph(editor);
      if (!snap) {
        setState((p) => (p.date || p.region || p.url || p.restParaStart !== undefined ? { tag: p.tag } : p));
        return;
      }
      const ss = useSettingsStore.getState();
      const dateMode = dateNudgeModeOf(ss.dateNudgeEnabled, ss.dateNudgeAuto);
      let registry: RegionRegistryEntry[] = [];
      if (ss.regionNudgeEnabled) {
        try {
          registry = await loadRegionRegistry();
        } catch {
          reportFallback("mobile-typing-nudge", "region_registry_failed");
        }
        if (!usable() || gen !== genRef.current.rest) return;
        // 레지스트리를 기다리는 사이 문단이 바뀌었으면 이 결과는 낡았다 — 다음 입력의 스캔이 맡는다.
        const again = snapshotCaretParagraph(editor);
        if (!again || again.paraText !== snap.paraText || again.paraStart !== snap.paraStart) return;
      }
      const own = useNotesStore.getState().activeNote;
      const found = detectTypingNudges(snap.paraText, snap.caret, {
        uiLang: ss.uiLang,
        strict: ss.regionNudgeStrict,
        registry,
        ownRegion: own?.note.id === noteId ? own.note.region ?? null : null,
        waypointNames: waypointsRef.current.map((w) => w.name),
        existingDateRanges: snap.dateRanges,
      });
      const dismissed = dismissedRef.current;
      const next: TypingNudgeState = {};
      if (found.date && dateMode !== "off") {
        const text = snap.paraText.slice(found.date.matchFrom, found.date.matchTo);
        if (!dismissed.has(dismissKey("date", text))) {
          next.date = { ...found.date, paraStart: snap.paraStart, paraText: snap.paraText };
        }
      }
      if (found.region && ss.regionNudgeEnabled && !dismissed.has(dismissKey("region", found.region.name))) {
        next.region = found.region;
      }
      if (found.url && !dismissed.has(dismissKey("url", found.url))) next.url = found.url;
      if (next.date || next.region) next.restParaStart = snap.paraStart;
      setState((p) => ({ ...next, tag: p.tag }));
    };

    function schedule() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void scanRest();
      }, NUDGE_DEBOUNCE_MS);
    }

    const onUpdate = () => {
      schedule();
      void scanTag();
    };
    const onSelection = () => void scanTag();
    const onCompositionEnd = () => {
      schedule();
      void scanTag();
    };

    editor.on("update", onUpdate);
    editor.on("selectionUpdate", onSelection);
    // 에디터가 아직 화면에 붙지 않았으면(TipTap 3: mount 전) `editor.view` 는 대역 Proxy 라 `.dom` 을 읽는 순간 던진다 —
    // `?.` 로는 못 막는다. 폰에서 노트를 열자마자 앱 전체가 ErrorBoundary 로 떨어졌다(2026-10-15 디자인 보드 캡처 중 발견).
    // 붙어 있으면 바로, 아니면 "mount" 때 단다.
    let dom: HTMLElement | undefined;
    const attachComposition = () => {
      if (dom || editor.isDestroyed) return;
      try {
        dom = editor.view.dom as HTMLElement;
      } catch {
        return; // silent-ok: 아직 mount 전 — 아래 "mount" 구독이 다시 부른다
      }
      dom.addEventListener("compositionend", onCompositionEnd);
    };
    attachComposition();
    editor.on("mount", attachComposition);
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      editor.off("update", onUpdate);
      editor.off("selectionUpdate", onSelection);
      editor.off("mount", attachComposition);
      dom?.removeEventListener("compositionend", onCompositionEnd);
    };
  }, [editor, noteId, enabled, sectionKey]);

  const dismiss = useCallback((kind: NudgeKind, s: TypingNudgeState) => {
    const text = nudgeDismissText(kind, s);
    if (text) dismissedRef.current.add(dismissKey(kind, text));
    setState((p) => {
      const { [kind]: _gone, ...rest } = p;
      return rest;
    });
  }, []);

  return { state, dismiss };
}
