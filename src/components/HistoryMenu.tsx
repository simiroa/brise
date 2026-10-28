/**
 * 프레임의 활동 기록 버튼 — 알림 벨과 같은 드롭다운(FrameMenu)으로 연다(오너 2026-10-27). 예전엔 누르면
 * 곧바로 별도 OS 창(activity_window.rs)이 떴다. 창은 없애지 않고 메뉴 아래 "새 창으로 보기"로 남긴다 —
 * 메인 창 옆에 띄워 두고 노트를 오가며 보는 쓰임이 있다.
 *
 * 메뉴는 본 창 안이라 별도 창의 우회가 필요 없다: 노트 열기는 selectNote(패널 기본 경로), 복원은 본 창
 * 브리지 함수(handleActivityRestoreSnapshot — flush·분리 섹션 회수 포함)를 직접 부른다.
 * 저장 실패 상태일 때 이 버튼은 그대로 "다시 저장" 버튼이다(onRetry).
 */
import { Suspense } from "react";
import { t } from "../i18n/t";
import { callSilent } from "../lib/invoke";
import { preloadIntentProps } from "../lib/lazyPreload";
import { handleActivityRestoreSnapshot } from "../lib/activityWindowBridge";
import { LazyActivityHistoryPanel } from "../lazySurfaces";
import { FrameMenuPop, useFrameMenu } from "./FrameMenu";
import { IconHistory } from "./icons";

function openActivityWindow() {
  void callSilent("activity_window_open", {}).catch(() => {
    // silent-ok: callSilent 가 이미 진단에 남겼다.
  });
}

export function HistoryMenu({
  title,
  ariaLabel,
  color,
  onRetry,
}: {
  title: string;
  ariaLabel: string;
  color?: string;
  /** 저장 실패 중이면 메뉴 대신 다시 저장한다. */
  onRetry?: () => void;
}) {
  const menu = useFrameMenu();
  const { setOpen, anchorRef } = menu;
  return (
    <div ref={anchorRef} style={{ flex: "none", display: "flex" }}>
      <button
        type="button"
        className="icon-btn"
        data-testid="frame-history-btn"
        {...preloadIntentProps(LazyActivityHistoryPanel)}
        onClick={onRetry ?? (() => setOpen((v) => !v))}
        title={title}
        aria-label={ariaLabel}
        style={{ color }}
      >
        {/* 저장 중에도 아이콘을 돌리지 않는다 — 자동저장이 잦아 쉬지 않고 도는 게 거슬렸다(오너
            2026-10-13). 저장 상태는 색(강조/위험)과 툴팁으로만 알린다. */}
        <IconHistory size={16} strokeWidth={1.8} />
      </button>
      <FrameMenuPop menu={menu} label={t("activity.modal_title")} testId="frame-history-pop">
        <Suspense fallback={null}>
          <LazyActivityHistoryPanel
            onClose={() => setOpen(false)}
            onRestoreSnapshot={(id) => handleActivityRestoreSnapshot({ id })}
          />
        </Suspense>
        <div className="frame-menu__footer">
          <button
            type="button"
            className="btn"
            data-testid="frame-history-open-window"
            onClick={() => {
              setOpen(false);
              openActivityWindow();
            }}
            style={{ fontSize: "var(--text-sm)" }}
          >
            {t("activity.open_window")}
          </button>
        </div>
      </FrameMenuPop>
    </div>
  );
}
