import { t } from "../../i18n/t";
import type { SettingsSearchEntry } from "./settingsSearchIndex";

/** 결과 최대 개수 — 드롭다운은 한 화면에 담기는 만큼만. */
export const SETTINGS_SEARCH_MAX = 8;

export interface SettingsSearchOptions {
  /** 지금 보이는 페이지 id(브라우저 모드면 BROWSER_SETTINGS_PAGES 로 걸러진 것) — 이 밖의 항목은 나오지 않는다. */
  pageIds: readonly string[];
  /** `requires: "ai"` 항목의 앵커 사용 가능 여부 — AI 꺼짐이면 본문이 접혀 있다. */
  aiEnabled: boolean;
  /** 브라우저/태블릿 모드 — `requires: "desktop"` 항목은 행이 없다. */
  browser?: boolean;
  pageLabel: (page: string) => string;
}

export interface SettingsSearchResult {
  entry: SettingsSearchEntry;
  label: string;
  group?: string;
  pageLabel: string;
  /** 선택했을 때 이동할 앵커 — 행이 그려지지 않는 상태면 undefined(페이지만 연다). */
  anchor?: string;
  /** label 안에서 일치한 구간 [시작, 끝) — 강조용. 라벨 밖(그룹·페이지·동의어)에서만 맞았으면 null. */
  match: [number, number] | null;
}

/**
 * 설정 검색 — 순수 함수. 대소문자·앞뒤 공백을 무시하고 라벨·그룹·페이지 이름·동의어의 부분 문자열로 맞춘다.
 * 순위: 라벨 접두 > 라벨 부분 일치 > 그룹/페이지/동의어. 같은 순위는 색인 순서를 지킨다.
 * ponytail: 한국어는 평범한 부분 문자열이다(초성 검색 "ㅂㅇ" 은 안 맞는다). 올리려면 라벨·그룹을
 * 자모로 풀어 둔 키를 같이 비교하면 된다 — 결과 모양은 그대로다.
 */
export function searchSettings(
  query: string,
  entries: readonly SettingsSearchEntry[],
  opts: SettingsSearchOptions,
): SettingsSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ rank: number; order: number; result: SettingsSearchResult }> = [];
  entries.forEach((entry, order) => {
    if (!opts.pageIds.includes(entry.page)) return;
    const label = t(entry.labelKey);
    const group = entry.groupKey ? t(entry.groupKey) : undefined;
    const pageLabel = opts.pageLabel(entry.page);
    const labelLower = label.toLowerCase();
    const at = labelLower.indexOf(q);
    let rank: number;
    if (at === 0) rank = 0;
    else if (at > 0) rank = 1;
    else if (
      group?.toLowerCase().includes(q) ||
      pageLabel.toLowerCase().includes(q) ||
      (entry.keywordKeys ?? []).some((k) => t(k).toLowerCase().includes(q))
    ) {
      rank = 2;
    } else return;
    const usable = !(
      (entry.requires === "ai" && !opts.aiEnabled) ||
      (entry.requires === "desktop" && opts.browser)
    );
    scored.push({
      rank,
      order,
      result: {
        entry,
        label,
        group,
        pageLabel,
        anchor: usable ? entry.anchor : undefined,
        match: at >= 0 ? [at, at + q.length] : null,
      },
    });
  });
  scored.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return scored.slice(0, SETTINGS_SEARCH_MAX).map((s) => s.result);
}
