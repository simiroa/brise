import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { ActivityHistoryPanel } from "../components/ActivityHistoryPanel";
import { AuxWindowChrome, closeCurrentAuxWindow } from "../components/AuxWindowChrome";
import { t } from "../i18n/t";
import { requestOpenNoteInMain } from "../lib/openNoteInMain";
import type { RestoreResult } from "../lib/activityWindowBridge";
import { listenDataReplaced } from "../lib/remoteNoteWrite";

/**
 * 활동 이력 창(#/activity)의 루트. 별도 OS 창인 이유는 src-tauri/src/aux_window.rs 참고.
 *
 * 노트 트리·에디터는 부팅하지 않는다. 노트를 열거나 스냅샷을 복원하는 동작은 본 창에 맡긴다
 * (창끼리 zustand 스토어가 다르고, 복원 전 flushAll 은 에디터가 있는 웹뷰에서만 의미가 있다).
 */
export function ActivityWindowApp() {
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // 데이터가 통째로 바뀌면(초기화·복원·대체 가져오기) 지워진 이력을 계속 보여 주지 않게 다시 불러온다.
  useEffect(() => listenDataReplaced(), []);

  return (
    <AuxWindowChrome title={t("activity.modal_title")} closeTestId="activity-window-close">
      {restoreError && (
        <div
          role="alert"
          data-testid="activity-restore-error"
          style={{
            margin: "var(--space-3) var(--space-5) 0",
            padding: "8px 12px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--danger, #c0392b)",
            color: "var(--danger, #c0392b)",
            fontSize: "var(--text-sm)",
            flex: "none",
          }}
        >
          {restoreError}
        </div>
      )}
      <ActivityHistoryPanel
        onClose={closeCurrentAuxWindow}
        onOpenNote={(noteId) => {
          // 본 창이 이미 듣는 채널. 새 이벤트를 만들지 않는다.
          void requestOpenNoteInMain(noteId);
        }}
        onRestoreSnapshot={async (id) => {
          setRestoreError(null);
          // 본 창의 처리 결과("activity-restore-snapshot-result")를 기다린다 — 예전엔 emit 이
          // fire-and-forget 이라 "복원 중" 표시가 실제 완료 전에 풀리고, 실패해도 에러 토스트는
          // 가려진 본 창에만 떴다(activityWindowBridge.ts 참고). 리스너를 먼저 건 뒤에 emit 해서
          // 응답이 구독 전에 도착하는 경합을 피한다.
          // ponytail: 타임아웃 없음 — 본 창이 항상 같이 뜨는 같은 앱 프로세스라 응답 유실은
          // 사실상 없다. 실사례가 나오면 그때 타임아웃을 추가한다.
          const result = await new Promise<RestoreResult>((resolve) => {
            let unlisten = () => {};
            void listen<RestoreResult>("activity-restore-snapshot-result", (e) => {
              if (e.payload.id !== id) return;
              unlisten();
              resolve(e.payload);
            }).then((fn) => {
              unlisten = fn;
              void emit("activity-restore-snapshot", { id });
            });
          });
          if (!result.ok) {
            setRestoreError(t("activity.restore_failed", { message: result.error ?? "" }));
          }
        }}
      />
    </AuxWindowChrome>
  );
}
