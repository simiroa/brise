/**
 * Locale-aware header date/time formatting.
 *
 * 2026-08-15(오너 피드백): 헤더 좌측의 "안녕히 주무세요" 류 인사말 줄을 걷어내며 이 인사말이
 * 쓰던 i18n 키 매핑(greetingKey, home.greeting_*)도 함께 지웠다 — HomeHeader.tsx가 유일한
 * 소비자였다. greetingPeriod/GreetingPeriod(아침/오후/저녁/밤 구간 판정)는 그 자체로는 인사말과
 * 무관한 순수 시간대 분류라 남겨뒀다 — 지금은 greeting.test.ts만 소비하는 미사용 유틸리티다.
 */

export type GreetingPeriod = "morning" | "afternoon" | "evening" | "night";

/** Partition the day: morning 5–11, afternoon 12–17, evening 18–21, night 22–4. */
export function greetingPeriod(date: Date = new Date()): GreetingPeriod {
  const h = date.getHours();
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 18) return "afternoon";
  if (h >= 18 && h < 22) return "evening";
  return "night";
}

/** Locale tag for Intl from uiLang store value. */
export function localeForUiLang(uiLang: string): string {
  if (uiLang === "ko") return "ko-KR";
  if (uiLang === "fr") return "fr-FR";
  return "en-US";
}

/**
 * Format like the mockup: "7월 31일 금요일" / "Friday, July 31" / "vendredi 31 juillet".
 * Month + day + weekday; no year (header is always "today").
 */
export function formatHeaderDate(date: Date, uiLang: string): string {
  const locale = localeForUiLang(uiLang);
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(date);
}

/** "HH:MM", 24h, locale-independent (hourCycle forced — en-US would otherwise pick 12h/AM-PM). */
export function formatHeaderTime(date: Date, uiLang: string): string {
  const locale = localeForUiLang(uiLang);
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}
