import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useNotesStore } from "../../stores/notes";
import { callSilent, emitNotice } from "../../lib/invoke";
import { patchDateRow } from "../../lib/primaryDate";
import type { DueReminder, ScheduleTodayResult } from "../../lib/commands.gen";

/**
 * 벨의 일정 알림 데이터 — `schedule_today`(오늘 + 지난 것) 조회 + 낙관적 끄기·롤백 + `reload`. 벨 컴포넌트에서 뗐다.
 *
 * `app-notice`(Rust 틱 스레드가 알림이 울릴 때 쏜다 — events::emit_desktop_json)가 오면 다시 읽는다: App.tsx 는 그 이벤트를 토스트로만
 * 띄우고, 벨 목록은 노트북 전환·벨 열기 때만 다시 읽어 배지가 낡아 있었다.
 */
export function useDueReminders(workspaceId: string | null) {
  const [items, setItems] = useState<DueReminder[]>([]);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    if (!workspaceId) {
      setItems([]);
      return;
    }
    let cancelled = false;
    void callSilent<ScheduleTodayResult>("schedule_today", { workspace_id: workspaceId })
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, reloadToken]);

  // 알림이 울렸다 — 배지를 맞춘다. Tauri 밖(vitest/브라우저)에선 listen 이 던지거나 이벤트가 안 온다.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen("app-notice", () => {
      if (!cancelled) reload();
    })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch(() => {
        // silent-ok: Tauri IPC 없는 환경 — 울린 알림에 따른 배지 갱신만 없다(벨을 열 때 다시 읽는다).
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [reload]);

  // PLAN-2026-09-08-dates-rebuild.md §1.5: completion means the same thing for every row now —
  // turning that row's own remind off — never note_set_status(done). The "mark the note done"
  // path is gone: state control owns done-ness, the bell only ever silences a reminder.
  // PLAN-2026-09-10 D6: 대표 분기(note_update{remind})도 사라졌다 — W4b 이후 대표 행에도 진짜
  // note_dates.id 가 있으므로 `related_date_id` 가 null 이면 patchDateRow 가 position 0 행을
  // 찾는다. 한 길이라 투영(project_primary)을 반드시 지난다.
  const dismiss = async (r: DueReminder) => {
    const snapshot = items;
    setItems((prev) => prev.filter((x) => !(x.note_id === r.note_id && x.related_date_id === r.related_date_id)));
    try {
      await patchDateRow(r.note_id, r.related_date_id ?? null, { remind: false });
      // 대표 행일 때만 notes.remind 투영이 바뀐다 — 트리 요약과 열려 있는 노트에 반영.
      if (!r.related_date_id) {
        useNotesStore.getState().patchNoteSummary(r.note_id, { remind: false });
        if (useNotesStore.getState().activeNote?.note.id === r.note_id) {
          await useNotesStore.getState().reloadActive();
        }
      }
    } catch (e) {
      setItems(snapshot);
      // call() 의 AppError 는 이미 토스트됐고 {code,message} 평범한 객체라 instanceof Error 가
      // 거짓이다 — 그대로 String(e) 하면 "[object Object]" 토스트가 하나 더 뜬다.
      // (useAttachmentActions.ts::addFile 과 같은 판정. 롤백은 위 setItems 가 이미 했다.)
      if (!(e && typeof e === "object" && "code" in e)) {
        emitNotice((e as Error)?.message ?? String(e));
      }
    }
  };

  return { items, reload, dismiss };
}
