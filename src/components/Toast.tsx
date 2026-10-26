import React, { useEffect, useState } from 'react';
import { onAppError, onAppNotice } from '../lib/invoke';
import { onUndoToast, onUndoToastDismiss } from '../lib/undo';
import { onProgressToast, onProgressToastDismiss } from '../lib/progressToast';
import type { AppError } from '../lib/commands.gen';
import { IconClose } from './icons';
import { formatFriendlyError } from '../lib/errorText';
// Aliased: the existing render loop below already uses `t` as its per-toast map parameter name
// (`toasts.map((t) => ...)`) — keeping both `t` identifiers straight would be error-prone.
import { t as translate } from '../i18n/t';

type ToastItem =
  | { id: number; kind: 'error'; error: AppError }
  | { id: number; kind: 'notice'; message: string }
  // undoId is the undo-primitive's own entry id (distinct namespace from this component's local
  // toast `id`) — onUndoToastDismiss reports by undoId, so we need it to find the right toast.
  | { id: number; kind: 'undo'; undoId: number; label: string; onUndo: () => void; actionLabel?: string; extraAction?: { label: string; onAction: () => void } }
  // progressKey is the caller-chosen batch key (emitProgress's `key`) — repeated emits with the
  // same key update this toast's label in place instead of stacking a new one.
  | { id: number; kind: 'progress'; progressKey: string; label: string };

// Toast 는 이제 작은 보조 창에도 뜬다(펫 말풍선은 폭 260~300px, AUDIT-2026-09-26 G3) — 고정
// 280px 최소 폭 + 24px 여백이면 그 창에서 왼쪽이 잘렸다. 여백·폭이 뷰포트를 따라 줄어들게 한다
// (넓은 창에서는 예전과 같은 24px / 280~400px).
const TOAST_EDGE = 'clamp(8px, 3vw, 24px)';
const TOAST_MIN_W = 'min(280px, calc(100vw - 16px))';
const TOAST_MAX_W = 'min(400px, calc(100vw - 16px))';

export const Toast: React.FC = () => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    let nextId = 1;
    const push = (item: ToastItem, ttlMs = 3000) => {
      setToasts((prev) => {
        const next = [...prev, item];
        // 3개 상한은 알림·에러만 밀어낸다 — undo 토스트가 밀리면 버튼째 사라져 되돌릴 길이 없어진다
        // (AUDIT-2026-09-05-ai-guard-friction §2-5). progress 토스트도 같은 이유로 제외한다 —
        // 밀려 사라지면 사용자는 배치가 멈춘 줄 안다. 밀어낼 비-undo·비-progress 가 없으면
        // 상한을 넘겨도 둔다.
        while (next.length > 3) {
          const victim = next.findIndex((t) => t.kind !== 'undo' && t.kind !== 'progress');
          if (victim === -1) break;
          next.splice(victim, 1);
        }
        return next;
      });

      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== item.id));
      }, ttlMs);
    };

    onAppError((error) => push({ id: nextId++, kind: 'error', error }));
    onAppNotice((message) => push({ id: nextId++, kind: 'notice', message }));
    // 5000ms matches the undo primitive's commit delay — by the time this fallback timer fires,
    // the primitive will normally have already emitted an explicit dismiss (see below).
    onUndoToast(({ id, label, onUndo, ttlMs, actionLabel, extraAction }) =>
      push({ id: nextId++, kind: 'undo', undoId: id, label, onUndo, actionLabel, extraAction }, ttlMs ?? 5000),
    );
    // Explicit dismiss from the primitive — commit fired, or the user undid it elsewhere. Remove
    // the matching toast immediately instead of waiting for its own fallback timer.
    onUndoToastDismiss((undoId) => {
      setToasts((prev) => prev.filter((item) => !(item.kind === 'undo' && item.undoId === undoId)));
    });

    // Progress toast: no ttl (see progressToast.ts) — same key updates the existing toast's label
    // in place rather than pushing a new one, and it is never evicted by the 3-toast cap above.
    onProgressToast(({ key, label }) => {
      setToasts((prev) => {
        const idx = prev.findIndex((item) => item.kind === 'progress' && item.progressKey === key);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...(next[idx] as Extract<ToastItem, { kind: 'progress' }>), label };
          return next;
        }
        return [...prev, { id: nextId++, kind: 'progress', progressKey: key, label }];
      });
    });
    // Caller-driven dismiss — the batch finished (success, failure, or exception).
    onProgressToastDismiss((key) => {
      setToasts((prev) => prev.filter((item) => !(item.kind === 'progress' && item.progressKey === key)));
    });
  }, []);

  if (toasts.length === 0) return null;

  const closeNotificationLabel = `${translate('common.close') || 'Close'} notification`;

  return (
    // bottom 은 --toast-bottom 이 있으면 그 값 — 폰 노트 화면은 하단 독 위로 올린다(styles/mobile/note-capture.css).
    <div role="region" aria-label="Notifications" style={{ position: 'fixed', bottom: `var(--toast-bottom, ${TOAST_EDGE})`, right: TOAST_EDGE, zIndex: 'var(--z-toast)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {toasts.map((t) => {
        if (t.kind === 'undo') {
          const dismiss = () => setToasts((prev) => prev.filter((item) => item.id !== t.id));
          const actionButtonStyle: React.CSSProperties = {
            flex: 'none',
            border: '1px solid var(--accent)',
            background: 'transparent',
            color: 'var(--accent)',
            borderRadius: 'var(--radius-sm)',
            padding: '4px 10px',
            fontSize: "var(--text-sm)",
            fontWeight: 600,
            cursor: 'pointer',
          };
          const closeButton = (area?: string) => (
            <button
              type="button"
              aria-label={closeNotificationLabel}
              onClick={dismiss}
              style={{ gridArea: area, cursor: 'pointer', opacity: 0.7, color: 'inherit', background: 'transparent', border: 'none', padding: "var(--space-2xs)", display: 'grid', placeItems: 'center' }}
            >
              <IconClose size={16} />
            </button>
          );
          const baseStyle: React.CSSProperties = {
            border: '1px solid var(--accent)',
            borderRadius: 'var(--radius-md)',
            padding: '12px 16px',
            color: 'var(--text)',
            boxShadow: 'var(--shadow-lg)',
            minWidth: TOAST_MIN_W,
            maxWidth: TOAST_MAX_W,
          };
          // 행동이 둘이면(내보내기 완료: [기본 앱으로 열기] · [폴더 열기]) 한 줄에 다 안 들어간다 — 문구는 줄바꿈하고
          // 버튼은 아래 줄. DOM 순서(문구 → 버튼들 → 닫기)는 한 줄짜리와 같게 두고 자리는 그리드 영역으로 잡는다.
          const extra = t.extraAction;
          if (extra) {
            return (
              <div key={t.id} className="overlay ai-toast" role="status" aria-live="polite" aria-atomic="true" style={{
                ...baseStyle,
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) auto',
                gridTemplateAreas: '"label close" "actions actions"',
                alignItems: 'start',
                columnGap: 12,
                rowGap: 8,
              }}>
                <div style={{ gridArea: 'label', minWidth: 0, fontSize: "var(--text-md)", overflowWrap: 'anywhere' }}>
                  {t.label}
                </div>
                <div style={{ gridArea: 'actions', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => {
                      t.onUndo();
                      dismiss();
                    }}
                    style={actionButtonStyle}
                  >
                    {t.actionLabel ?? translate('undo.action')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      extra.onAction();
                      dismiss();
                    }}
                    style={actionButtonStyle}
                  >
                    {extra.label}
                  </button>
                </div>
                {closeButton('close')}
              </div>
            );
          }
          return (
            <div key={t.id} className="overlay ai-toast" role="status" aria-live="polite" aria-atomic="true" style={{
              ...baseStyle,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: "var(--text-md)", whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {t.label}
              </div>
              <button
                type="button"
                onClick={() => {
                  t.onUndo();
                  dismiss();
                }}
                style={actionButtonStyle}
              >
                {t.actionLabel ?? translate('undo.action')}
              </button>
              {closeButton()}
            </div>
          );
        }

        let color = 'var(--faint)';
        let title = '';
        let message = '';
        if (t.kind === 'error') {
          if (t.error.code === 'VALIDATION' || t.error.code === 'CONFLICT') {
            color = 'var(--danger-soft)';
          } else if (t.error.code === 'IO' || t.error.code === 'DB') {
            color = 'var(--danger)';
          }
          const friendly = formatFriendlyError(t.error);
          title = friendly.title;
          message = friendly.message;
        } else if (t.kind === 'progress') {
          // Same markup as 'notice' below (no separate style) — just no title line, since a
          // progress toast is identified by its own persistent presence, not by an "error/notice"
          // label.
          color = 'var(--info)';
          message = t.label;
        } else {
          color = 'var(--info)';
          title = 'Notice';
          message = t.message;
        }

        return (
          <div
            key={t.id}
            className="overlay ai-toast"
            role={t.kind === 'error' ? 'alert' : 'status'}
            aria-live={t.kind === 'error' ? 'assertive' : 'polite'}
            aria-atomic="true"
            style={{
            border: `1px solid ${color}`,
            borderRadius: 'var(--radius-md)',
            padding: '12px 16px',
            color: 'var(--text)',
            boxShadow: 'var(--shadow-lg)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            minWidth: TOAST_MIN_W,
            maxWidth: TOAST_MAX_W,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              {title && <div style={{ fontSize: "var(--text-md)", fontWeight: 600, color }}>{title}</div>}
              <div style={{ fontSize: "var(--text-sm)", marginTop: title ? 4 : 0, opacity: 0.9, overflowWrap: 'anywhere' }}>{message}</div>
            </div>
            <button
              type="button"
              aria-label={closeNotificationLabel}
              style={{ cursor: 'pointer', opacity: 0.7, color: 'inherit', background: 'transparent', border: 'none', padding: "var(--space-2xs)", display: 'grid', placeItems: 'center' }}
              onClick={() => setToasts((prev) => prev.filter((item) => item.id !== t.id))}
            >
              <IconClose size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
};
