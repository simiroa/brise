import { describe, it, expect, vi } from "vitest";

// 모듈을 불러오는 순간(모듈 평가)에 t() 를 부르는 코드를 잡는다.
//
// 왜: 사전은 언어별 지연 로드다(locales.ts). 창 부팅은 렌더 전에 사전을 기다리지만, 앱 청크는 사전과
// **병렬로** 받아 도착하는 대로 평가된다 — 평가 시점에 t() 를 부르면(예: 스토어 초기 상태에 번역 문자열을
// 굽기) 사전이 아직 없어 키 문자열이 박힌다. 2026-10-22 실측: AI 프리셋 스토어 초기 목록이 그랬다
// (릴리스 빌드 콜드 스타트마다 `locale_not_loaded` 진단). 번역은 렌더·호출 시점에 한다.

const misses: string[] = [];

vi.mock("./locales", async (importOriginal) => {
  const real = await importOriginal<typeof import("./locales")>();
  return {
    ...real,
    getDict: (lang: string) => {
      const d = real.getDict(lang);
      if (!d) misses.push(new Error().stack ?? "");
      return d;
    },
  };
});

/** 스택에서 t()·사전 모듈을 벗어난 첫 호출자(파일:줄). */
function caller(stack: string): string {
  const frames = stack.split("\n").slice(1).map((l) => l.trim());
  const f = frames.find((l) => !/i18n[\\/](t|locales|moduleEvalLocale)/.test(l) && /src[\\/]/.test(l));
  return (f ?? frames[0] ?? "").replace(/^at\s+/, "").replace(/.*?(src[\\/])/, "$1");
}

// 각 창이 부팅 때 평가하는 모듈 — main.tsx 의 분기와 같다(펫 캐릭터 창은 t() 를 쓰지 않아 뺀다).
const ENTRIES: Array<[string, () => Promise<unknown>]> = [
  ["stores/settings", () => import("../stores/settings")],
  ["lib/appearance", () => import("../lib/appearance")],
  ["lib/globalErrorHandlers", () => import("../lib/globalErrorHandlers")],
  ["components/Toast", () => import("../components/Toast")],
  ["components/common/ErrorBoundary", () => import("../components/common/ErrorBoundary")],
  ["App", () => import("../App")],
  ["mobile/MobileApp", () => import("../mobile/MobileApp")],
  ["settings/SettingsWindowApp", () => import("../settings/SettingsWindowApp")],
  ["activity/ActivityWindowApp", () => import("../activity/ActivityWindowApp")],
  ["ai-history/AiHistoryWindowApp", () => import("../ai-history/AiHistoryWindowApp")],
  ["briefing/BriefingWindowApp", () => import("../briefing/BriefingWindowApp")],
  ["section/SectionWindowApp", () => import("../section/SectionWindowApp")],
  ["plugins/pet/PetBubbleApp", () => import("../plugins/pet/PetBubbleApp")],
];

describe("모듈 평가 시점의 t()", () => {
  it("창 진입 모듈을 불러오는 동안 t() 를 부르지 않는다(사전이 아직 없을 수 있다)", async () => {
    const store = (globalThis as { __briseLocales?: { dicts: Record<string, unknown> } }).__briseLocales!;
    const saved = { ...store.dicts };
    for (const k of Object.keys(store.dicts)) delete store.dicts[k];
    vi.resetModules();
    misses.length = 0;
    try {
      for (const [, load] of ENTRIES) await load();
    } finally {
      Object.assign(store.dicts, saved);
    }
    const callers = [...new Set(misses.map(caller))];
    expect(callers).toEqual([]);
  }, 180_000);
});
