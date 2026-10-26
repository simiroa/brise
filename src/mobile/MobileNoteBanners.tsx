/**
 * 폰 노트 화면 머리 아래 인플로우 배너 셋 — 저장 실패/충돌(V5·D2②), 이 기기에 남은 글 복구, 원격 변경(K1). 전부 `.card`
 * (`.overlay` 아님)이고, 상태·핸들러는 useMobileNoteSave 가 쥔다 — 여기는 그리기만 한다.
 */
import { useState } from "react";
import type { SavedState } from "../stores/notes";
import { t } from "../i18n/t";
import type { PendingAttachment } from "./MobileAttachmentList";

interface SaveBannerProps {
  savedState: SavedState;
  /** 이 노트에 걸린 충돌(D2②)이 있는가. */
  conflictHere: boolean;
  /** 충돌이 걸린 섹션의 이름 — 어느 섹션인지 문구에 밝힌다(없거나 비면 이름 없는 문구). */
  conflictSectionName?: string;
  /** 나가기를 막은 상태인가(leaveProceed 가 있다). */
  leaving: boolean;
  /** 이 기기에만 있는 본문이 있는가 — 클릭 시점의 값을 봐야 해서 값이 아니라 getter 다(bodyUnsavedRef). */
  isBodyUnsaved: () => boolean;
  pending: PendingAttachment[];
  retrying: boolean;
  onRetryUpload: (key: string) => void;
  onRetrySave: () => void;
  onLeaveAnyway: () => void;
  onConflict: (mode: "copy" | "overwrite") => void;
}

/**
 * V5: 저장 실패 배너 — 인플로우. 실패한 동안(그리고 나가기를 막았을 때) 떠 있고, 성공하면 사라진다.
 * 성공 경로에는 아무것도 안 그린다("저장 중…" 도 깜빡임 방지로 표시하지 않는다).
 * D2②: 충돌이면 같은 배너가 충돌 문구 + [내 글 복사 후 새로 불러오기]·[내 것으로 덮어쓰기]. [다시 시도]는
 * 숨긴다 — 게이트가 열려 있어 같은 거부만 반복된다.
 */
export function MobileSaveBanner({
  savedState,
  conflictHere,
  conflictSectionName,
  leaving,
  isBodyUnsaved,
  pending,
  retrying,
  onRetryUpload,
  onRetrySave,
  onLeaveAnyway,
  onConflict,
}: SaveBannerProps) {
  const uploadErrored = pending.some((u) => u.status === "error");
  if (!(savedState === "failed" || conflictHere || (leaving && (isBodyUnsaved() || uploadErrored)))) return null;
  return (
    <div className="mobile-remote-banner card" role="alert" data-testid="mobile-save-failed">
      <span className="mobile-remote-banner-text">
        {conflictHere
          ? conflictSectionName
            ? t("mobile.save_conflict_named", { name: conflictSectionName })
            : t("mobile.save_conflict")
          : savedState !== "failed" && !isBodyUnsaved()
            ? t("mobileVoice.leave_upload_failed")
            : t("mobile.save_failed")}
      </span>
      {conflictHere && (
        <>
          <button
            type="button"
            className="mobile-remote-banner-action"
            data-testid="mobile-conflict-copy"
            disabled={retrying}
            onClick={() => onConflict("copy")}
          >
            {t("mobile.save_conflict_copy")}
          </button>
          <button
            type="button"
            className="mobile-remote-banner-action"
            data-testid="mobile-conflict-overwrite"
            disabled={retrying}
            onClick={() => onConflict("overwrite")}
          >
            {t("mobile.save_conflict_overwrite")}
          </button>
        </>
      )}
      {!conflictHere && (
        <button
          type="button"
          className="mobile-remote-banner-action"
          disabled={retrying}
          onClick={() => {
            if (savedState !== "failed" && !isBodyUnsaved()) {
              for (const u of pending) if (u.status === "error") onRetryUpload(u.key);
            } else onRetrySave();
          }}
        >
          {t("mobile.save_retry")}
        </button>
      )}
      {leaving && (
        <button type="button" className="mobile-remote-banner-action" onClick={onLeaveAnyway}>
          {t("mobile.save_leave_anyway")}
        </button>
      )}
    </div>
  );
}

/**
 * 이 기기에 남은 저장 못 한 글 복구 배너 — 인플로우(.card). [그래도 나가기]가 보관해 둔 본문이 이 노트에 있을 때 뜬다
 * (useMobileUnsavedStash). [새 섹션으로 넣기]는 기존 본문을 덮지 않는다. [버리기]는 유일한 사본을 지우므로 두 번
 * 눌러야 한다(첫 탭은 확인 문구로 바뀐다 — 부르는 쪽이 보관본 id 로 key 를 줘서 다음 항목에선 다시 첫 단계다).
 * 저장 실패 배너(mobile-save-failed, role=alert)와 겹치지 않게 자기 testid 를 쓰고 alert 역할은 없다.
 */
export function MobileStashRecoveryBanner({
  count,
  busy,
  onInsert,
  onDiscard,
}: {
  /** 이 노트에 남은 보관본 수 — 2 이상이면 문구에 붙는다. 한 번에 하나씩 보여 준다(최신부터). */
  count: number;
  busy: boolean;
  onInsert: () => void;
  onDiscard: () => void;
}) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  return (
    <div className="mobile-remote-banner card" data-testid="mobile-stash-recovery">
      <span className="mobile-remote-banner-text">
        {t("mobile.stash_found")}
        {count > 1 ? ` (${count})` : ""}
      </span>
      <button
        type="button"
        className="mobile-remote-banner-action"
        data-testid="mobile-stash-insert"
        disabled={busy}
        onClick={onInsert}
      >
        {t("mobile.stash_insert")}
      </button>
      <button
        type="button"
        className="mobile-remote-banner-action"
        data-testid="mobile-stash-discard"
        disabled={busy}
        onClick={() => (confirmingDiscard ? onDiscard() : setConfirmingDiscard(true))}
      >
        {confirmingDiscard ? t("mobile.stash_discard_confirm") : t("mobile.stash_discard")}
      </button>
    </div>
  );
}

/**
 * K1: 원격 변경 배너 — 인플로우(.card, .overlay 아님). 다른 기기가 이 노트를 고쳤는데 이 기기가 편집 중이라
 * 자동 반영을 건너뛴 경우에만 뜬다(handleRemoteNoteWrite 의 포커스 보호). 키가 note id 라 다른 노트로 넘어가면
 * 부르는 쪽이 그리지 않는다.
 */
export function MobileRemoteChangeBanner({ onReload }: { onReload: () => void }) {
  return (
    <div className="mobile-remote-banner card">
      <span className="mobile-remote-banner-text">{t("mobile.remote_changed")}</span>
      <button type="button" className="mobile-remote-banner-action" onClick={onReload}>
        {t("mobile.remote_changed_reload")}
      </button>
    </div>
  );
}
