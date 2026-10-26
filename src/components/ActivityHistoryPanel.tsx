import { useEffect, useState } from "react";
import { PromptDialog } from "./PromptDialog";
import { formatRelativeTime } from "../lib/dateUtils";
import { call, callSilent } from "../lib/invoke";
import { useNotesStore, displayTitle as noteDisplayTitle } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { t } from "../i18n/t";
import {
  IconPlus,
  IconTrash,
  IconEdit,
  IconHistory,
  IconFile,
  IconClock,
  IconArrowLeft,
} from "./icons";
import type { ActivityItem, SnapshotDetail, SnapshotListItem } from "../lib/commands.gen";

function previewText(bodyMd: string): string {
  const stripped = bodyMd.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return stripped.length > 160 ? `${stripped.slice(0, 160)}…` : stripped;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "create":
      return t("activity.kind_create");
    case "delete":
      return t("activity.kind_delete");
    case "edit":
      return t("activity.kind_edit");
    case "restore":
      return t("activity.kind_restore");
    case "import":
      return t("activity.kind_import");
    case "collect":
      return t("activity.kind_collect");
    default:
      return kind;
  }
}

function KindIcon({ kind }: { kind: string }) {
  const props = { size: 14 as const, strokeWidth: 1.8 as const };
  switch (kind) {
    case "create":
      return <IconPlus {...props} />;
    case "delete":
      return <IconTrash {...props} />;
    case "edit":
      return <IconEdit {...props} />;
    case "restore":
      return <IconHistory {...props} />;
    case "import":
    case "collect":
      return <IconFile {...props} />;
    default:
      return <IconClock {...props} />;
  }
}

function displayTitle(item: ActivityItem): string {
  // Prefer live/soft-deleted title; fall back to summary (name recorded at event time).
  // 제목 없는 노트는 앱 전체와 같은 라벨(note.untitled_note)로 — 저장된 "Untitled Note" 리터럴 포함.
  if (item.note_title !== null && item.note_title !== undefined) return noteDisplayTitle(item.note_title);
  if (item.kind === "import" || item.kind === "collect") return item.summary;
  return item.summary ? noteDisplayTitle(item.summary) : t("activity.note_gone");
}

function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 같은 날 기록을 한 머리글 밑으로 묶는다 — "5일 전"이 줄마다 반복되던 걸 한 번으로. */
function groupByDay(items: ActivityItem[], lang: string): { key: string; label: string; items: ActivityItem[] }[] {
  const today = dayStart(Date.now());
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const groups: { key: string; label: string; items: ActivityItem[] }[] = [];
  for (const item of items) {
    const ms = new Date(item.created_at).getTime();
    const day = Number.isFinite(ms) ? dayStart(ms) : 0;
    const key = String(day);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      const ago = Math.round((today - day) / 86_400_000);
      const label =
        day === 0
          ? ""
          : ago < 7
            ? rtf.format(-ago, "day")
            : new Date(day).toLocaleDateString(lang, { year: "numeric", month: "long", day: "numeric" });
      g = { key, label, items: [] };
      groups.push(g);
    }
    g.items.push(item);
  }
  return groups;
}

function formatClock(date: string | number, lang: string): string {
  const ms = new Date(date).getTime();
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }) : "";
}

interface ActivityHistoryPanelProps {
  onClose: () => void;
  /** 별도 OS 창에서 열릴 때 — 본 창이 노트를 연다(창끼리 스토어가 다름). 없으면 이 트리에서 selectNote. */
  onOpenNote?: (noteId: string) => void;
  /** 본 창이 flush 후 복원한다. 이 웹뷰에서 restore 를 직접 부르면 에디터 디바운스를 못 비운다. */
  onRestoreSnapshot: (snapshotId: string) => Promise<void>;
}

/**
 * 활동 이력 본문. 2026-08-14 이전에는 ModalShell 로 감싼 모달이었고 App.tsx 가 상태로 열고
 * 닫았다. 지금은 **별도 OS 창**의 내용물이다 — 이유는 src-tauri/src/activity_window.rs 헤더.
 * 스크림·카드는 없다. 창 자신이 카드다.
 *
 * Lists activity_log reverse-chronologically; drill into a note's autosave snapshots.
 * Restore always goes through onRestoreSnapshot (main-window flush + note_snapshot_restore).
 */
export function ActivityHistoryPanel({
  onClose,
  onOpenNote,
  onRestoreSnapshot,
}: ActivityHistoryPanelProps) {
  const lang = useSettingsStore((s) => s.uiLang) || "en";
  const workspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  // Drill-down: show note_snapshots for a chosen note (replaces the old standalone snapshot dialog).
  const [snapshotNoteId, setSnapshotNoteId] = useState<string | null>(null);
  const [snapItems, setSnapItems] = useState<SnapshotListItem[] | null>(null);
  const [snapDetail, setSnapDetail] = useState<SnapshotDetail | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  const loadActivity = () => {
    void (async () => {
      try {
        setItems(
          await call<ActivityItem[]>("activity_list", {
            workspace_id: workspaceId ?? undefined,
            limit: 200,
          })
        );
      } catch {
        // loadSnapshots 와 같은 이유 — 실패하면 items 가 null 로 영구히 남아 화면이 "아직 로딩 중"
        // 과 구별되지 않는 빈 상태로 굳는다. call() 이 이미 토스트를 띄웠으니(사용자가 방금 연
        // 패널이 실제로 실패한 걸 알아야 한다) 여기선 빈 목록으로 확정지어 "기록 없음" 카피가
        // 뜨게 한다. try/catch 로 감싸 rejection 이 새지 않게 한다(call 뒤 catch 체이닝 안티패턴 금지).
        setItems([]);
      }
    })();
  };

  useEffect(loadActivity, [workspaceId]);

  const loadSnapshots = (noteId: string) => {
    setSnapItems(null);
    setSnapDetail(null);
    void (async () => {
      try {
        setSnapItems(await call<SnapshotListItem[]>("note_snapshot_list", { note_id: noteId }));
      } catch {
        // 실패하면 snapItems 가 null 로 영원히 남아 드릴다운 화면이 빈 채로 굳는다(스피너도
        // 없어 "로딩 중"인지 "끝났는데 아무것도 없는지" 구분이 안 됨) — call() 이 이미 에러
        // 토스트를 띄웠으니(activity_list 와 같은 판단: 목록 로드 실패는 사용자가 알아야 함)
        // 여기서는 목록을 빈 배열로 확정해 "저장된 스냅샷 없음" 상태로 떨어뜨린다(무한 로딩 방지).
        setSnapItems([]);
      }
    })();
  };

  const openSnapshots = (noteId: string) => {
    setSnapshotNoteId(noteId);
    loadSnapshots(noteId);
  };

  const openNote = async (noteId: string) => {
    if (onOpenNote) {
      // 창을 닫지 않는다 — 본 창의 노트를 유리 너머로 보는 것이 이 창의 존재 이유.
      onOpenNote(noteId);
      return;
    }
    onClose();
    await useNotesStore.getState().selectNote(noteId);
  };

  const onActivityClick = (item: ActivityItem) => {
    if (item.note_alive && item.note_id) {
      void openNote(item.note_id);
    }
  };

  const openPreview = (id: string) => {
    setSnapDetail(null);
    // 선택적 조회다 — 실패해도 snapDetail 은 클릭 전과 같은 null 이라 상세 패널이 그냥 안 펼쳐질
    // 뿐(무한 로딩 표시가 없다), 클릭 안 한 것과 구별되지 않는 상태로 조용히 남는다. 목록 로드
    // (activity_list/note_snapshot_list)와 달리 화면이 영구히 빈 상태로 굳지 않으므로 에러
    // 토스트가 필요 없다 — callSilent 로 바꿔 실패는 콘솔(logError)에만 남긴다.
    void callSilent<SnapshotDetail>("note_snapshot_get", { id })
      .then(setSnapDetail)
      .catch(() => {});
  };

  const doRestore = async (id: string) => {
    setConfirmId(null);
    setRestoring(true);
    try {
      // 본 창의 에디터 디바운스를 먼저 비워야 한다. 이 창에서 restore 를 직접 부르면
      // flushAll() 이 빈 웹뷰만 비우고, 본 창의 미저장 입력이 복원을 덮어쓴다.
      await onRestoreSnapshot(id);
      setSnapDetail(null);
      if (snapshotNoteId) loadSnapshots(snapshotNoteId);
      loadActivity();
    } catch {
      // onRestoreSnapshot 이 거절되면(별도 OS 창 경로는 실패 시 그냥 상태만 세팅하지만, 이
      // prop 의 타입 자체는 Promise<void> 라 언제든 던질 수 있다) 여기서 삼킨다 — call() 을
      // 타는 실제 구현은 이미 실패 토스트를 띄웠다. finally 는 rejection 을 못 잡는다
      // (CLAUDE.md 함정 8) — catch 없이 두면 아래 `void doRestore(confirmId)` 호출부에서
      // unhandled rejection 이 샌다. 롤백할 낙관적 갱신은 없다(스냅샷 목록/미리보기는 성공했을
      // 때만 갱신한다).
    } finally {
      setRestoring(false);
    }
  };

  return (
    <>
      <div
        className="scroll"
        data-testid="activity-history-panel"
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          overflow: "auto",
          scrollbarGutter: "stable",
          padding: "var(--space-4) var(--space-5)",
        }}
      >
        {snapshotNoteId ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button
              type="button"
              onClick={() => {
                setSnapshotNoteId(null);
                setSnapItems(null);
                setSnapDetail(null);
              }}
              className="btn"
              style={{
                alignSelf: "flex-start",
                gap: 4,
                fontSize: "var(--text-sm)",
                padding: "4px 8px",
              }}
            >
              <IconArrowLeft size={12} strokeWidth={1.8} />
              {t("activity.back_to_activity")}
            </button>
            {snapItems === null ? null : snapItems.length === 0 ? (
              <div style={{ padding: "20px 4px", textAlign: "center", color: "var(--faint)" }}>
                {t("snapshot.empty_state")}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {snapItems.map((item) => (
                  <div
                    key={item.id}
                    className="card"
                    style={{
                      padding: "8px 12px",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--divider)",
                    }}
                  >
                    <div
                      onClick={() => openPreview(item.id)}
                      style={{
                        cursor: "pointer",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "baseline",
                        gap: 8,
                      }}
                    >
                      <span style={{ fontWeight: 600, fontSize: "var(--text-md)" }}>
                        {formatRelativeTime(item.taken_at, lang)}
                      </span>
                      <span style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>
                        {t("snapshot.n_sections", { n: item.section_count })}
                      </span>
                    </div>
                    {snapDetail?.id === item.id && (
                      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                        {snapDetail.sections.map((s) => (
                          <div key={s.section_id} style={{ fontSize: "var(--text-sm)", color: "var(--text)" }}>
                            <strong>{s.title}</strong>
                            <div style={{ color: "var(--muted)" }}>
                              {previewText(s.body_md) || t("snapshot.section_empty")}
                            </div>
                          </div>
                        ))}
                        <button
                          type="button"
                          disabled={restoring}
                          onClick={() => setConfirmId(item.id)}
                          className="btn"
                          style={{
                            alignSelf: "flex-end",
                            fontSize: "var(--text-sm)",
                            padding: "6px 10px",
                          }}
                        >
                          {t("snapshot.restore_action")}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : items === null ? null : items.length === 0 ? (
          <div style={{ padding: "20px 4px", textAlign: "center", color: "var(--faint)" }}>
            {t("activity.empty_state")}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {groupByDay(items, lang).map((group) => (
              <section key={group.key} aria-label={group.label}>
                <div className="activity-day">{group.label}</div>
                {group.items.map((item) => {
                  const clickable = Boolean(item.note_alive && item.note_id);
                  const titleText = displayTitle(item);
                  // 삭제 행은 종류 글자("삭제")가 이미 사라졌음을 말한다 — 같은 뜻의 꼬리표를 또 달지 않는다.
                  const gone = !item.note_alive && item.kind !== "import" && item.kind !== "collect" && item.kind !== "delete";
                  const fullTitle = gone ? `${titleText} (${t("activity.note_gone")})` : titleText;
                  return (
                    <div key={item.id} className="activity-row" data-kind={item.kind}>
                      {/* 본문 눌림 영역: 노트가 살아 있으면 연다. 스냅샷 버튼을 옆에 두려고 진짜 button 을
                          중첩하지 않는다(무효한 상호작용 중첩 방지). */}
                      <div
                        className="activity-row__main"
                        data-clickable={clickable || undefined}
                        role={clickable ? "button" : undefined}
                        tabIndex={clickable ? 0 : undefined}
                        onClick={() => onActivityClick(item)}
                        onKeyDown={(e) => {
                          if (!clickable) return;
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onActivityClick(item);
                          }
                        }}
                      >
                        <span className="activity-row__kind" aria-hidden>
                          <KindIcon kind={item.kind} />
                        </span>
                        <span className="activity-row__kind-label">{kindLabel(item.kind)}</span>
                        <span className="activity-row__title" title={fullTitle} data-gone={!item.note_alive || undefined}>
                          {titleText}
                        </span>
                        {gone ? <span className="activity-row__tag">{t("activity.gone_tag")}</span> : null}
                      </div>
                      {clickable ? (
                        <button
                          type="button"
                          className="icon-btn icon-btn--sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            openSnapshots(item.note_id!);
                          }}
                          aria-label={t("activity.view_snapshots")}
                          title={t("activity.view_snapshots_hint")}
                        >
                          <IconClock size={14} strokeWidth={1.8} />
                        </button>
                      ) : null}
                      <span className="activity-row__time">{formatClock(item.created_at, lang)}</span>
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
        )}
      </div>

      {confirmId && (
        <PromptDialog
          title={t("snapshot.restore_confirm_title")}
          description={t("snapshot.restore_confirm_desc")}
          mode="confirm"
          confirmLabel={t("snapshot.restore_action")}
          onCancel={() => setConfirmId(null)}
          onSubmit={() => void doRestore(confirmId)}
        />
      )}
    </>
  );
}
