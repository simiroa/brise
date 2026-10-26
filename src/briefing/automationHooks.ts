/**
 * 브리핑 자동화 훅 "자리" (PLAN-2026-09-30-briefing §9 W10-6).
 * 표시 전/후에 끼울 액션의 타입과 빈 레지스트리, 실행기만 있다. **등록하는 코드도, 설정 UI 도, 스크립트 실행도 아직 없다** —
 * 실행 주체·권한·샌드박스가 그릴 전이라서다(docs/GRILL-2026-10-01-briefing-automation.md). 등록 0개면 no-op.
 */
import { reportFallback } from "../lib/diag";
import type { BriefingKind } from "./shouldShowBriefing";

export type BriefingHookPhase = "before_show" | "after_show";

export interface BriefingHookContext {
  kind: BriefingKind;
  /** 로컬일 "YYYY-MM-DD" */
  day: string;
  /** 창이 실제로 열렸나 — after_show 에서만 의미(OS 알림만 보낸 경우 false). */
  windowShown?: boolean;
}

export interface BriefingHook {
  id: string;
  phase: BriefingHookPhase;
  run: (ctx: BriefingHookContext) => void | Promise<void>;
}

/** 훅 하나가 표시를 붙잡아 둘 수 있는 상한. before_show 가 창 띄우기를 막으면 안 된다. */
export const HOOK_TIMEOUT_MS = 3000;

// ponytail: 모듈 스코프 빈 배열 — 등록 API 는 그릴에서 권한 모델이 정해진 뒤에 연다.
const registry: BriefingHook[] = [];

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      () => (clearTimeout(id), resolve()),
      (e) => (clearTimeout(id), reject(e)),
    );
  });
}

/** 훅을 순서대로 돌린다. 절대 throw 하지 않는다 — 훅이 죽어도 브리핑 표시는 계속돼야 한다. */
export async function runBriefingHooks(
  phase: BriefingHookPhase,
  ctx: BriefingHookContext,
  hooks: readonly BriefingHook[] = registry,
): Promise<void> {
  for (const h of hooks) {
    if (h.phase !== phase) continue;
    try {
      await withTimeout(Promise.resolve(h.run(ctx)), HOOK_TIMEOUT_MS);
    } catch (e) {
      // 메시지에 훅 id 와 사유만 — 컨텍스트(노트 본문 등) 금지.
      reportFallback("briefing", "hook_failed", `${h.id}:${phase}:${e instanceof Error ? e.message : "error"}`);
    }
  }
}
