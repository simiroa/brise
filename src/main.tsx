import React from "react";
import ReactDOM from "react-dom/client";
// W15 Part 2: tokens.css(스타일 변수 시트, JS 아님) 를 여기서 정적으로 올린다 — 이 파일 헤더의
// "static import 는 pet 과 full-app 양쪽에 실제로 필요할 때만" 예외에 정확히 해당한다: 오늘도
// 이미 **모든** 창(pet/pet-bubble: PetApp.tsx·PetBubbleApp.tsx 자체 import, settings/activity/
// ai-history: 전부 AuxWindowChrome.tsx 를 거치고 그게 import, 본 앱: App.tsx 가 import)이
// 이 파일을 로드한다 — 동적 청크 안에 한 겹 더 숨어 있을 뿐이다. 그래서 여기 올려도 어떤 창에도
// 새 무게가 붙지 않는다: 브라우저가 이 module 을 main.tsx 파싱 시점에 즉시(=JS 청크와 병렬로)
// 페치하기 시작할 뿐이다. 아래 "static import 금지" 규약은 **JS**(App 의 스토어/비즈니스 로직)
// 얘기다 — CSS 전용 import 는 그 청크를 전혀 끌고 오지 않으므로 이 규약 위반이 아니다. 이유는
// docs/RUNNING.md 가 아니라 이 파일 자신의 boot-appearance 웨이브 기록 참고(W15).
import "./styles/tokens.css";
import { bootMark } from "./lib/bootMark";

/**
 * Boot coordinator. The `#/pet` branch (W6-d1 scaffolding — see src/plugins/pet/PetApp.tsx) must
 * stay tiny: no note tree, no sync client, no settings-store hydration. Every module the full app
 * needs (App, stores/settings, mobile/MobileApp, ...) is behind a *dynamic* import below —
 * static imports would still get bundled/evaluated for the pet window even on a branch that
 * never runs them, defeating the whole point of a small pet webview. Only add a static import
 * here if it truly must run for BOTH the pet and the full-app path.
 *
 * 플러그인 규약(PLAN-2026-08-27-space-plugin-rebuild §2): 플러그인 창 엔트리(`src/plugins/<name>/`)는
 * **반드시 dynamic import**로만 분기한다. static import 를 하나라도 추가하면 그 청크가 메인 번들에
 * 합류해 플러그인 창이 메인 앱 코드를 통째로 먹는다. (tokens.css 는 위에서 이미 정적으로 올라가 있다 —
 * CSS 전용이라 이 경고가 막으려는 JS 번들 합류가 아니다. 새 static import 를 추가할 땐 그게 정말
 * JS 를 안 끌고 오는지부터 확인해라.)
 */
/**
 * 보조 창 공통 부팅: 앱 + Toast + (선택) 루트 ErrorBoundary, registerGlobalErrorHandlers 는 창당 1회(G3).
 * <Toast/> 가 있어야 이 창의 call()/emitNotice 토스트가 갈 곳이 생긴다. 로더는 호출부에서
 * `() => import("...")` 리터럴로 넘겨야 청크가 갈라진다 — 여기서 정적 import 하지 말 것.
 */
async function renderAuxWindow(
  root: ReactDOM.Root,
  loadApp: () => Promise<React.ComponentType>,
  errorBoundary: boolean,
  localeReady: Promise<void>,
) {
  // ErrorBoundary 청크는 필요한 창만 받는다(원래 settings/pet-bubble 은 받지 않았다).
  const [Comp, { Toast }, boundary, { registerGlobalErrorHandlers }] = await Promise.all([
    loadApp(),
    import("./components/Toast"),
    errorBoundary ? import("./components/common/ErrorBoundary") : undefined,
    import("./lib/globalErrorHandlers"),
    localeReady,
  ]);
  registerGlobalErrorHandlers();
  const ErrorBoundary = boundary?.ErrorBoundary;
  root.render(
    <React.StrictMode>
      {ErrorBoundary ? (
        <ErrorBoundary>
          <Comp />
        </ErrorBoundary>
      ) : (
        <Comp />
      )}
      <Toast />
    </React.StrictMode>,
  );
  markBooted();
}

async function boot() {
  bootMark("boot");
  const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

  // 펫은 창이 **둘**이다(W7-h): 캐릭터 창(#/pet, 고정 크기)과 말풍선/채팅 창(#/pet-bubble).
  // 둘 다 풀 앱 부팅을 건너뛰며 같은 작은 청크를 공유한다 — 이유는 src-tauri/src/pet_window.rs 헤더.
  if (location.hash === "#/pet") {
    const [{ PetApp }, { registerDiagOnlyErrorHandlers }] = await Promise.all([
      import("./plugins/pet/PetApp"),
      import("./lib/diag"),
    ]);
    // G3 (AUDIT-2026-09-26-fallback-observability.md §3): an unhandled rejection/uncaught error in
    // this window still reaches the diag sink — but no <Toast/> and no globalErrorHandlers.ts here.
    // This window is a tiny fixed-size transparent character sprite (see file header above): no
    // room for a toast, and globalErrorHandlers.ts would drag the whole i18n locale bundle into
    // this chunk just for a notice string nobody can see. lib/diag is already in this chunk via
    // lib/invoke, so the diag-only variant costs nothing.
    registerDiagOnlyErrorHandlers();
    root.render(
      <React.StrictMode>
        <PetApp />
      </React.StrictMode>,
    );
    markBooted();
    return;
  }

  // 언어 사전 — 펫 캐릭터 창(위) 말고는 모든 창이 t() 로 그리므로 렌더 전에 지금 언어 사전 하나를 받는다
  // (i18n/locales.ts 헤더). 앱 청크와 병렬로 받기 시작하고, 각 분기가 root.render 직전에 기다린다.
  const localeReady = Promise.all([import("./i18n/locales"), import("./stores/settings")]).then(
    ([{ bootLocales }, { useSettingsStore }]) => bootLocales(useSettingsStore.getState().uiLang),
  ).catch((e: unknown) =>
    // 사전을 못 받아도 창은 뜬다(키 문자열로 그려질 뿐) — 부팅 자체를 막지 않고 기록만 남긴다.
    import("./lib/diag").then(({ reportFallback }) => reportFallback("i18n", "locale_boot_failed", String(e))),
  );

  // 보조 OS 창 분기 — 각 창 앱은 여기서 `() => import("...")` 리터럴로 넘긴다(청크 분할 유지).
  // errorBoundary 차이: settings 는 SettingsWindowApp 이 자체 ErrorBoundary 를 안에 두고, pet-bubble 도
  // PetBubbleApp 이 내부에 둬서 루트 래핑을 하지 않는다(false). activity/ai-history/section 은 없어서 true.
  if (location.hash === "#/settings") {
    await renderAuxWindow(root, () => import("./settings/SettingsWindowApp").then((m) => m.SettingsWindowApp), false, localeReady);
    return;
  }
  if (location.hash === "#/activity") {
    await renderAuxWindow(root, () => import("./activity/ActivityWindowApp").then((m) => m.ActivityWindowApp), true, localeReady);
    return;
  }
  if (location.hash === "#/ai-history") {
    await renderAuxWindow(root, () => import("./ai-history/AiHistoryWindowApp").then((m) => m.AiHistoryWindowApp), true, localeReady);
    return;
  }
  if (location.hash === "#/briefing") {
    await renderAuxWindow(root, () => import("./briefing/BriefingWindowApp").then((m) => m.BriefingWindowApp), true, localeReady);
    return;
  }
  // 섹션 분리 창(#/section) — src-tauri/src/section_window.rs 헤더. 쿼리(note/section)는 해시 앞.
  if (location.hash === "#/section") {
    await renderAuxWindow(root, () => import("./section/SectionWindowApp").then((m) => m.SectionWindowApp), true, localeReady);
    return;
  }
  if (location.hash === "#/pet-bubble") {
    await renderAuxWindow(root, () => import("./plugins/pet/PetBubbleApp").then((m) => m.PetBubbleApp), false, localeReady);
    return;
  }

  // W1-(b)-1: ./App (데스크톱 트리) 은 더 이상 이 Promise.all 에 없다 — 모바일 분기는 App 을 전혀
  // 렌더하지 않는데도 그 청크(실측 502KB, 20파일)를 받고 평가하고 있었다. mobile 판정 뒤로 옮겨
  // 데스크톱 분기에서만 받는다(아래). initBrowserToken() 은 여전히 이 배열이 풀린 직후, 앱의 첫
  // call() 보다 먼저 실행된다는 순서 계약을 유지한다 — App 청크를 나중에 받는 것과 무관하다.
  // 데스크톱(Tauri) 본 창이면 App 청크를 지금 바로 받기 시작한다 — 아래 Promise.all 이 끝난 뒤에야
  // import 하던 때는 "부팅 모듈 → App 청크(+정적 의존 수십 개)" 가 줄줄이 이어져 그 사이 메인 스레드가
  // 놀았다(2026-10-22 CPU 프로필: 부팅 앞 250ms 중 ~200ms 유휴). 브라우저 모드는 모바일일 수 있어
  // (모바일은 App 을 안 쓴다) 판정 뒤에 받던 대로 둔다(W1-(b)-1).
  const appChunk = "__TAURI_INTERNALS__" in window ? import("./App") : null;
  const [
    { Toast },
    { ErrorBoundary },
    { useSettingsStore },
    { applySavedAppearanceSeed },
    { initBrowserToken, isBrowser, isMobileViewport },
    { registerGlobalErrorHandlers },
  ] = await Promise.all([
    import("./components/Toast"),
    import("./components/common/ErrorBoundary"),
    import("./stores/settings"),
    import("./lib/appearance"),
    import("./lib/env"),
    import("./lib/globalErrorHandlers"),
  ]);

  // W13: registers once for this window (the full desktop/mobile app) — every other branch above
  // does the same for its own window (see globalErrorHandlers.ts header: "exactly once per
  // window"). <Toast/> below is what gives emitNotice() (used by the handlers) anywhere to land.
  // See globalErrorHandlers.ts header for the double-toast trap this has to avoid.
  registerGlobalErrorHandlers();
  bootMark("modules");

  // Browser mode (sync server serving /app/?token=...): capture the token into sessionStorage and
  // scrub it from the address bar BEFORE anything below issues its first call() — isBrowser()
  // (lib/env.ts) reads the token to decide whether to route over HTTP, and the settings load right
  // below is the very first call the app makes.
  initBrowserToken();

  // WAVE K — React 렌더 이전에 동기로 외형 시드 적용 (첫 페인트 스타일 지연 깜빡임 방지)
  applySavedAppearanceSeed();

  useSettingsStore.getState().load();

  // 브라우저 모드 + 좁은 뷰포트(폰) = 모바일 레이아웃. 부트 시 1회 판정 — 폰은 뷰포트 클래스가
  // 바뀌지 않고, 데스크톱 브라우저 창을 좁혔다 넓히는 경우는 새로고침으로 충분하다.
  const mobile = isBrowser() && isMobileViewport();
  // 화면 청크는 사전을 기다리기 **전에** 받기 시작한다 — 기다린 뒤에 import 하면 폰(tailnet)에서 사전 → 앱
  // 청크가 줄줄이 이어진다. 모바일 청크는 이 분기에서만 받는다(위 Promise.all 에 있던 때는 데스크톱 부팅도 매번
  // 받아 평가했다, 2026-10-22 콜드 스타트 계측). App 청크를 데스크톱 분기에서만 받는 것(W1-(b)-1)과 같은 이유.
  const mobileChunk = mobile ? import("./mobile/MobileApp") : null;
  const desktopChunk = mobile ? null : (appChunk ?? import("./App"));
  await localeReady;
  bootMark("locale");

  if (mobileChunk) {
    const { MobileApp } = await mobileChunk;
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <MobileApp />
        </ErrorBoundary>
        <Toast />
      </React.StrictMode>,
    );
    markBooted();
    return;
  }

  // 데스크톱 분기에서만 App 청크를 받는다(W1-(b)-1) — 위 헤더 주석 참고.
  const { default: App } = await desktopChunk!;
  bootMark("app-chunk");
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
      <Toast />
    </React.StrictMode>,
  );
  markBooted();
}

/** U-12: index.html 의 부팅 실패 안내가 '#root 가 비었다'가 아니라 이 플래그로 판정한다(펫 말풍선 창은 정상적으로 비어 있을 수 있다). */
function markBooted() {
  (window as unknown as { __briseBooted?: boolean }).__briseBooted = true;
}

void boot();
