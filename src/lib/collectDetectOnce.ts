import { callSilent } from "./invoke";
import { useSettingsStore } from "../stores/settings";

// ponytail: mirrors CollectSection.tsx's local LocalCandidate shadow type (commands.gen.ts has no
// generated type for it yet) — this helper only needs the one field it filters on.
interface LocalCandidateLite {
  source_id: string | null;
}

// 모듈(런타임)당 1회 — App.tsx 이펙트가 여러 번 걸려도(재마운트 등) 실제 IPC 는 한 번만 나간다.
let ran = false;

/**
 * 첫 부팅 5초 후 App.tsx 이펙트가 정확히 1회 부른다(PLAN-2026-09-04-local-import §3b).
 * collect_detect_seen 이 이미 true면(수집 페이지를 한 번이라도 연 사용자) 아무 일도 하지 않는다.
 * 아니면 collect_detect_local을 무음(callSilent)으로 훑어 source_id 없는(아직 소스로 등록되지
 * 않은) 후보 개수를 collect_detect_pending에 저장한다 — 설정 > 수집 레일 항목의 뱃지 숫자.
 *
 * 실패는 전부 삼킨다: 이건 사용자가 시킨 적 없는 배경 작업이라 실패를 토스트로 알릴 이유가
 * 없다(트랩 8, .claude/CLAUDE.md) — collect_detect_local이 reject하면 아무것도 저장하지 않고
 * 조용히 끝난다(다음 부팅에도 seen이 여전히 false라 다시 시도된다).
 */
export async function runCollectDetectOnce(): Promise<void> {
  if (ran) return;
  ran = true;
  if (useSettingsStore.getState().collectDetectSeen) return;
  const result = await callSilent<{ candidates: LocalCandidateLite[] }>(
    "collect_detect_local",
    {},
  ).catch(() => null);
  if (!result) return;
  const n = result.candidates.filter((c) => c.source_id === null).length;
  await useSettingsStore.getState().setCollectDetectPending(Math.min(99, n));
}

/** 테스트 전용 — 모듈 top-level 가드를 케이스 사이에 초기화한다. */
export function __resetCollectDetectOnceForTest(): void {
  ran = false;
}
