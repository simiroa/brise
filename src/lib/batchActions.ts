import { emitNotice } from "./invoke";
import { t } from "../i18n/t";

export interface BatchResult {
  /** 성공한 id — 호출자가 선택에서 뺀다. */
  ok: string[];
  /** 실패한 id — 호출자가 선택에 **남긴다**(사용자가 재시도할 대상이 화면에 그대로 있어야 한다). */
  failed: string[];
}

/**
 * W7-g 다중선택 일괄 액션 — 기존 **단일 id 커맨드를 순차로 반복**한다.
 *
 * 순차인 이유: 이 커맨드들은 하나같이 `loadTree()` 같은 캐시 재수화를 뒤에 달고 있어 동시에
 * 쏘면 마지막 응답이 이기는 경합이 된다(AiBatchOrganizeModal 이 같은 이유로 순차 루프다).
 *
 * ponytail: 이건 트랜잭션이 아니다. **천장** — N개에 대해 N번(커맨드에 따라 2N~3N번) IPC 왕복이
 * 일어나고, k번째에서 실패해도 앞선 k-1개는 이미 커밋된 채로 남는다(롤백 없음). 그래서 실패를
 * 삼키지 않고 ok/failed 를 그대로 돌려준다. **업그레이드 경로** — `note_archive_many` 류의 진짜
 * 벌크 커맨드(한 트랜잭션 + 한 번의 loadTree)를 Rust 쪽에 만들고 이 함수의 시그니처는 그대로 둔
 * 채 안쪽만 바꾼다. W7 범위에서는 신규 백엔드 커맨드를 만들지 않기로 결정했다
 * (docs/PLAN-2026-08-04-w7.md §다중선택).
 */
export async function runBatch(
  ids: string[],
  run: (id: string) => Promise<void>,
  onProgress?: (done: number, total: number) => void,
): Promise<BatchResult> {
  const ok: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await run(id);
      ok.push(id);
    } catch {
      // call() 이 이미 토스트를 띄웠다 — 여기서는 세기만 하고 배치를 계속한다.
      failed.push(id);
    }
    onProgress?.(ok.length + failed.length, ids.length);
  }
  return { ok, failed };
}

/**
 * 결과를 한 줄로 알린다. 부분 실패를 "완료"로 뭉개지 않는 것이 이 함수의 존재 이유다 —
 * 몇 개가 되고 몇 개가 안 됐는지 숫자로 말한다.
 */
export function reportBatch(res: BatchResult): void {
  if (res.failed.length === 0) {
    emitNotice(t("selection.batch_done", { n: res.ok.length }));
  } else {
    emitNotice(t("selection.batch_partial", { ok: res.ok.length, failed: res.failed.length }));
  }
}
