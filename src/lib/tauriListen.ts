/**
 * Tauri 이벤트 구독 공용 헬퍼.
 *
 * - `listenMany`: 펫 다리 여럿(petSuggestionsBridge.ts·petClipboardBridge.ts 등)이 각자 되풀이하던
 *   listen() 보일러플레이트 — cancelled 플래그 + unlisten 누적 + 일괄 해제 — 를 하나로 묶는다.
 * - `createSharedSubscription` / `listenShared`: 창(JS 컨텍스트) 하나에 실제 Tauri 구독을 하나만 두고
 *   JS 안에서 구독자들에게 나눠 준다. 구독·해제가 IPC 왕복이라, 뷰가 바뀔 때마다 마운트되는
 *   컴포넌트가 각자 listen 하면 노트 하나 열 때마다 왕복이 수십 번 생긴다(useFileDropZone 실측).
 *
 * 공통 규약: 해제 함수는 **동기적으로** 끊는다 — 해제가 반환된 뒤에는 핸들러가 다시 불리지 않는다.
 * 실제 unlisten 은 비동기(listen() 완료 전일 수 있음)라 그 사이 도착한 이벤트가 언마운트된 컴포넌트를
 * 건드리던 경합을 JS 쪽 플래그로 막는다.
 */
import { listen, type EventCallback } from "@tauri-apps/api/event";

/** 구독할 이벤트 이름과 핸들러 쌍. 펫 다리는 `ListenSpec<PetEventName>` 으로 좁힌다. */
export type ListenSpec<E extends string = string> = readonly [event: E, handler: EventCallback<any>];

/** specs 를 모두 구독하고, 한 번에 해제하는 cleanup 함수를 돌려준다.
 *  ponytail: 호출마다 실제 listen 을 건다(공유 안 함). 호출자들이 창 수명 동안 한 번 마운트되는
 *  자리(App·펫 다리·설정)라 공유해도 왕복이 줄지 않고, 브리지 테스트들이 "호출마다 listen() 이
 *  새로 불린다"는 목 모양에 기대고 있다. 뷰 전환마다 붙는 자리가 생기면 listenShared 로 옮긴다. */
export function listenMany<E extends string>(specs: readonly ListenSpec<E>[]): () => void {
  let cancelled = false;
  const unlistens: Array<() => void> = [];
  for (const [event, handler] of specs) {
    // 해제 뒤 도착한 이벤트(실제 unlisten 이 아직 안 끝났을 때)는 핸들러까지 가지 않는다.
    // 반환값은 그대로 넘긴다 — 테스트가 비동기 핸들러의 Promise 를 await 한다.
    const guarded: EventCallback<any> = (e) => (cancelled ? undefined : handler(e));
    // .catch(): 테스트 환경(jsdom, Tauri IPC 없음)에서는 listen() 이 reject 한다 —
    // PetSprite.tsx의 usePetPackage/usePetAsset과 같은 패턴. 여기서 안 삼키면 이 래퍼를 쓰는
    // 8개 브리지 전부가 각자 미처리 rejection 을 낼 수 있다(무관한 테스트 파일에 노이즈로 샌다).
    void listen(event, guarded)
      .then((fn) => {
        if (cancelled) fn();
        else unlistens.push(fn);
      })
      .catch(() => {});
  }
  return () => {
    cancelled = true;
    unlistens.forEach((fn) => fn());
  };
}

/** 실제 구독 하나를 여러 구독자에게 나눠 주는 공유 구독.
 *
 * 수명은 참조 카운트 — 마지막 구독자가 떠나면 **마이크로태스크 한 번 뒤** 실제로 해제한다.
 * 같은 커밋 안의 언마운트→마운트(뷰 전환으로 존이 바뀌어 끼는 경우, StrictMode 이중 마운트)는
 * React 가 passive effect 를 한 번에 동기로 돌리므로 그 사이에 구독자가 다시 생겨 왕복이 0 이다.
 * ponytail: 창 수명 동안 계속 살려 두면(keep-alive) 대시보드↔노트 왕복도 0 이 되지만, 드롭 존
 * 테스트들(AskAiModal·OnboardingImportStep·PetPackageGallery)이 "마지막 언마운트 = 실제 해제"에
 * 기대어 beforeEach 에서 핸들러를 비운다 — 그 목들을 먼저 고쳐야 한다.
 *
 * `subscribeReal` 이 reject 하면(Tauri 밖 — vite/테스트) 그 항목을 버려 다음 구독자가 다시 시도한다. */
export function createSharedSubscription<T>(
  subscribeReal: (dispatch: (value: T) => void) => Promise<() => void>
): (handler: (value: T) => void) => () => void {
  interface Entry {
    subs: Set<(value: T) => void>;
    unlisten?: () => void;
    released: boolean;
  }
  let current: Entry | null = null;

  const release = (entry: Entry) => {
    if (entry.subs.size > 0 || entry.released) return;
    entry.released = true;
    if (current === entry) current = null;
    entry.unlisten?.();
  };

  return (handler) => {
    let entry = current;
    if (!entry) {
      const fresh: Entry = { subs: new Set(), released: false };
      current = entry = fresh;
      const dispatch = (value: T) => {
        if (fresh.released) return;
        // 스냅샷을 돌되 매번 has() 확인 — 디스패치 중 형제가 해제되면 그 형제는 부르지 않는다.
        for (const h of [...fresh.subs]) if (fresh.subs.has(h)) h(value);
      };
      void subscribeReal(dispatch)
        .then((un) => {
          if (fresh.released) un();
          else fresh.unlisten = un;
        })
        .catch(() => {
          // silent-ok: Tauri 밖(vite/jsdom)에선 구독 자체가 없다 — 항목을 버려 다음 구독자가 재시도.
          fresh.released = true;
          if (current === fresh) current = null;
        });
    }
    const target = entry;
    // 같은 핸들러가 두 번 구독해도 각자 따로 해제되도록 감싼다.
    const wrapped = (value: T) => handler(value);
    target.subs.add(wrapped);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      target.subs.delete(wrapped);
      if (target.subs.size === 0) queueMicrotask(() => release(target));
    };
  };
}

const sharedByEvent = new Map<string, (handler: EventCallback<any>) => () => void>();

/** 이벤트 이름당 실제 listen() 하나를 공유해 구독한다. 해제는 동기(반환 뒤 핸들러 호출 없음).
 *  기본 대상(Any)으로만 듣는다 — emit_to 로 이 창에 보낸 이벤트도 그대로 받는다(listen() 기본과 같다). */
export function listenShared<T = unknown>(event: string, handler: EventCallback<T>): () => void {
  let subscribe = sharedByEvent.get(event);
  if (!subscribe) {
    subscribe = createSharedSubscription<Parameters<EventCallback<any>>[0]>((dispatch) => listen(event, dispatch));
    sharedByEvent.set(event, subscribe);
  }
  return subscribe(handler as EventCallback<any>);
}
