import { t } from "../../i18n/t";
import { storedTitleOrEmpty } from "../../lib/noteTitle";
import { IconCheck } from "../../components/icons";
import { requestOpenNoteInMain } from "../../lib/openNoteInMain";
import type { DueReminder } from "../../lib/commands.gen";
import type { LoadStatus } from "../hooks/useBriefingData";
import { CardShell, CardStatus } from "./CardShell";

const keyOf = (r: { note_id: string; related_date_id?: string | null }) => `${r.note_id}:${r.related_date_id ?? "note"}`;

export interface OverdueData {
  status: LoadStatus;
  items: DueReminder[];
  reload: () => void;
  dismiss: (r: DueReminder) => Promise<void>;
}

/** 알림 목록 한 벌 — 행 = 본 창에서 노트 열기, ✓ = 그 알림 끄기(벨과 같은 patchDateRow 길, 낙관적 제거 + 실패 롤백). */
export function OverdueList({ items, dismiss }: Pick<OverdueData, "items" | "dismiss">) {
  return (
    <ul className="brf-overdue-list">
      {items.map((r) => {
        const time = r.fire_at?.slice(11, 16) ?? "";
        const title = storedTitleOrEmpty(r.title) || t("briefing.recent_untitled");
        return (
          <li key={keyOf(r)} className={`brf-overdue-row${r.kind === "overdue" ? " is-overdue" : ""}`} data-testid="brf-overdue-row">
            <button type="button" className="brf-overdue-main" onClick={() => void requestOpenNoteInMain(r.note_id)}>
              {time && <span className="brf-overdue-time">{time}</span>}
              <span className="brf-overdue-title">{title}</span>
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              data-testid="brf-overdue-dismiss"
              title={t("home.reminder_dismiss")}
              aria-label={`${t("home.reminder_dismiss")} — ${title}`}
              onClick={() => void dismiss(r)}
            >
              <IconCheck size={14} strokeWidth={2} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 지난 알림 — schedule_today 의 overdue + 오늘 due. **0건이면(로딩 중 포함) 칸 자체가 없다**(PLAN-2026-10-19 §2.1).
 * 데이터는 창 루트의 useOverdue 하나를 받는다 — 저녁 "오늘 정리"가 같은 목록을 쓰므로 상태를 둘로 나누지 않는다.
 */
export function OverdueCard({ status, items, reload, dismiss }: OverdueData) {
  if (items.length === 0) {
    if (status !== "error") return null;
    return (
      <CardShell testId="brf-overdue" title={t("briefing.overdue_title")}>
        <CardStatus status="error" onRetry={reload} />
      </CardShell>
    );
  }
  const overdueN = items.filter((r) => r.kind === "overdue").length;
  return (
    <CardShell
      testId="brf-overdue"
      className="brf-overdue"
      title={t("briefing.overdue_title")}
      aside={overdueN > 0 ? t("home.reminder_overdue_n", { n: overdueN }) : undefined}
    >
      <OverdueList items={items} dismiss={dismiss} />
    </CardShell>
  );
}
