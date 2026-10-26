/**
 * 일출·일몰(위치 기반 계산, 네트워크 없음) — NOAA/Wikipedia "sunrise equation". 정확도 ±수 분(대기 굴절 -0.833° 보정 포함).
 * 극지의 백야·극야처럼 해가 뜨지/지지 않는 날은 null. `date` 는 **기기 로컬 달력 날짜**로 해석한다.
 */
export interface SunTimes {
  sunrise: Date;
  sunset: Date;
}

const RAD = Math.PI / 180;

export function sunTimes(date: Date, lat: number, lng: number): SunTimes | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const jd = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12) / 86_400_000 + 2_440_587.5;
  const n = Math.ceil(jd - 2_451_545.0 + 0.0008);
  const jStar = n - lng / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const transit = 2_451_545.0 + jStar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
  const sinDec = Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * sinDec) / (Math.cos(lat * RAD) * cosDec);
  if (!(cosH >= -1 && cosH <= 1)) return null;
  const h = Math.acos(cosH) / RAD;
  const toDate = (j: number) => new Date((j - 2_440_587.5) * 86_400_000);
  return { sunrise: toDate(transit - h / 360), sunset: toDate(transit + h / 360) };
}
