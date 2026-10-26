/**
 * 음력(한국 음력, dangi) → 양력 — 매년 음력 기념일(생일·제사)을 그해 달력에 떨어뜨린다
 * (docs/PLAN-2026-09-19-calendar-schedule.md §3, 오너 결정 D1).
 *
 * 변환표를 들이지 않는다: `Intl.DateTimeFormat(..., { calendar: "dangi" })` 가 양력 날짜의 음력 월/일을
 * 알려준다(WebView2·Node 모두 지원 — 2026-02-17 → 음 1.1, 2025-07-25 → 윤6.1 실측). 그래서 양력 한 해를
 * 하루씩 훑어 "음력 (월, 일) → 그해 양력 날짜들" 표를 만들고 연도별로 캐시한다(365번 format, 한 해 한 번).
 *
 * 규칙(관례):
 *   - 윤달의 날은 기념일로 치지 않는다 — 음력 생일은 평달 날짜로 쇤다.
 *   - 그해 그 음력 달이 29일로 끝나면 30일 기념일은 29일로 옮긴다.
 *   - 한 양력 해 안에 같은 음력 날이 두 번 올 수 있다(음력 12월 말 ↔ 1월 초 경계) — 둘 다 돌려준다.
 */

const fmt = (() => {
  try {
    return new Intl.DateTimeFormat("en-u-ca-dangi", { month: "numeric", day: "numeric", timeZone: "UTC" });
  } catch {
    return null;
  }
})();

type LunarYearTable = {
  /** "M-D"(평달) → 그해 양력 ISO 날짜들. */
  days: Map<string, string[]>;
  /** 평달 M 의 마지막 날(29|30) — 그 달이 이 해에 두 번 걸치면 뒤의 것. */
  monthLength: Map<number, number>;
};

const cache = new Map<number, LunarYearTable | null>();

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function buildYear(year: number): LunarYearTable | null {
  if (!fmt) return null;
  const days = new Map<string, string[]>();
  const monthLength = new Map<number, number>();
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  for (let t = start; t < end; t += 86_400_000) {
    const parts = fmt.formatToParts(new Date(t));
    const monthRaw = parts.find((p) => p.type === "month")?.value ?? "";
    const dayRaw = parts.find((p) => p.type === "day")?.value ?? "";
    // 윤달은 "6bis" 처럼 숫자 뒤에 표지가 붙는다 — 숫자만이 아니면 윤달.
    if (!/^\d+$/.test(monthRaw)) continue;
    const m = Number(monthRaw);
    const d = Number(dayRaw);
    if (!m || !d) continue;
    const d0 = new Date(t);
    const iso = `${d0.getUTCFullYear()}-${pad(d0.getUTCMonth() + 1)}-${pad(d0.getUTCDate())}`;
    const key = `${m}-${d}`;
    const list = days.get(key);
    if (list) list.push(iso);
    else days.set(key, [iso]);
    monthLength.set(m, Math.max(monthLength.get(m) ?? 0, d));
  }
  return { days, monthLength };
}

function table(year: number): LunarYearTable | null {
  if (!cache.has(year)) cache.set(year, buildYear(year));
  return cache.get(year) ?? null;
}

/**
 * 양력 `year` 안에서 음력 `month`/`day`(평달)가 떨어지는 양력 ISO 날짜들. 대개 1개, 경계에선 0~2개.
 * Intl 이 dangi 를 모르면 빈 배열(표시만 빠진다 — 앱이 깨지지 않는다).
 */
export function lunarToSolarDays(year: number, month: number, day: number): string[] {
  const tbl = table(year);
  if (!tbl) return [];
  const exact = tbl.days.get(`${month}-${day}`);
  if (exact) return exact;
  // 30일 기념일인데 이 해 그 달이 29일로 끝남 → 29일로.
  if (day === 30) return tbl.days.get(`${month}-29`) ?? [];
  return [];
}

/** 양력 ISO 날짜의 음력 (월, 일, 윤달?) — 목록에서 "음 3.15" 를 보여 줄 때. */
export function solarToLunar(iso: string): { month: number; day: number; leap: boolean } | null {
  if (!fmt) return null;
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  const parts = fmt.formatToParts(new Date(t));
  const monthRaw = parts.find((p) => p.type === "month")?.value ?? "";
  const day = Number(parts.find((p) => p.type === "day")?.value ?? "");
  const month = parseInt(monthRaw, 10);
  if (!month || !day) return null;
  return { month, day, leap: !/^\d+$/.test(monthRaw) };
}
