import "../styles/mobileImport.css";
import { t } from "../i18n/t";
import { IconClose } from "../components/icons";

interface Props {
  /** 아직 어디에도 안 붙은 가져온 사진 수. */
  count: number;
  /** "사진 빼기" — 사진만 버린다(글 초안은 그대로). */
  onDrop: () => void;
  /** 가져온 내용이 아직 초안인가 — 그때만 [버리기]를 보인다(useMobileImport.discard). */
  canDiscard?: boolean;
  onDiscard?: () => void;
}

/**
 * 입력 화면 위쪽의 한 줄 — "가져온 사진 N장 · 나가면 함께 올라가요" + 빼기(×), 그리고 가져온 내용이 아직 초안이면 [버리기].
 * 가져온 내용은 입력 화면을 떠날 때 노트가 되므로(D1, useMobileImport.ts), 그 전까지 이 화면에 "가져온 것"이 있다는 사실과
 * 그것을 노트로 만들지 않는 유일한 길([버리기])을 정직하게 보여 주는 자리다. 사진도 없고 버릴 초안도 없으면 아무것도 그리지 않는다.
 */
export function MobileImportStrip({ count, onDrop, canDiscard = false, onDiscard }: Props) {
  const discardable = canDiscard && !!onDiscard;
  if (count <= 0 && !discardable) return null;
  return (
    <div className="mobile-import-strip" role="status">
      <span className="mobile-import-strip-text">
        {count > 0 ? t("mobileImport.strip_images", { count }) : t("mobileImport.strip_text")}
      </span>
      {count > 0 && (
        <button type="button" className="mobile-icon-btn" onClick={onDrop} aria-label={t("mobileImport.strip_remove")}>
          <IconClose size={16} strokeWidth={2} aria-hidden />
        </button>
      )}
      {discardable && (
        <button type="button" className="mobile-import-strip-discard" data-testid="mobile-import-discard" onClick={onDiscard}>
          {t("mobileImport.strip_discard")}
        </button>
      )}
    </div>
  );
}

interface PendingBarProps {
  /** 이 노트에 아직 못 올린 가져온 사진 수. */
  count: number;
  /** 지금 올리는 중이다 — 버튼을 잠그고 문구를 바꾼다. */
  busy: boolean;
  onRetry: () => void;
  onDiscard: () => void;
}

/**
 * 노트 화면의 한 줄 — 가져온 사진이 백그라운드로 올라가다 일부 못 올라갔을 때(O-2). 사진을 지우지 않고 보여 주는 자리:
 * [다시 올리기] · [버리기](버리면 그 사진은 영영 사라진다 — 노트와 글은 그대로).
 */
export function MobileImportPendingBar({ count, busy, onRetry, onDiscard }: PendingBarProps) {
  if (count <= 0) return null;
  return (
    <div className="mobile-import-strip" role="status" data-testid="mobile-import-pending">
      <span className="mobile-import-strip-text">
        {busy ? t("mobileImport.pending_uploading", { count }) : t("mobileImport.pending_bar", { count })}
      </span>
      <button type="button" className="mobile-import-strip-action" data-testid="mobile-import-retry" disabled={busy} onClick={onRetry}>
        {t("mobileImport.pending_retry")}
      </button>
      <button type="button" className="mobile-import-strip-discard" data-testid="mobile-import-pending-discard" onClick={onDiscard}>
        {t("mobileImport.strip_discard")}
      </button>
    </div>
  );
}
