/**
 * 지난 알림 카드의 데이터 — schedule_today(지난 것 overdue + 오늘 due)를 그대로 읽고, 끄기는 벨(ReminderBell)과
 * 같은 길(lib/primaryDate.patchDateRow → remind:false)로 한다. 두 번째 구현이 아니다.
 * 브리핑 창엔 노트 스토어가 없어 스토어 패치는 없다. 본 창 벨 배지는 벨을 열 때 다시 읽으므로 그때 맞춰진다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { callSilent } from "../../lib/invoke";
import { patchDateRow } from "../../lib/primaryDate";
import { useSettingsStore } from "../../stores/settings";
import { SCHEDULE_TTL_MS } from "../scheduleCache";
import { cachedRequest, invalidate } from "../requestCache";
import type { DueReminder, ScheduleTodayResult } from "../../lib/commands.gen";
import { useReloadOnScheduleChange, type LoadStatus } from "./useBriefingData";

const same = (a: DueReminder, b: DueReminder) => a.note_id === b.note_id && a.related_date_id === b.related_date_id;

export function useOverdue(): {
  status: LoadStatus;
  items: DueReminder[];
  reload: () => void;
  dismiss: (r: DueReminder) => Promise<void>;
} {
  const workspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  const [state, setState] = useState<{ status: LoadStatus; items: DueReminder[] }>({ status: "loading", items: [] });
  const [tick, setTick] = useState(0);
  const loadedAt = useRef(0);
  const fresh = useRef(false); // reload()/포커스 복귀 뒤 다음 로드는 캐시 우회
  const itemsRef = useRef<DueReminder[]>([]);
  itemsRef.current = state.items;

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    const bypass = fresh.current;
    fresh.current = false;
    cachedRequest(`od:${workspaceId}`, () => callSilent<ScheduleTodayResult>("schedule_today", { workspace_id: workspaceId }), { fresh: bypass })
      .then((r) => {
        loadedAt.current = Date.now();
        if (!cancelled) setState({ status: "ready", items: r.items });
      })
      .catch(() => {
        // callSilent 가 이미 logError 로 남겼다 — 카드가 오류 상태를 그리도록만 한다.
        if (!cancelled) setState((s) => ({ status: "error", items: s.items }));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, tick]);

  const reload = useCallback(() => {
    fresh.current = true;
    setTick((n) => n + 1);
  }, []);
  // 이 창·본 창의 일정 쓰기(scheduleVersion) — 시각을 옮기면 알림 시각도 따라 바뀐다.
  useReloadOnScheduleChange(reload);
  // 본 창에서 끈 알림·새 알림 반영 — 창이 포커스로 돌아왔고 마지막 로드가 TTL 보다 오래됐으면 새로 읽는다.
  useEffect(() => {
    const onFocus = () => {
      if (Date.now() - loadedAt.current > SCHEDULE_TTL_MS) reload();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  const dismiss = useCallback(async (r: DueReminder) => {
    const at = itemsRef.current.findIndex((x) => same(x, r));
    setState((s) => ({ ...s, items: s.items.filter((x) => !same(x, r)) }));
    try {
      await patchDateRow(r.note_id, r.related_date_id ?? null, { remind: false });
      invalidate("od:");
    } catch {
      // 롤백 — call() 이 이미 토스트+진단 로그를 남겼다. 그 항목만 원래 자리로 되돌린다.
      setState((s) => {
        if (s.items.some((x) => same(x, r))) return s;
        const items = [...s.items];
        items.splice(Math.min(Math.max(at, 0), items.length), 0, r);
        return { ...s, items };
      });
    }
  }, []);

  return { status: state.status, items: state.items, reload, dismiss };
}
