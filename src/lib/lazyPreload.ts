/**
 * 앱의 **유일한** 지연 로드 컴포넌트 생성기 — `React.lazy` 를 직접 쓰지 않는다(check:surface ⓔ 가 막는다).
 *
 * 왜 따로 두나(2026-10-22 실측): React 19 는 Suspense 가 대기 화면(fallback)을 한 번 보인 뒤 내용으로
 * 바꾸는 커밋을 **최소 300ms** 미룬다(react-dom `globalMostRecentFallbackTime + 300`). 청크가 5ms 만에
 * 와도 대시보드 관계·타임라인·달력 탭의 첫 클릭이 ~310ms 동안 빈칸이었다. 맨 `lazy()` 는 이미 받아 둔
 * 모듈이어도 매번 비동기 thenable 을 돌려줘 한 번은 반드시 대기 화면을 거친다.
 *
 * 여기서는 ① 모듈을 미리 받아 두고(`preload()` — 의도·유휴 시간), ② 받아 둔 뒤의 렌더에는 **동기로
 * 해결되는 thenable** 을 건네 React 가 대기 화면 없이 바로 그리게 한다. 못 받은 채 그려지면(첫 클릭이 미리
 * 받기보다 빠를 때) 예전처럼 대기 화면 → 300ms 를 겪고, 그 사실을 진단에 남긴다(`lazy_fallback_shown`).
 *
 * 미리 받는 때:
 * - **의도**: 그 화면을 여는 버튼에 `preloadIntentProps(X)` 를 펼친다(마우스 올림·포커스·누르기 시작).
 * - **유휴**: `{ idle: "main" | "settings" }` 로 만든 것은 그 창이 부팅을 마친 뒤 한가할 때 차례로 받는다
 *   (`startIdlePreload(group)` — App·SettingsPanel 이 부른다). 브라우저 모드(폰)는 데이터를 아끼려고 유휴 받기를 하지 않는다.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { reportFallback } from "./diag";

type Loader<T> = () => Promise<{ default: T }>;
/** "main" = 본 창(App 부팅 끝), "settings" = 설정 창(SettingsPanel 마운트). */
export type IdleGroup = "main" | "settings";

export type PreloadableComponent<T extends ComponentType<any>> = LazyExoticComponent<T> & {
  /** 모듈을 받아 둔다. 여러 번 불러도 한 번만 받는다. 실패하면 다음 호출이 다시 시도한다. */
  preload: () => Promise<void>;
  /** 이미 받아 두었는가(테스트·진단용). */
  readonly loaded: boolean;
};

export interface LazyPreloadOptions {
  /** 진단 기록에 쓰는 이름(예: "home.graph"). */
  name: string;
  /** 이 창 그룹이 부팅을 마친 뒤 유휴 시간에 미리 받는다 — 자주 여는 화면만. 그룹을 나누는 이유: 레지스트리
   *  (src/lazySurfaces.ts)는 모든 창이 같이 불러오므로, 그룹이 없으면 본 창이 설정 창 페이지까지 받는다. */
  idle?: IdleGroup;
}

const idleQueue: Array<{ name: string; group: IdleGroup; preload: () => Promise<void> }> = [];
let idleGroup: IdleGroup | null = null;

export function lazyPreload<T extends ComponentType<any>>(
  loader: Loader<T>,
  opts: LazyPreloadOptions,
): PreloadableComponent<T> {
  let mod: { default: T } | null = null;
  let inflight: Promise<{ default: T }> | null = null;

  const load = (): Promise<{ default: T }> => {
    if (mod) return Promise.resolve(mod);
    if (!inflight) {
      inflight = loader().then(
        (m) => {
          mod = m;
          return m;
        },
        (e: unknown) => {
          inflight = null; // 다음 의도·렌더가 다시 시도하게
          throw e;
        },
      );
    }
    return inflight;
  };

  const Comp = lazy(() => {
    if (mod) {
      // 동기 thenable — React 의 lazy 초기화가 then 안에서 바로 '해결됨' 으로 바뀌어 대기 화면을 건너뛴다.
      const ready = mod;
      return { then: (resolve: (m: { default: T }) => void) => resolve(ready) } as unknown as Promise<{ default: T }>;
    }
    reportFallback("lazy", "lazy_fallback_shown", opts.name);
    return load();
  }) as PreloadableComponent<T>;

  Object.defineProperty(Comp, "loaded", { get: () => mod !== null });
  Comp.preload = () =>
    load().then(
      () => undefined,
      (e: unknown) => {
        reportFallback("lazy", "lazy_preload_failed", `${opts.name}: ${String(e)}`);
      },
    );

  if (opts.idle) {
    idleQueue.push({ name: opts.name, group: opts.idle, preload: Comp.preload });
    if (idleGroup === opts.idle) scheduleIdleDrain();
  }
  return Comp;
}

/** 버튼·탭·메뉴 항목에 펼친다 — 마우스를 올리거나 포커스하거나 누르기 시작하면 미리 받는다. */
export function preloadIntentProps(...targets: Array<{ preload: () => Promise<void> }>) {
  const go = () => {
    for (const t of targets) void t.preload();
  };
  return { onPointerEnter: go, onFocus: go, onPointerDown: go };
}

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
};

function scheduleIdleDrain(): void {
  const w = window as IdleWindow;
  const take = () => {
    const i = idleQueue.findIndex((q) => q.group === idleGroup);
    return i < 0 ? undefined : idleQueue.splice(i, 1)[0];
  };
  const next = () => {
    const item = take();
    if (!item) return;
    void item.preload().finally(() => schedule());
  };
  const schedule = () => {
    if (!idleQueue.some((q) => q.group === idleGroup)) return;
    if (w.requestIdleCallback) w.requestIdleCallback(next, { timeout: 3000 });
    else setTimeout(next, 200);
  };
  schedule();
}

/**
 * 이 창 그룹의 유휴 미리 받기를 시작한다 — 창 부팅이 끝난 뒤 한 번. 이후 만들어지는 같은 그룹의 컴포넌트도
 * 큐에 들어오는 대로 받는다. 브라우저 모드(폰·태블릿)에서는 아무것도 하지 않는다(데이터 절약 — 오너 결정
 * 2026-10-22: 폰은 의도 미리 받기만).
 */
export function startIdlePreload(group: IdleGroup, browserMode = false): void {
  if (idleGroup || browserMode || typeof window === "undefined") return;
  idleGroup = group;
  scheduleIdleDrain();
}

/** 테스트 전용 — 모듈 상태를 비운다. */
export function __resetLazyPreloadForTests(): void {
  idleQueue.length = 0;
  idleGroup = null;
}
