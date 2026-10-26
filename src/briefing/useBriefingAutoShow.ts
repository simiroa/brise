import { useEffect } from "react";
import { call, callSilent } from "../lib/invoke";
import { isBrowser } from "../lib/env";
import { useSettingsStore } from "../stores/settings";
import { reportFallback } from "../lib/diag";
import { runBriefingHooks } from "./automationHooks";
import { buildBriefingSummary } from "./briefingSummary";
import { localDayOf, shouldShowBriefing, type BriefingKind, type BriefingTrigger } from "./shouldShowBriefing";

const TICK_MS = 60_000;

/** 하루에 한 번만 시도한다(성공·실패 무관) — 실패 시 무한 재시도 방지. 세션(모듈) 단위, 종류별. */
const attemptedDay: Record<BriefingKind, string> = { morning: "", evening: "" };

/**
 * 판정 → (훅) → OS 알림 및/또는 창 열기 → 열린 뒤 lastShown 저장. 테스트용으로 export.
 * 아침·저녁이 동시에 해당되면(밤늦게 켠 경우) 저녁 회고만 띄우고 아침은 오늘 것으로 소진한다 —
 * 밤 9시에 "오늘 하루 시작" 브리핑을 보여 줄 이유가 없다.
 */
export async function runBriefingAutoShow(now: Date, trigger: BriefingTrigger): Promise<void> {
  const st = useSettingsStore.getState();
  if (!st.loaded) return; // 설정 로드 전 기본값으로 판정하면 안 된다 — 다음 tick 이 다시 본다.
  const today = localDayOf(now);
  const s = {
    enabled: st.briefingEnabled,
    when: st.briefingWhen,
    time: st.briefingTime,
    lastShown: st.briefingLastShown,
    eveningEnabled: st.briefingEveningEnabled,
    eveningTime: st.briefingEveningTime,
    lastShownEvening: st.briefingLastShownEvening,
  };
  const due = (k: BriefingKind) => attemptedDay[k] !== today && shouldShowBriefing(now, s, trigger, k);
  const evening = due("evening");
  if (evening && due("morning")) {
    attemptedDay.morning = today;
    try {
      await st.setBriefingLastShown(today);
    } catch {
      // silent-ok: 저장 실패해도 세션 내 재시도는 attemptedDay 가 막고, 다음 실행엔 아침이 한 번 더 뜰 뿐이다.
    }
  }
  if (evening) return showOnce("evening", today, now);
  if (due("morning")) return showOnce("morning", today, now);
}

async function showOnce(kind: BriefingKind, today: string, now: Date): Promise<void> {
  const st = useSettingsStore.getState();
  attemptedDay[kind] = today;
  const ctx = { kind, day: today };
  await runBriefingHooks("before_show", ctx);

  let showWindow = st.briefingNotify !== "os";
  if (st.briefingNotify !== "window") {
    // 앱 알림 마스터가 꺼져 있으면 notify_send 가 ok:false 로 조용히 억제한다 → 창으로 폴백(알림이 아예 안 가는 건 방지).
    let sent = false;
    try {
      const sum = await buildBriefingSummary(now, kind);
      if (sum) sent = (await callSilent<{ ok: boolean }>("notify_send", sum)).ok;
    } catch {
      // callSilent 가 진단을 남겼다(자동 표시는 사용자 행동이 아니라 토스트 없음) — 아래 폴백으로 간다.
    }
    if (!sent && !showWindow) {
      showWindow = true;
      reportFallback("briefing", "os_notify_unavailable", "notify_send suppressed or summary failed; opened window instead");
    }
  }

  try {
    if (showWindow) await call("briefing_window_open", kind === "evening" ? { mode: "recap" } : {});
    if (kind === "evening") await st.setBriefingLastShownEvening(today);
    else await st.setBriefingLastShown(today);
  } catch {
    // call() 이 이미 토스트 + 진단 기록했다. 창이 안 열렸으면 lastShown 도 안 쓴다(다음 실행에 다시 시도).
    return;
  }
  await runBriefingHooks("after_show", { ...ctx, windowShown: showWindow });
}

/** 본 창(main) 루트에서 한 번만 호출. 브라우저(동기화 탭)에선 돌지 않는다 — 보조 창은 App 을 렌더하지 않는다. */
export function useBriefingAutoShow(): void {
  useEffect(() => {
    if (isBrowser()) return;
    let cancelled = false;
    const run = (t: BriefingTrigger) => {
      if (!cancelled) void runBriefingAutoShow(new Date(), t);
    };
    // 시작 판정은 설정 로드를 기다려야 한다 — loaded 가 되는 순간 launch 로 한 번, 이후 tick.
    let launched = false;
    const tryLaunch = () => {
      if (launched || !useSettingsStore.getState().loaded) return;
      launched = true;
      run("launch");
    };
    tryLaunch();
    const unsub = useSettingsStore.subscribe(tryLaunch);
    const id = window.setInterval(() => run("tick"), TICK_MS);
    return () => {
      cancelled = true;
      unsub();
      window.clearInterval(id);
    };
  }, []);
}
