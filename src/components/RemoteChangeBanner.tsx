import { useEffect, useState } from "react";
import { create } from "zustand";
import { t } from "../i18n/t";
import { useNotesStore } from "../stores/notes";

/**
 * 데스크톱판 K1 배너(D2 ①). 편집 포커스 보호로 handleRemoteNoteWrite 가 reloadActive() 를 건너뛰면
 * (lib/remoteNoteWrite.ts onFocusSkipped) 다음 자동 저장이 폰 내용을 조용히 덮는다 — 그 사실을 알리고
 * 다시 불러오기를 준다. note id 로 키를 잡아 다른 노트로 넘어가면 저절로 사라진다(폰 MobileNote 와 같은 규칙).
 * ponytail: 폰 쪽은 MobileNote 안에 인라인이라 공유하지 않았다 — 세 번째 사용처가 생기면 합친다.
 */
const useRemoteChanged = create<{ noteId: string | null }>(() => ({ noteId: null }));

const BANNER_STYLE = { display: "flex", alignItems: "center", gap: "var(--space-3)", padding: "var(--space-2) var(--space-3)", fontSize: "var(--text-sm)", borderBottom: "1px solid var(--divider)" } as const;

export const notifyDesktopRemoteChange = (noteId: string) => useRemoteChanged.setState({ noteId });

export function RemoteChangeBanner() {
  const changedId = useRemoteChanged((s) => s.noteId);
  const activeId = useNotesStore((s) => s.activeNote?.note.id);
  // D2②: 이 기기의 저장이 CONFLICT 로 거부됐다 — 배너가 충돌 모드로 바뀐다.
  const conflict = useNotesStore((s) => s.saveConflict);
  const [busy, setBusy] = useState(false);
  // 다른 노트로 넘어가면 신호를 버린다 — 돌아와서 다시 열면 DB 에서 새로 읽으므로 이미 최신이다.
  useEffect(() => {
    if (changedId && changedId !== activeId) useRemoteChanged.setState({ noteId: null });
  }, [changedId, activeId]);
  if (conflict && conflict.noteId === activeId) {
    // 충돌 중엔 그냥 "다시 불러오기"를 주지 않는다 — 이 기기의 미저장 편집을 버리는 버튼이 된다.
    // 두 버튼 모두 내 본문을 잃지 않는다: 사본 섹션으로 남기거나, 명시적으로 덮는다.
    const resolve = async (mode: "copy" | "overwrite") => {
      setBusy(true);
      try {
        if (await useNotesStore.getState().resolveSaveConflict(mode)) useRemoteChanged.setState({ noteId: null });
      } finally {
        setBusy(false);
      }
    };
    return (
      <div
        role="alert"
        data-testid="save-conflict-banner"
        style={BANNER_STYLE}
      >
        <span style={{ flex: 1, minWidth: 0 }}>{t("editor.save_conflict")}</span>
        <button type="button" disabled={busy} onClick={() => void resolve("copy")}>
          {t("editor.save_conflict_copy")}
        </button>
        <button type="button" disabled={busy} onClick={() => void resolve("overwrite")}>
          {t("editor.save_conflict_overwrite")}
        </button>
      </div>
    );
  }
  if (!changedId || changedId !== activeId) return null;
  const reload = async () => {
    await useNotesStore.getState().reloadActive(); // reloadActive 는 실패를 스스로 삼킨다
    useRemoteChanged.setState({ noteId: null });
  };
  return (
    <div
      role="status"
      style={BANNER_STYLE}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{t("editor.remote_changed")}</span>
      <button type="button" onClick={() => void reload()}>
        {t("editor.remote_changed_reload")}
      </button>
    </div>
  );
}
