/**
 * 활동 이력 창(#/activity)은 별도 웹뷰라 에디터 디바운스·노트 스토어가 없다.
 * 스냅샷 복원은 본 창이 flushAll 한 뒤에 해야 한다 — 그렇지 않으면 본 창의 미저장 입력이
 * 복원을 덮어쓴다(specs/commands/snapshots.yaml note_snapshot_restore).
 *
 * 노트 열기는 이미 있는 "pet-open-note" 채널을 재사용한다(App.tsx). 여기는 복원만.
 *
 * 복원 요청("activity-restore-snapshot")은 본 창이 처리하고 결과를
 * "activity-restore-snapshot-result"로 되돌려준다 — 활동 창은 이 결과를 기다려야 (a) "복원 중"
 * 표시를 실제 완료까지 유지하고 (b) 실패를 자기 창에서 보여줄 수 있다. 예전에는 emit 후
 * fire-and-forget 이라 본 창에서만(가려진 창) 에러 토스트가 떴다.
 */
import { emit } from "@tauri-apps/api/event";
import { call, flushAll } from "./invoke";
import { useNotesStore } from "../stores/notes";
import { listenMany } from "./tauriListen";
import { listSectionWindows, returnSectionWindow } from "../stores/sectionWindows";
import type { SnapshotDetail } from "./commands.gen";

interface RestoreRequest {
  id: string;
}

export interface RestoreResult {
  id: string;
  ok: boolean;
  error?: string;
}

export async function handleActivityRestoreSnapshot(req: RestoreRequest): Promise<void> {
  if (!req.id) return;
  await flushAll();
  // 복원이 다시 쓸 섹션이 별도 창에 분리돼 있으면 먼저 닫는다(그 창이 저장을 끝내고 사라질 때까지
  // 기다림). 안 닫으면 그 창은 복원 전 본문을 들고 있다가 다음 자동저장으로 복원을 덮는다.
  // 복원이 덮는 섹션 = 스냅샷에 든 섹션(다시 만들어지는 섹션은 새 id 라 분리돼 있을 수 없다).
  const open = await listSectionWindows();
  if (open.length) {
    const snap = await call<SnapshotDetail>("note_snapshot_get", { id: req.id });
    for (const s of snap.sections) {
      if (open.includes(s.section_id)) await returnSectionWindow(s.section_id);
    }
  }
  await call("note_snapshot_restore", { id: req.id });
  await useNotesStore.getState().reloadActive();
}

/** App.tsx 마운트 시 1회 — 반환값은 useEffect cleanup용 해제 함수. */
export function listenActivityWindowBridge(): () => void {
  return listenMany([
    [
      "activity-restore-snapshot",
      (e: { payload: RestoreRequest }) => {
        void handleActivityRestoreSnapshot(e.payload)
          .then(() => emit("activity-restore-snapshot-result", { id: e.payload.id, ok: true } satisfies RestoreResult))
          .catch((err) =>
            emit("activity-restore-snapshot-result", {
              id: e.payload.id,
              ok: false,
              error: (err as { message?: string })?.message ?? String(err),
            } satisfies RestoreResult),
          );
      },
    ],
  ]);
}
