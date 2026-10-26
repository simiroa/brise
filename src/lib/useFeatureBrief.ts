import { useEffect } from "react";
import { callSilent } from "./invoke";
import { useSettingsStore } from "../stores/settings";
import { useFeatureBriefStore } from "../stores/featureBrief";
import { FEATURE_BRIEFS, FEATURE_BRIEF_SEED_SENTINEL } from "./featureBriefs";

/**
 * 단일 관문(docs/PLAN-2026-08-30-ai-surface-and-clients.md §4 W7, .claude/CLAUDE.md 코드 방침
 * "모든 호출자가 지나가는 지점에서 한 번 고친다") — 토글이 OFF→ON 될 때 온보딩 브리핑을 띄울지
 * 판단하는 로직 전체(브리핑 존재 여부·이미 봤는지·seenFeatureBriefs 갱신·모달 오픈)가 이 훅
 * 하나에만 있다. 트리거 지점(AiPermissionsSection·AiCapabilityCatalog·SyncSection·
 * SmsParseSection)은 각자의 토글 핸들러 안에서 반환된 함수를 한 줄 부르기만 한다 — 판단 로직을
 * 각자 다시 구현하지 않는다.
 *
 * "이미 본 브리핑은 다시 안 뜬다"는 여기서 즉시(모달을 실제로 열기로 결정하는 순간) 커밋한다 —
 * 사용자가 모달을 끝까지 읽었는지와 무관하게 "떴다"가 곧 "봤다"다(닫기 버튼 클릭까지 기다리면
 * ESC/바깥 클릭으로 닫는 사용자는 매번 다시 보게 된다).
 */
export function useFeatureBriefTrigger(): (briefId: string, wasOn: boolean, nowOn: boolean) => void {
  const seen = useSettingsStore((s) => s.seenFeatureBriefs);
  const setSeen = useSettingsStore((s) => s.setSeenFeatureBriefs);
  const open = useFeatureBriefStore((s) => s.open);

  return (briefId, wasOn, nowOn) => {
    if (wasOn || !nowOn) return; // OFF→ON 전환만 — 끌 때나 이미 켜져 있던 경우는 무시.
    if (seen.includes(briefId)) return;
    if (!FEATURE_BRIEFS.some((b) => b.id === briefId)) return; // 이 웨이브가 모르는 id — 조용히 무시.
    void setSeen([...seen, briefId]);
    open(briefId, "onboarding");
  };
}

/**
 * 소급 금지 시딩(§4 W7) — "이미 기능을 켠 채로 업데이트한 사용자에게 과거 브리핑을 몰아서 띄우지
 * 않는다". 설정 스토어가 처음 loaded=true 로 넘어가는 순간 정확히 한 번, 그 시점에 이미 ON인
 * 기능들의 id 를 seenFeatureBriefs 에 채워 넣는다 — 그다음부터 그 기능을 껐다 켜야만(진짜
 * OFF→ON) 브리핑이 뜬다. **영구 완료 표식은 별도 설정 키가 아니라 seenFeatureBriefs 배열 안의
 * sentinel 하나**(FEATURE_BRIEF_SEED_SENTINEL) — 새 설정 키를 또 만들지 않기 위해서다.
 *
 * sentinel 이 이미 있으면(과거에 한 번 시딩됨) 이 훅은 IPC 를 전혀 부르지 않고 즉시 반환한다.
 * SettingsPanel 마운트마다(=설정 창을 열 때마다) 이 훅이 다시 도는 게 정상이다 — 시딩이 아직
 * 안 됐을 때만 실제로 settings_get_all 을 한 번 더 부른다.
 */
export function useSeedFeatureBriefsOnce(): void {
  const loaded = useSettingsStore((s) => s.loaded);
  const seen = useSettingsStore((s) => s.seenFeatureBriefs);
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const aiPostProcess = useSettingsStore((s) => s.aiPostProcess);
  const linkSuggestions = useSettingsStore((s) => s.linkSuggestions);
  const aiChatMemory = useSettingsStore((s) => s.aiChatMemory);
  const setSeen = useSettingsStore((s) => s.setSeenFeatureBriefs);

  useEffect(() => {
    if (!loaded || seen.includes(FEATURE_BRIEF_SEED_SENTINEL)) return;
    let cancelled = false;
    void (async () => {
      try {
        // sync_enabled/capture_*_enabled 는 useSettingsStore 가 들고 있지 않다(SyncSection/
        // BrowserCaptureSection 이 각자 sync_status/capture_status 로 읽는다) — 시딩 판정에만 쓰는
        // 원시 스냅샷이라 여기서 한 번 직접 읽는다. 시딩이 끝난 뒤(sentinel 존재)에는 이 분기
        // 자체에 들어오지 않으므로 매 설정 창 오픈마다 반복되지 않는다.
        const r = await callSilent<{ settings: Record<string, unknown> }>("settings_get_all");
        if (cancelled) return;
        const s = r.settings;
        const channelOn = (v: unknown) => v === "1";
        const onNow: string[] = [];
        if (aiEnabled) onNow.push("ai_master");
        if (aiPostProcess) onNow.push("ai_post_process");
        if (linkSuggestions) onNow.push("link_suggestions");
        if (aiChatMemory) onNow.push("ai_chat_memory");
        if (s.sync_enabled === true) onNow.push("sync_server");
        if (
          channelOn(s.capture_clip_enabled) ||
          channelOn(s.capture_visits_enabled) ||
          channelOn(s.capture_ledger_enabled)
        ) {
          onNow.push("capture_channel");
        }
        const merged = Array.from(new Set([...seen, ...onNow, FEATURE_BRIEF_SEED_SENTINEL]));
        await setSeen(merged);
      } catch {
        // 조용히 실패해도 sentinel 이 안 심어졌으니 다음 설정 창 오픈 때 다시 시도된다.
      }
    })();
    return () => {
      cancelled = true;
    };
    // seen/aiEnabled/... 을 deps 에 넣지 않는다 — loaded 가 false→true 로 넘어가는 전환 1회에만
    // 반응하면 충분하고(그 렌더의 클로저가 이미 최신값을 들고 있다), 넣으면 seen 자체를 이
    // effect 가 갱신하므로 무한 루프가 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
}
