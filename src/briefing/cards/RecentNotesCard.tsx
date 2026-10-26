import { t } from "../../i18n/t";
import { storedTitleOrEmpty } from "../../lib/noteTitle";
import { formatRelativeTime } from "../../lib/dateUtils";
import { requestOpenNoteInMain } from "../../lib/openNoteInMain";
import { useSettingsStore } from "../../stores/settings";
import type { RecentWorkNote } from "../../lib/commands.gen";
import { useNow, type LoadStatus } from "../hooks/useBriefingData";
import { CardShell, CardStatus } from "./CardShell";

/**
 * 최근 작업 노트 — 최근 7일(활동 기록 보관 기간) 안에 만들거나 고친 노트 몇 개. 행 = 본 창에서 노트 열기.
 * 상대 시각("12분 전")은 분 단위 공유 타이머(useNow)로 다시 그린다.
 */
export function RecentNotesCard({ status, items, reload }: { status: LoadStatus; items: RecentWorkNote[]; reload: () => void }) {
  const lang = useSettingsStore((s) => s.uiLang) || "en";
  const now = useNow(60_000);
  return (
    <CardShell testId="brf-recent-notes" className="brf-recent-notes" title={t("briefing.recent_notes_title")}>
      {items.length > 0 ? (
        <ul className="brf-overdue-list">
          {items.map((n) => (
            <li key={n.note_id} className="brf-overdue-row" data-testid="brf-recent-note-row">
              <button type="button" className="brf-overdue-main" onClick={() => void requestOpenNoteInMain(n.note_id)}>
                <span className="brf-overdue-title">{storedTitleOrEmpty(n.title) || t("briefing.recent_untitled")}</span>
                {n.folder_name && <span className="brf-recent-folder">{n.folder_name}</span>}
                <span className="brf-recent-when">{formatRelativeTime(n.last_at, lang, now)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : status === "ready" ? (
        <div className="brf-state">{t("briefing.recent_notes_empty")}</div>
      ) : (
        <CardStatus status={status} onRetry={reload} />
      )}
    </CardShell>
  );
}
