/**
 * D12 순수 지역 매처 — components/editor/regionDetect.ts 에서 옮겼다(폰 타이핑 감지 lib/typingNudges.ts 가
 * React·스토어 의존 없이 쓰려고). regionDetect.ts 가 그대로 re-export 하므로 기존 import 는 안 바뀐다.
 */
import type { RegionRegistryEntry } from "./commands.gen";

export type BoundaryMode = "strict" | "loose";

// D12 (strict mode): a match's neighboring character must NOT be a "continuation" character for
// the match to count as a real word boundary. Deliberately NOT `\b`/`\w` — those are ASCII-only,
// so `/\b경주\b/` finds no boundary anywhere near Hangul: it fails to reject "경주마" (아니게 놓임
// 없음, \w 가 "주"/"마" 사이를 boundary로도 안 봄) AND fails to accept plain "경주" on its own
// (Hangul syllables aren't \w either). `\p{L}` covers Hangul syllables (U+AC00–U+D7A3) as letters
// automatically, `\p{N}` digits, `\p{M}` combining marks (so accented Latin like "é" in fr locale
// text doesn't falsely read as a boundary in the middle of a base+combining-mark pair).
const CONTINUATION_CHAR = /[\p{L}\p{N}\p{M}]/u;

/**
 * 2026-09-19 버그 수정(§P3 Phase A 적대적 검증에서 발견) — `haystack[idx-1]`처럼 UTF-16 코드
 * 유닛으로 직접 인덱싱하면, 그 자리가 서로게이트 쌍(BMP 밖 문자 — 드문 한자 확장 영역, 이모지,
 * 꾸밈 유니코드 등, 2코드유닛)의 절반이면 그 절반(홀로 선 서로게이트)만 집는다. 홀로 선
 * 서로게이트는 `\p{L}/\p{N}/\p{M}` 그 무엇에도 안 걸리는 별도 카테고리(Cs)라 "연속 문자
 * 아님"으로 오판 — 실제로는 진짜 문자(글자)가 바로 붙어 있는데 경계로 잘못 보고 매칭을
 * 통과시킨다(strict 모드의 존재 이유인 "확실하지 않으면 안 뜨는" 원칙을 정확히 어기는 거짓
 * 양성). 인접한 전체 코드포인트(서로게이트 쌍이면 2유닛 모두)를 되찾아서 검사한다.
 */
function charBefore(str: string, idx: number): string {
  if (idx <= 0) return "";
  const code = str.charCodeAt(idx - 1);
  if (code >= 0xdc00 && code <= 0xdfff && idx >= 2) {
    const prevCode = str.charCodeAt(idx - 2);
    if (prevCode >= 0xd800 && prevCode <= 0xdbff) return str.slice(idx - 2, idx);
  }
  return str[idx - 1];
}

function charAfter(str: string, idx: number): string {
  if (idx >= str.length) return "";
  const code = str.charCodeAt(idx);
  if (code >= 0xd800 && code <= 0xdbff && idx + 1 < str.length) {
    const nextCode = str.charCodeAt(idx + 1);
    if (nextCode >= 0xdc00 && nextCode <= 0xdfff) return str.slice(idx, idx + 2);
  }
  return str[idx];
}

/**
 * D12 — true if `needle` occurs in `haystack` at least once satisfying `mode`'s boundary rule.
 * Both strings must already be case-folded consistently by the caller (matchRegionCandidates
 * lowercases both sides before calling this, so indices stay self-consistent with the lowercased
 * text) — this function itself does no case-folding.
 *
 * Loops every occurrence rather than stopping at the first `indexOf` hit: in "경주마에 갔다가 경주
 * 구경" the FIRST occurrence sits inside "경주마" (rejected by the boundary check) while the
 * SECOND is a real standalone match — stopping after the first hit would wrongly report no match.
 * Advances by `idx + 1` (not `idx + needle.length`) so overlapping repeats are still found.
 */
function hasBoundaryMatch(haystack: string, needle: string, mode: BoundaryMode): boolean {
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    if (mode === "loose") return true;
    const before = charBefore(haystack, idx);
    const after = charAfter(haystack, idx + needle.length);
    const beforeOk = before === "" || !CONTINUATION_CHAR.test(before);
    const afterOk = after === "" || !CONTINUATION_CHAR.test(after);
    if (beforeOk && afterOk) return true;
    from = idx + 1;
  }
}

/**
 * D12 pure matcher — which `registry` entries occur in `text` under `mode`'s boundary rule.
 * Does NOT apply D9 (self-attached exclusion) or D10 (dismiss set) — those need note-specific
 * context (`activeNote`, waypoints, the dismiss store) that `useRegionDetect` supplies; this
 * function stays a pure string→list transform so it's trivially unit-testable on its own.
 *
 * Case-folds both the haystack and every candidate name the same way (`trim().toLowerCase()`,
 * matching regionDisplay.ts::sameRegionName's own normalization) before matching, and skips any
 * registry entry whose trimmed name is empty — `note_region_add`'s repo function doesn't trim,
 * so a whitespace-only waypoint name is reachable and `indexOf("")` would otherwise match at
 * position 0 of every text, "matching" nothing meaningful.
 */
export function matchRegionCandidates(
  text: string,
  registry: RegionRegistryEntry[],
  mode: BoundaryMode,
): RegionRegistryEntry[] {
  if (!text.trim() || registry.length === 0) return [];
  const haystack = text.toLowerCase();
  const out: RegionRegistryEntry[] = [];
  for (const entry of registry) {
    const needle = entry.name.trim().toLowerCase();
    if (!needle) continue;
    if (hasBoundaryMatch(haystack, needle, mode)) out.push(entry);
  }
  return out;
}
