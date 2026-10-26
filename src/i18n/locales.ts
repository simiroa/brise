/**
 * 로케일 사전 보관소 — 어떤 언어를 받아 두었는지, 아직 못 받았으면 받는 길.
 *
 * 왜 지연 로드인가(2026-10-22 콜드 스타트 계측): 세 로케일을 eager 로 묶던 때는 부팅 JS 4MB 중 ~850KB 가
 * 사전이었고, 쓰지 않는 두 언어까지 매 창 부팅마다 받아 평가했다. 이제는 창마다 **지금 언어만** 렌더 전에
 * 받는다(`bootLocales`). 영어는 폴백 사전이지만 check:i18n 이 세 로케일의 키 대칭을 보장하므로 부팅 뒤
 * 한가할 때 받는다.
 *
 * 지켜야 할 순서: `t()` 는 동기다. 그래서 언어가 **바뀌는** 모든 경로는 사전을 먼저 받고 나서 uiLang 을
 * 바꾼다(stores/settings.ts 의 load·setUiLang). 바뀐 뒤에 받으면 `key={uiLang}` 리마운트가 키 문자열로 그린다.
 *
 * 이 파일은 의존이 없어야 한다 — 테스트 setup 이 vi.mock 보다 먼저 import 한다(src/test/setup.ts).
 */

type Dict = Record<string, unknown>;

const LOADERS: Record<string, () => Promise<{ default: Dict }>> = {
  ko: () => import("./locale-ko"),
  en: () => import("./locale-en"),
  fr: () => import("./locale-fr"),
};

/** 모르는 언어 값은 영어로 본다(예전 `dicts[lang] || en` 과 같은 계약). */
export function normalizeLang(lang: string | null | undefined): string {
  return lang && lang in LOADERS ? lang : "en";
}

// 받아 둔 사전은 모듈 인스턴스가 아니라 전역에 둔다 — 앱에선 차이가 없고(인스턴스 하나), 테스트가
// vi.resetModules() 로 모듈을 새로 불러와도 setup 이 받아 둔 사전이 남는다(안 그러면 t() 가 키를 돌려준다).
const store = ((globalThis as { __briseLocales?: { dicts: Record<string, Dict>; inflight: Record<string, Promise<void>> } })
  .__briseLocales ??= { dicts: {}, inflight: {} });
const { dicts, inflight } = store;

export function getDict(lang: string): Dict | undefined {
  return dicts[normalizeLang(lang)];
}

const readyWaiters: Array<() => void> = [];

/**
 * 사전이 하나라도 있으면 바로, 없으면 첫 사전이 도착하는 즉시 부른다. 모듈 평가 시점에 번역 문자열이 필요한
 * 초기값(스토어 초기 상태 등)은 여기서 채운다 — 앱 청크는 사전과 병렬로 평가되므로 그 자리에서 t() 를 부르면
 * 키 문자열이 박힌다(moduleEvalLocale.test.ts). 렌더는 부팅이 사전을 기다린 뒤라 첫 화면은 이미 채워진 값을 본다.
 */
export function whenLocaleReady(cb: () => void): void {
  if (Object.keys(dicts).length > 0) cb();
  else readyWaiters.push(cb);
}

/** 이 언어 사전을 받아 둔다. 여러 번 불러도 한 번만 받는다. 실패하면 다음 호출이 다시 시도한다. */
export function ensureLocale(lang: string): Promise<void> {
  const l = normalizeLang(lang);
  if (dicts[l]) return Promise.resolve();
  if (!inflight[l]) {
    inflight[l] = LOADERS[l]().then(
      (m) => {
        dicts[l] = m.default;
        for (const cb of readyWaiters.splice(0)) cb();
      },
      (e: unknown) => {
        delete inflight[l];
        throw e;
      },
    );
  }
  return inflight[l];
}

// 지난번 이 기기에서 쓴 언어 — 설정을 읽기 전(첫 렌더)에 어느 사전을 받을지 정하는 데만 쓴다.
// 진짜 값은 설정(ui_lang)이고, 다르면 load() 가 그 사전을 받은 뒤 바꾼다(한 번 더 받는 것뿐 틀리지 않는다).
const HINT_KEY = "brise_ui_lang_hint";

export function rememberLocaleHint(lang: string): void {
  try {
    localStorage.setItem(HINT_KEY, normalizeLang(lang));
  } catch {
    // silent-ok: 힌트일 뿐이다 — 못 쓰면 다음 부팅이 기본 언어를 받고 load() 가 바로잡는다.
  }
}

function localeHint(): string | null {
  try {
    return localStorage.getItem(HINT_KEY);
  } catch {
    return null; // silent-ok: 위와 같다.
  }
}

/**
 * 창 부팅 — 첫 렌더 전에 await 한다. `storeDefault` 는 설정을 읽기 전 스토어의 uiLang(첫 렌더가 쓰는 값),
 * 힌트는 load() 뒤에 바뀔 값이다. 둘이 같으면(대부분) 사전 하나. 영어는 렌더 뒤 한가할 때.
 */
export async function bootLocales(storeDefault: string): Promise<void> {
  const hint = localeHint();
  await Promise.all([ensureLocale(storeDefault), hint ? ensureLocale(hint) : undefined]);
  const later = () => void ensureLocale("en").catch(() => {}); // silent-ok: 폴백 사전 — 실패는 t() 가 키를 돌려주며 진단에 남긴다.
  const w = globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(later, { timeout: 5000 });
  else setTimeout(later, 1000);
}

/** 테스트 전용 — 세 로케일을 전부 받아 둔다(src/test/setup.ts). */
export function loadAllLocalesForTests(): Promise<void> {
  return Promise.all(Object.keys(LOADERS).map(ensureLocale)).then(() => undefined);
}
