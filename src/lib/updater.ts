import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask } from "@tauri-apps/plugin-dialog";
import { isBrowser } from "./env";
import { flushAll } from "./invoke";
import { reportFallback } from "./diag";
import { t } from "../i18n/t";

/**
 * 자동 업데이트(docs/RELEASING.md). 상태는 이 다섯 개로 충분하다 — "declined"를 "latest"에
 * 욱여넣지 않는 이유: 업데이트가 있었는데 사용자가 거절한 것과, 애초에 최신인 것은 다른
 * 사실이라 테스트/호출자가 구분할 수 있어야 한다(호출자는 둘 다 "표시 안 함"으로 처리해도 됨).
 */
export type UpdateCheckResult = "latest" | "installed" | "declined" | "error" | "unavailable";

// 세션당 자동(무음) 확인 1회 — 수동 클릭(silent:false)은 이 게이트를 안 탄다.
let autoChecked = false;
// 동시 실행 가드: 진행 중이면 새 호출을 만들지 않고 같은 in-flight 프라미스를 돌려준다.
let inFlight: Promise<UpdateCheckResult> | null = null;

/**
 * 확인만 한 결과(PLAN-2026-10-24 §3 — runCheck 를 probe/install 로 나눴다). 설정 창 제품 카드가
 * "있음/최신"을 들고 있어야 해서 대화상자 없이 사실만 돌려주는 층이 필요했다.
 */
export type UpdateProbe =
  | { status: "available"; version: string; notes: string | null }
  | { status: "latest" }
  | { status: "error" }
  | { status: "unavailable" };

// probe 가 찾은 플러그인 Update 객체 — installUpdate 가 이걸 내려받는다(다시 check() 하지 않는다).
let pendingUpdate: Update | null = null;
let probeInFlight: Promise<UpdateProbe> | null = null;

/** 새 버전이 있는지만 확인한다(대화상자·설치 없음). 동시 호출은 한 번의 네트워크 확인을 공유한다. */
export function probeUpdate(): Promise<UpdateProbe> {
  if (isBrowser()) return Promise.resolve({ status: "unavailable" });
  if (probeInFlight) return probeInFlight;
  probeInFlight = (async (): Promise<UpdateProbe> => {
    try {
      const update = await check();
      pendingUpdate = update;
      if (!update) return { status: "latest" };
      return { status: "available", version: update.version, notes: update.body?.trim() || null };
    } catch (e) {
      // 화면엔 호출자가 "error" 로 표시하고, 원인(네트워크·서명·엔드포인트)은 진단에 남긴다(CLAUDE.md 함정 11).
      reportFallback("updater.probe", "check_failed", e instanceof Error ? e.message : String(e));
      return { status: "error" };
    }
  })().finally(() => {
    probeInFlight = null;
  });
  return probeInFlight;
}

/**
 * probe 가 찾아 둔 업데이트를 설치하고 재시작한다.
 * 내려받기 → 저장 → 설치 순서(AUDIT-2026-10-23 R2). Windows 설치기는 앱 프로세스를 끝내므로, 내려받는
 * 동안 이어 친 글(700ms 디바운스)이 설치 직전에 저장돼야 한다. downloadAndInstall 은 그 틈을 안 준다.
 * 이유 없는 flushAll — "close" 는 열린 AI 결과 세션까지 취소하므로(aiResultGate) 설치가 실패해 앱이
 * 계속 살 때 사용자 작업을 앗는다.
 * ponytail: 이 창에 등록된 저장만 비운다. 설정 창에서 설치하면 본 창 편집기는 대상이 아니다 — 실위험은
 * 본 창의 부팅 15초 뒤 자동 확인 경로라 거기서 덮인다. 창 간 저장 요청이 필요해지면 이벤트 + 확인 응답으로.
 */
export async function installUpdate(): Promise<"installed" | "error"> {
  const update = pendingUpdate;
  if (!update) return "error";
  try {
    await update.download();
    await flushAll();
    await update.install();
    // Windows는 설치 자체가 앱을 종료시키지만, 다른 플랫폼 대비 명시적으로 재시작한다.
    await relaunch().catch(() => {});
    return "installed";
  } catch (e) {
    // 호출자가 "error" 로 돌려받아 화면에 알리고, 원인은 진단에 남긴다.
    reportFallback("updater.install", "install_failed", e instanceof Error ? e.message : String(e));
    return "error";
  }
}

async function runCheck(): Promise<UpdateCheckResult> {
  const probe = await probeUpdate();
  if (probe.status !== "available") return probe.status;
  try {
    const accepted = await ask(t("settings.update_ask_message", { version: probe.version }), {
      title: t("settings.update_ask_title"),
      kind: "info",
    });
    if (!accepted) return "declined";
  } catch {
    // silent-ok: 대화상자 실패는 기존처럼 "error" 로 돌려준다.
    return "error";
  }
  return installUpdate();
}

/**
 * silent:true(부팅 15초 후 자동 확인)는 세션당 1회만 실제로 확인하고, 이후 호출은 즉시
 * "unavailable". silent:false(설정 창 수동 클릭)는 매번 실제로 확인한다. 업데이트를 찾으면
 * silent 여부와 무관하게 항상 ask() 확인창을 띄운다 — "무음"은 실패/미발견에만 적용된다.
 */
export async function checkForUpdates(opts: { silent: boolean }): Promise<UpdateCheckResult> {
  if (isBrowser()) return "unavailable";
  if (opts.silent) {
    if (autoChecked) return "unavailable";
    autoChecked = true;
  }
  if (inFlight) return inFlight;
  inFlight = runCheck().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
