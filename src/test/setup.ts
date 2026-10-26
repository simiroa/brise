// vitest 글로벌 setup.
//
// 2026-08-14 까지 이 파일은 dialogPolyfill.ts 였다 — jsdom 이 <dialog>.showModal()/close() 와 그
// 부수효과(포커스 진입·복원, Escape→cancel)를 구현하지 않아서 ModalShell 을 렌더하는 모든 테스트가
// 그 폴리필에 의존했다. ModalShell 이 top layer 를 버리고 일반 레이어 스크림+카드로 내려오면서
// (이유: ModalShell.tsx 헤더) 폴리필 부분은 통째로 삭제됐고, 남은 건 아래 uiLang 기본값 하나다.

// --- uiLang test default ---
// settings.ts now seeds uiLang="ko" (matching the Rust seed). Tests that assert English i18n
// strings would break without an explicit locale override. A global beforeEach here keeps every
// test on English by default; individual tests may still set uiLang to something else.
import { beforeEach } from "vitest";
// 사전은 앱에서 언어별 지연 로드다(i18n/locales.ts) — 테스트는 t() 를 동기로 부르므로 세 로케일을 미리 받는다.
// locales.ts 는 의존이 없어 여기서 정적으로 불러도 테스트 파일의 vi.mock 보다 먼저 실모듈을 끌고 오지 않는다.
import { loadAllLocalesForTests } from "../i18n/locales";
await loadAllLocalesForTests();
beforeEach(async () => {
  // Lazy import: several test files vi.mock("…/lib/invoke") at the module level. If we
  // statically import useSettingsStore here (top of file), the real invoke module gets pulled
  // in before the test file's vi.mock can intercept it, causing "Cannot read properties of
  // undefined (reading 'invoke')" in Tauri-less jsdom. A dynamic import() inside beforeEach
  // runs after vi.mock hoisting has taken effect, so the mocked invoke is already in place.
  // 브리핑 요청 캐시는 모듈 스코프 — 테스트 간 응답이 새지 않게 비운다.
  (await import("../briefing/requestCache")).resetRequestCache();
  // 노트 메타 조회 캐시(lib/noteFetchCache.ts)도 모듈 스코프 — 같은 노트 id 를 쓰는 테스트끼리 값이 새지 않게.
  (await import("../lib/noteFetchCache")).resetNoteFetchCaches();
  const { useSettingsStore } = await import("../stores/settings");
  // Some test files vi.mock this store with a plain function/object lacking setState
  // (e.g. useAttachmentActions.test.tsx, MapPlaceSearch.test.tsx, NoteSelectionBar.test.tsx).
  // Guard + try/catch so a mocked module shape never throws here.
  try {
    if (typeof useSettingsStore?.setState === "function") {
      useSettingsStore.setState({ uiLang: "en" });
    }
  } catch {
    // mocked shape without setState — nothing to do
  }
});

// --- jsdom Range geometry ---
// jsdom's Range has no getClientRects/getBoundingClientRect. ProseMirror's scrollToSelection
// (any TipTap `focus()` / `scrollIntoView()` whose DOM selection sits in a text node) calls them
// and throws `target.getClientRects is not a function` as an *uncaught* exception — order-dependent,
// because it only happens once the DOM selection actually lands inside the editor. Zero-size rects
// make PM treat the caret as already visible and do nothing (2026-09-15, AskAiComposer tests).
const rangeProto = globalThis.Range?.prototype as (Range & { getClientRects?: unknown }) | undefined;
if (rangeProto && typeof rangeProto.getClientRects !== "function") {
  const zero = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  rangeProto.getClientRects = () => [] as unknown as DOMRectList;
  rangeProto.getBoundingClientRect = zero;
}
