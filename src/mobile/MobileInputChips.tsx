import { useState } from "react";
import { t } from "../i18n/t";

export interface InputChip {
  key: string;
  text: string;
  /** 눌러서 반영. 끝나면(성공이든 아니든) 칩은 onDismiss 로 닫는 쪽이 정한다. */
  onApply: () => Promise<void> | void;
  onDismiss: () => void;
  /** 입력 감지 칩(variant="nudge") — 알약 한 개. 눌러도 키보드가 내려가지 않게 포커스를 뺏지 않는다. */
  nudge?: boolean;
  /** 무시 버튼 없음(태그 칩 — 질의가 바뀌면 갈아 끼우는 것이라 무시 대상이 아니다). */
  noDismiss?: boolean;
}

/** 제안 칩 줄(사진/음성 메타·날짜 후보·현재 위치) — 기존 인플로우 배너(.mobile-remote-banner)를 그대로 쓴다. */
export function MobileInputChips({ chips, variant }: { chips: InputChip[]; variant?: "nudge" }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (chips.length === 0) return null;
  if (variant === "nudge") {
    // 한 줄·가로 스크롤 — 입력 중에 높이가 출렁이지 않는다(§3.5). 칩은 text 자체가 눌러서 반영하는 버튼이다.
    return (
      <div className="mobile-nudge-row" data-testid="mobile-nudge-chips" role="status">
        {chips.map((c) => (
          <span key={c.key} className="mobile-nudge-chip">
            <button
              type="button"
              className="mobile-nudge-chip-main"
              disabled={busy === c.key}
              // 눌러도 에디터 포커스(=키보드)를 유지한다.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setBusy(c.key);
                void (async () => {
                  try {
                    await c.onApply();
                  } catch {
                    // silent-ok: onApply 구현이 call() 토스트·진단으로 이미 알렸다.
                  } finally {
                    setBusy(null);
                  }
                })();
              }}
            >
              {c.text}
            </button>
            {!c.noDismiss && (
              <button
                type="button"
                className="mobile-nudge-chip-x"
                aria-label={t("mobileInput.chip_dismiss")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={c.onDismiss}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>
    );
  }
  return (
    // .mobile-input-chips: 키보드가 열려 있는 동안 숨기는 대상(tabbar.css `data-kbd="open"` — C 규칙, 오너 2026-10-07).
    // 타이핑 중 키보드 위에 74px 카드가 쌓이면 본문이 안 보인다. 키보드를 내리면 돌아온다.
    <div className="mobile-input-chips" data-testid="mobile-input-chips">
      {chips.map((c) => (
        <div key={c.key} className="mobile-remote-banner card" role="status">
          <span className="mobile-remote-banner-text">{c.text}</span>
          <button
            type="button"
            className="mobile-remote-banner-action"
            disabled={busy === c.key}
            onClick={() => {
              setBusy(c.key);
              void (async () => {
                try {
                  await c.onApply();
                } catch {
                  // silent-ok: onApply 구현이 call() 토스트·진단으로 이미 알렸다 — 칩은 남겨 다시 누를 수 있게 한다.
                } finally {
                  setBusy(null);
                }
              })();
            }}
          >
            {t("mobileInput.chip_apply")}
          </button>
          <button type="button" className="mobile-remote-banner-action" onClick={c.onDismiss}>
            {t("mobileInput.chip_dismiss")}
          </button>
        </div>
      ))}
    </div>
  );
}
