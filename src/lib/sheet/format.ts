// 셀 표시 서식 — Intl 만 쓴다(새 의존성 없음). specs/features/sheet.md 서식 결정.

import { isError, toText, type CellValue } from './eval';
import type { CellFmt } from './types';

/** 통화 기본값 = 앱 로케일 (ko ₩ / en $ / fr €). 그 밖은 USD. */
export function defaultCurrency(locale: string): string {
  const lang = locale.slice(0, 2).toLowerCase();
  return lang === 'ko' ? 'KRW' : lang === 'fr' ? 'EUR' : 'USD';
}

export interface FormatOpts {
  dp?: number;
  cur?: string;
  locale?: string;
}

function numeric(v: CellValue): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    return v.trim() !== '' && Number.isFinite(n) ? n : null;
  }
  return null;
}

function digits(dp: number | undefined): Intl.NumberFormatOptions {
  return dp === undefined ? {} : { minimumFractionDigits: dp, maximumFractionDigits: dp };
}

// `new Intl.NumberFormat(...)` 는 셀 하나당 수백 µs 다 — 그리드는 화면 가득한 셀마다 formatCell 을
// 부르므로 인스턴스를 재사용하지 않으면 그것만으로 프레임을 다 쓴다.
// ponytail: 상한 없는 Map. 키 공간 = 로케일 × 서식 × 소수자릿수 × 통화 = 수십 개(문서 하나가 쓰는
// 조합은 보통 서너 개)라 evict 가 필요할 규모가 아니다. 천장에 닿으면 LRU 로 바꾼다.
const intlCache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

function cachedIntl<T extends Intl.NumberFormat | Intl.DateTimeFormat>(key: string, make: () => T): T {
  const hit = intlCache.get(key);
  if (hit) return hit as T;
  const made = make();
  intlCache.set(key, made);
  return made;
}

/** 값 → 화면 문자열. 에러는 에러 코드 그대로, 형식이 맞지 않는 값은 원문 그대로 보여준다. */
export function formatCell(value: CellValue, fmt: CellFmt | undefined, opts: FormatOpts = {}): string {
  if (isError(value)) return value.error;
  if (value === null || value === undefined) return '';
  const locale = opts.locale ?? 'ko';

  switch (fmt) {
    case 'number': {
      const n = numeric(value);
      if (n === null) return String(toText(value));
      return cachedIntl(
        `n|${locale}|${opts.dp}`,
        () => new Intl.NumberFormat(locale, digits(opts.dp)),
      ).format(n);
    }
    case 'currency': {
      const n = numeric(value);
      if (n === null) return String(toText(value));
      const cur = opts.cur ?? defaultCurrency(locale);
      return cachedIntl(
        `c|${locale}|${opts.dp}|${cur}`,
        () => new Intl.NumberFormat(locale, { style: 'currency', currency: cur, ...digits(opts.dp) }),
      ).format(n);
    }
    case 'percent': {
      const n = numeric(value);
      if (n === null) return String(toText(value));
      return cachedIntl(
        `p|${locale}|${opts.dp}`,
        () => new Intl.NumberFormat(locale, { style: 'percent', ...digits(opts.dp) }),
      ).format(n);
    }
    case 'date': {
      const d = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(d.getTime())) return String(toText(value));
      return cachedIntl(
        `d|${locale}`,
        () => new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }),
      ).format(d);
    }
    case 'checkbox': {
      // ponytail: 텍스트 표현. P2 그리드는 이 값 대신 boolean 을 받아 진짜 체크박스를 그린다.
      const on = value === true || String(value).trim().toUpperCase() === 'TRUE' || numeric(value) === 1;
      return on ? '☑' : '☐';
    }
    default:
      return String(toText(value));
  }
}
