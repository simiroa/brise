import { getCurrentWindow } from "@tauri-apps/api/window";
import { callSilent } from "./invoke";
import { bootMark } from "./bootMark";
import { reportFallback } from "./diag";

/* 창 지오메트리 영속화 + 부팅 표시 순서를 한 곳에서 소유한다.
   App.tsx 는 언제 부를지(부팅 시점 / resize·move 디바운스)만 결정한다. */

/** 지금 창 상태를 저장 문자열로. 최소화 중이면 null (저장하면 안 되는 상태). */
export async function currentWindowGeometry(): Promise<string | null> {
  const win = getCurrentWindow();
  // 최소화된 창의 outerPosition 은 Windows 가 -32768 같은 센티널을 돌려준다. 그대로 저장하면
  // 다음 실행에서 화면 밖으로 복원돼 창을 찾을 수 없다(실제 발생: {"x":-32768,"y":-32768,...}).
  if (await win.isMinimized()) return null;
  const pos = await win.outerPosition();
  // size 는 inner 를 읽는다 — setSize 가 설정하는 것이 inner 이기 때문. outerSize 를 저장하면
  // 테두리(실측 18x10 physical)만큼 매 실행 커진다. position 은 setPosition ↔ outerPosition 이
  // 같은 축이라 outer 가 맞다(실측: 요청 300,400 → 복원 300,400 정확).
  const size = await win.innerSize();
  return JSON.stringify({
    x: pos.x,
    y: pos.y,
    width: size.width,
    height: size.height,
    maximized: await win.isMaximized(),
  });
}

/**
 * resize/move 를 디바운스해서 `save` 로 흘린다. 반환값은 해제 함수.
 *
 * 창을 닫는 중에는 저장하지 않는다 — 창이 해체되면서 resize 이벤트가 한 번 더 뜨고, 그 시점의
 * innerSize 는 프레임이 벗겨진 outer 크기를 돌려준다. 실측: 종료할 때마다 저장값이 +18x10
 * physical 씩 커졌다(1454 → 1472). 부팅 복원이 그 값을 그대로 쓰므로 창이 실행할수록 자란다.
 */
export function trackWindowGeometry(save: (geometry: string) => void): () => void {
  const win = getCurrentWindow();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  const unlisteners: Array<() => void> = [];

  const schedule = () => {
    if (closing) return;
    clearTimeout(timeout);
    timeout = setTimeout(async () => {
      if (closing) return;
      const geometry = await currentWindowGeometry().catch(() => null);
      if (geometry && !closing) save(geometry);
    }, 500);
  };

  void (async () => {
    unlisteners.push(await win.onResized(schedule));
    unlisteners.push(await win.onMoved(schedule));
    unlisteners.push(
      await win.onCloseRequested(() => {
        closing = true;
        clearTimeout(timeout);
      }),
    );
  })();

  return () => {
    closing = true;
    clearTimeout(timeout);
    for (const un of unlisteners) un();
  };
}

/** 한 프레임이 실제로 그려질 때까지. rAF 한 번은 새 스타일이 페인트되기 전에 발화한다. */
export function waitForPaintedFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/**
 * 창은 자기 모습이 확정된 뒤에 보여야 한다: 테마/CSS 변수 → (최대화) → 한 프레임 → show(). 창은
 * `visible: false` 로 만들어지므로(tauri.conf.json) 이 함수가 유일한 표시 경로다 — 실패해도 lib.rs 의
 * 5초 페일세이프가 창을 띄운다. loadTree() 보다 먼저 부른다: 트리를 기다리면 깜빡임 대신 빈 화면을 오래
 * 보여주게 된다.
 *
 * 크기·위치는 여기서 하지 않는다 — Rust 가 setup 에서 창이 숨겨진 채 이미 복원했다
 * (src-tauri/src/window_geometry.rs). 여기서 IPC 사슬(set_size → available_monitors → set_position)로
 * 하던 때는 그 대기가 창 표시를 늦췄다(2026-10-22 콜드 스타트 계측). 최대화만 남는 이유: Windows 의
 * maximize 는 숨긴 창을 그 자리에서 보이게 만들어 Rust 쪽(다 그리기 전)에서는 할 수 없다.
 */
export async function applyThemeGeometryAndShow(
  applyRoot: () => void,
  rawSettings?: Record<string, unknown>
): Promise<void> {
  applyRoot();

  try {
    let geomStr = rawSettings?.window_geometry as string | undefined;
    if (geomStr === undefined && rawSettings === undefined) {
      const res = await callSilent<{ settings: Record<string, unknown> }>("settings_get_all").catch(() => null);
      geomStr = res?.settings?.window_geometry as string | undefined;
    }
    if (geomStr && JSON.parse(geomStr).maximized) {
      await getCurrentWindow().maximize();
    }
  } catch (e) {
    reportFallback("boot", "geometry_maximize_failed", String(e));
  }

  await waitForPaintedFrame();
  bootMark("show");
  try {
    await getCurrentWindow().show();
  } catch {
    /* minimize/maximize/close 와 같은 취급 — show 실패가 부팅을 끊으면 안 된다 */
  }
}
