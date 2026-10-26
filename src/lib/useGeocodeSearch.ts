import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "./invoke";

export interface GeocodeResultItem {
  label: string;
  lat: number;
  lng: number;
}

interface GeocodeSearchState {
  results: GeocodeResultItem[];
  searching: boolean;
  unavailable: boolean;
}

export interface GeocodeSearch extends GeocodeSearchState {
  /** 질의가 너무 짧아 검색을 보내지 않는 상태(빈 질의는 제외 — 그건 그냥 "아무 것도 안 함"). */
  tooShort: boolean;
  /** 디바운스를 건너뛰고 지금 검색한다(Enter / "다시 시도"). 이미 이 질의로 정착한 결과가 있고
   *  실패 상태도 아니면 아무 것도 하지 않는다(같은 질의로 요청을 또 쏘지 않는다). */
  searchNow: () => void;
  /** 한글 IME 조합 중 요청을 막으려면 입력창에 펼쳐 준다. */
  compositionProps: { onCompositionStart: () => void; onCompositionEnd: () => void };
}

const EMPTY: GeocodeSearchState = { results: [], searching: false, unavailable: false };

/** 입력 후 검색까지 기다리는 시간. Nominatim ~1 req/sec 정책 때문에 1100ms. */
export const GEOCODE_DEBOUNCE_MS = 1100;

/**
 * 최소 질의 길이: 두 글자. 단, 한 글자로도 뜻이 서는 문자(한글·한자·가나 등 U+1100 이상)는 한
 * 글자도 허용한다("강", "京"). ASCII 한 글자("S")는 Nominatim 이 잡음만 돌려줘 요청이 아깝다.
 */
export function meetsMinQueryLength(q: string): boolean {
  const s = q.trim();
  if (s.length >= 2) return true;
  if (s.length === 1) return (s.codePointAt(0) ?? 0) >= 0x1100;
  return false;
}

/**
 * Shared geocode_search wrapper (Nominatim via backend, ~1 req/sec policy) — was duplicated
 * 3x (MapPlaceSearch, RegionPickerDialog, MobileNoteBadges) with only MapPlaceSearch carrying a
 * stale-response guard. A-1: single source, guard applies everywhere now.
 *
 * Debounces `query` 1100ms then calls geocode_search. A response is dropped (not applied to
 * state) if `query` has already changed by the time it lands — without this, a slow response to
 * an old keystroke can overwrite a newer, faster one (real bug: RegionPickerDialog/
 * MobileNoteBadges had no guard, so typing "Seoul" then quickly backspacing to "Se" could show
 * "Seoul" results under an "Se" query). 질의 비교만으로는 같은 질의의 재시도(searchNow)끼리의
 * 순서를 못 가려서, 요청마다 순번(seqRef)을 매겨 **가장 최근 요청의 응답만** 반영한다.
 *
 * 추가 가드: 한글 IME 조합 중(compositionstart~end)에는 요청을 보내지 않고, 조합이 끝나면 그
 * 시점의 질의로 디바운스를 시작한다. 최소 길이 미만은 보내지 않는다.
 */
export function useGeocodeSearch(query: string, uiLang: string): GeocodeSearch {
  const [state, setState] = useState<GeocodeSearchState>(EMPTY);
  const [composing, setComposing] = useState(false);
  const [kick, setKick] = useState(0);
  const immediateRef = useRef(false);
  const seqRef = useRef(0);
  const currentQueryRef = useRef(query);
  currentQueryRef.current = query;
  // 마지막으로 정착(성공)한 "질의|언어" — searchNow 가 같은 질의로 중복 요청하지 않게 한다.
  const settledKeyRef = useRef<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const q = query.trim();
    if (!q || !meetsMinQueryLength(q) || composing) {
      seqRef.current++; // 날아가 있던 요청의 응답을 버린다.
      settledKeyRef.current = null;
      // 조합 중에는 이전 결과를 지우지 않는다(조합이 끝나면 새 질의로 곧 대체된다).
      if (!composing) setState(EMPTY);
      else setState((s) => (s.searching ? { ...s, searching: false } : s));
      return;
    }
    const delay = immediateRef.current ? 0 : GEOCODE_DEBOUNCE_MS;
    immediateRef.current = false;
    settledKeyRef.current = null;
    setState((s) => ({ ...s, searching: true, unavailable: false }));
    const seq = ++seqRef.current;
    const isStale = () => seq !== seqRef.current || currentQueryRef.current.trim() !== q;

    const timer = setTimeout(async () => {
      try {
        const res = await call<{ results: GeocodeResultItem[] }>("geocode_search", {
          query: q,
          lang: uiLang || "ko",
        });
        if (isStale()) return;
        settledKeyRef.current = `${q}|${uiLang}`;
        setState({ results: res.results || [], searching: false, unavailable: false });
      } catch {
        // silent-ok: call() 이 이미 진단 로그/토스트를 남겼고, 화면엔 unavailable + "다시 시도"가 뜬다.
        if (isStale()) return;
        settledKeyRef.current = null;
        setState({ results: [], searching: false, unavailable: true });
      }
    }, delay);

    return () => {
      clearTimeout(timer);
      seqRef.current++; // 질의/언어가 바뀌거나 언마운트되면 이 요청의 응답은 쓰지 않는다.
    };
  }, [query, uiLang, composing, kick]);

  const searchNow = useCallback(() => {
    const q = currentQueryRef.current.trim();
    if (!meetsMinQueryLength(q)) return;
    if (settledKeyRef.current === `${q}|${uiLang}` && !stateRef.current.unavailable) return;
    immediateRef.current = true;
    setKick((k) => k + 1);
  }, [uiLang]);

  const compositionProps = useRef({
    onCompositionStart: () => setComposing(true),
    onCompositionEnd: () => setComposing(false),
  }).current;

  const trimmed = query.trim();
  return {
    ...state,
    tooShort: trimmed.length > 0 && !meetsMinQueryLength(trimmed),
    searchNow,
    compositionProps,
  };
}
