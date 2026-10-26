import { useState } from "react";
import { call } from "../../../lib/invoke";
import type { CollectSource } from "../../../lib/commands.gen";

// ponytail: mirrors commands.gen.ts LocalCandidate — swap to the generated type once gen lands
export interface LocalCandidate {
  key: string;
  kind: string;
  label: string;
  detail: string;
  recent_count: number;
  last_seen_at: string | null;
  source_id: string | null;
  config: string;
}

/**
 * 로컬 소스 감지(§2.5, PLAN-2026-09-04 W8) — 대치: 예전 프리셋 버튼 2개(생성+즉시 실행)는
 * 감지 → 유령 행 → 가져오기(생성) → 드라이런 확인 한 경로로 통합됐다(그릴링 확정).
 *
 * 이 훅은 앞 두 걸음(감지·가져오기)까지만 안다. 가져온 소스의 드라이런 모달과 "이대로 가져오기"
 * 확정은 표의 행별 "테스트 실행"과 같은 모달을 쓰므로 CollectSection 이 쥐고, 이 훅은 그 모달을
 * 여는 `runDryRun` 을 받아 부르기만 한다(확정 뒤 유령 행 제거는 `dropCandidate`).
 */
export function useLocalImport(runDryRun: (source: CollectSource, confirmKey?: string) => Promise<void>) {
  // 로컬 소스 감지(W8, PLAN-2026-09-04) — "감지" 클릭 한 번으로 candidates 를 받아 유령 행으로
  // 보여준다. source_id 가 있는 후보는 이미 실제 소스 행으로 보이므로 걸러서 렌더하지 않는다.
  const [detecting, setDetecting] = useState(false);
  const [detectDone, setDetectDone] = useState(false);
  const [candidates, setCandidates] = useState<LocalCandidate[]>([]);
  const [importingKey, setImportingKey] = useState<string | null>(null);

  /** 감지를 한 번 돌린다 — 결과를 받았으면 true(빈 결과 포함), 이미 도는 중이거나 실패면 false. */
  const detectLocal = async (): Promise<boolean> => {
    if (detecting) return false;
    setDetecting(true);
    try {
      const result = await call<{ candidates: LocalCandidate[] }>("collect_detect_local", {});
      setCandidates(result.candidates ?? []);
      setDetectDone(true);
      return true;
    } catch {
      return false; // call() 이 이미 에러 토스트를 띄웠다
    } finally {
      setDetecting(false);
    }
  };

  // "가져오기" 클릭 — 소스를 만들고(있으면 기존 것을 돌려받음, §CONTRACT) 곧바로 드라이런을
  // confirm 모드로 연다. 사용자가 모달에서 "이대로 가져오기"를 눌러야 실제로 실행된다 — 취소해도
  // 만들어진 소스는 그대로 남는다(한 번도 실행 안 된 채로, 목록에서 직접 실행/삭제 가능).
  const importCandidate = async (candidate: LocalCandidate) => {
    if (importingKey) return;
    setImportingKey(candidate.key);
    try {
      const source = await call<CollectSource>("collect_import_local", { key: candidate.key });
      await runDryRun(source, candidate.key);
    } catch {
      /* call() handles notice */
    } finally {
      setImportingKey(null);
    }
  };

  // 확정 뒤 재감지 대신 로컬 필터로 유령 행을 없앤다(ponytail: 서버 재조회 없이 낙관적으로 지움).
  const dropCandidate = (key: string) => setCandidates((prev) => prev.filter((c) => c.key !== key));

  // source_id 가 있는 후보는 collect_source_list 목록에 이미 실제 행으로 나타나므로 유령 행에서
  // 뺀다 — 같은 소스가 두 번 보이는 걸 막는다(§TASKS 2).
  const ghostCandidates = candidates.filter((c) => c.source_id === null);

  return { detecting, detectDone, ghostCandidates, importingKey, detectLocal, importCandidate, dropCandidate };
}
