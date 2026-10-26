import { useSettingsStore } from '../stores/settings';
import { reportFallback } from '../lib/diag';
import { getDict, normalizeLang } from './locales';

// Dictionaries are loaded per locale on demand — see locales.ts (who loads what, and when).
// (No literal t-call examples in comments here — keysExist.test.ts scans
// every source file, comments included.)

const reportedMissing = new Set<string>();

function lookup(dict: unknown, keys: string[]): unknown {
  let current: any = dict;
  for (const key of keys) {
    if (current && typeof current === 'object' && key in current) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

export function t(path: string, params?: Record<string, string | number>): string {
  const lang = normalizeLang(useSettingsStore.getState().uiLang || 'en');
  const dict = getDict(lang);
  if (!dict && !reportedMissing.has(lang)) {
    // 언어를 바꾸는 경로가 사전을 먼저 받지 않았다는 뜻 — 화면에 키 문자열이 보인다(locales.ts 헤더).
    reportedMissing.add(lang);
    reportFallback('i18n', 'locale_not_loaded', lang);
  }
  const keys = path.split('.');

  // English is the fallback locale (unchanged contract) — loaded at idle after boot.
  let current = dict ? lookup(dict, keys) : undefined;
  if (typeof current !== 'string') current = lookup(getDict('en'), keys);
  if (typeof current !== 'string') return path;

  let result = current;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      result = result.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
    }
  }

  return result;
}
