/** 날짜·시계 카드의 부가 정보 — 순수 함수(로컬 달력 기준). */

/** 로컬 시각 "HH:MM". */
export const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** 올해 N일째(1월 1일 = 1). 일광절약 전환일에도 어긋나지 않게 UTC 로 센다. */
export function dayOfYear(d: Date): number {
  return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / 86_400_000) + 1;
}

/** ISO 8601 주차(월요일 시작, 1월 4일이 든 주가 1주차). */
export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow); // 그 주의 목요일
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

/** 시침·분침 각도(도, 12시 방향 0, 시계 방향). */
export function handAngles(d: Date): { hour: number; minute: number } {
  const m = d.getMinutes();
  return { hour: ((d.getHours() % 12) + m / 60) * 30, minute: m * 6 };
}
