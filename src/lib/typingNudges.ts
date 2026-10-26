/**
 * 폰 에디터 입력 감지의 순수 판정 계층 — docs/PLAN-2026-10-07-mobile-typing-nudges.md §3·W1.
 * 날짜·지역·링크·#태그 네 가지를 "커서가 있는 문단 텍스트 + 커서 오프셋" 한 쌍에서 판정한다.
 * 문서·스토어·IPC 를 만지지 않는다(읽기 전용) — 칩 표시·적용·무시 기억은 W2 의 폰 훅이 맡는다.
 * 오프셋은 전부 **문단 텍스트 기준**이다(문서 절대 위치가 아니다).
 * 판정 기준은 데스크톱과 같다: 날짜=dateNudge.ts(high 확신·커서가 매치 끝을 지난 뒤·기존 date 마크와
 * 안 겹침), 지역=useRegionDetect(D9 대표·경유지 제외), 링크=linkBodyMaybeReadable.
 */
import { parseNlDate, type NlDateLocale } from "./nlDate";
import { buildNoteDateAddPayload } from "./noteDatePayload";
import { matchRegionCandidates } from "./regionMatch";
import { linkBodyMaybeReadable } from "./urls";
import { formatEventDate } from "../components/titlebar/eventDate";
import { sameRegionName } from "../components/attachments/regionDisplay";
import type { NoteDateAddInput, RegionRegistryEntry } from "./commands.gen";

export interface TypingNudgeContext {
  uiLang: string;
  /** region_nudge_strict — true 면 단어 경계 매칭. */
  strict: boolean;
  registry: RegionRegistryEntry[];
  /** 노트의 대표 지역 이름(없으면 null). */
  ownRegion: string | null;
  /** 이미 붙은 경유지 이름들. */
  waypointNames: string[];
  /** 문단 안에서 이미 date 마크가 덮은 [from,to) 범위들(문단 기준 오프셋). */
  existingDateRanges: Array<[number, number]>;
  /** 테스트용 기준일. 기본은 지금. */
  referenceDate?: Date;
}

export interface DateNudge {
  payload: Omit<NoteDateAddInput, "note_id">;
  /** 칩 문구용 "2026.10.07 15:00". */
  label: string;
  matchFrom: number;
  matchTo: number;
}

export interface TagQuery {
  /** `#` 뒤 질의(비어 있을 수 있다 — `#` 만 쳤을 때). */
  query: string;
  /** `#` 위치부터 커서까지. */
  from: number;
  to: number;
}

export interface TypingNudges {
  date?: DateNudge;
  region?: RegionRegistryEntry;
  url?: string;
  tagQuery?: TagQuery;
}

function nlLocale(uiLang: string): NlDateLocale {
  return uiLang === "ko" || uiLang === "fr" ? uiLang : "en";
}

function detectDate(text: string, caret: number, ctx: TypingNudgeContext): DateNudge | undefined {
  if (!text.trim()) return undefined;
  const parsed = parseNlDate(text, nlLocale(ctx.uiLang), ctx.referenceDate);
  if (!parsed || parsed.confidence !== "high") return undefined;
  const [matchFrom, matchTo] = parsed.matchRange;
  if (matchTo <= matchFrom || matchTo > text.length) return undefined;
  // 아직 그 날짜를 고치는 중일 수 있다 — 커서가 매치 끝을 지난 뒤에만(데스크톱 computeShown 과 같다).
  if (caret < matchTo) return undefined;
  if (ctx.existingDateRanges.some(([a, b]) => matchFrom < b && a < matchTo)) return undefined;
  const { start } = parsed;
  const label = `${formatEventDate(start.year, start.month, start.day)}${parsed.startTime ? ` ${parsed.startTime}` : ""}`;
  return { payload: buildNoteDateAddPayload(parsed), label, matchFrom, matchTo };
}

function detectRegion(text: string, ctx: TypingNudgeContext): RegionRegistryEntry | undefined {
  const matched = matchRegionCandidates(text, ctx.registry, ctx.strict ? "strict" : "loose");
  return matched.find(
    (e) => !sameRegionName(e.name, ctx.ownRegion) && !ctx.waypointNames.some((w) => sameRegionName(w, e.name)),
  );
}

// 문장 끝 구두점은 URL 이 아니다("https://a.com/x." 의 마침표).
const URL_TRAILING = /[.,;:!?)\]}>'"」』）]+$/;

function detectUrl(text: string): string | undefined {
  for (const m of text.matchAll(/https?:\/\/\S+/gi)) {
    const url = m[0].replace(URL_TRAILING, "");
    // 단독 토큰 — 앞이 공백·문단 시작이어야 한다("abchttp://x" 같은 중간 접합은 제외).
    if (m.index > 0 && !/\s/.test(text[m.index - 1])) continue;
    if (linkBodyMaybeReadable(url)) return url;
  }
  return undefined;
}

export function detectTagQuery(text: string, caret: number): TagQuery | undefined {
  const before = text.slice(0, caret);
  const m = /(?:^|\s)#([^\s#]*)$/.exec(before);
  if (!m) return undefined;
  const from = before.length - m[1].length - 1;
  return { query: m[1], from, to: caret };
}

export function detectTypingNudges(paragraphText: string, caretOffset: number, ctx: TypingNudgeContext): TypingNudges {
  const caret = Math.max(0, Math.min(caretOffset, paragraphText.length));
  const out: TypingNudges = {};
  const date = detectDate(paragraphText, caret, ctx);
  if (date) out.date = date;
  const region = detectRegion(paragraphText, ctx);
  if (region) out.region = region;
  const url = detectUrl(paragraphText);
  if (url) out.url = url;
  const tagQuery = detectTagQuery(paragraphText, caret);
  if (tagQuery) out.tagQuery = tagQuery;
  return out;
}
