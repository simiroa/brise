import { useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { t } from "../i18n/t";
import { IconCalendar, IconMapPin } from "../components/icons";
import { keepEditorFocus } from "./keepEditorFocus";
import { useNudgeBubblePlacement } from "./useNudgeBubblePlacement";

export interface NudgeBubbleAction {
  key: "date" | "region";
  /** 알약에 보이는 글. 아이콘(달력·핀)이 접두를 대신한다. */
  text: string;
  /** 보이는 글보다 설명이 필요할 때(지역: 글은 이름뿐) 스크린리더용 전체 문구. */
  ariaLabel?: string;
  /** 눌러서 반영. 끝나면 닫는 쪽(훅)이 정한다 — MobileInputChips 의 nudge 칩과 같은 클로저다. */
  onApply: () => Promise<void> | void;
  onDismiss: () => void;
}
export interface NudgeBubbleModel {
  /** 말풍선이 앉을 문단의 시작 위치(문서 위치). 감지 시점의 값이라 렌더 때 커서 문단으로 다시 구하지 않는다. */
  anchorPos: number | null;
  /** 1~2개(날짜·지역) — 한 말풍선 안에 나란히. */
  actions: NudgeBubbleAction[];
}

interface Props {
  editor: Editor;
  model: NudgeBubbleModel | null;
  /** 위치 기준 상자(.mobile-note-stage) 요소. 이 안에서 absolute 로 뜬다. 콜백 ref → 상태로 받는다(훅 주석). */
  stage: HTMLElement | null;
  /** 에디터를 담은 스크롤 영역 요소 — 보이는 범위와 스크롤 이벤트의 출처. */
  scroll: HTMLElement | null;
}

/**
 * 날짜·지역 입력 감지 제안 — 감지된 **문장(문단) 위**에 뜨는 작은 말풍선(오너 2026-10-07).
 * 링크·#태그는 키보드 위 칩 줄(MobileInputChips variant="nudge")에 남는다.
 *
 * 에디터 문서 밖의 오버레이다 — ProseMirror 에 Decoration·노드를 넣지 않으므로 IME 조합을 건드리지 않는다.
 * 자리는 useNudgeBubblePlacement 가 잡는다(문단 첫 줄 위 · 자리가 없으면 마지막 줄 아래로 뒤집힘 · 영역 밖이면 숨김).
 *
 * 포커스를 뺏지 않는다: 눌러도 에디터 선택·화면 키보드가 그대로다(keepEditorFocus — 루트에 위임 한 곳).
 * 누르는 영역은 알약(38px)보다 크다 — CSS 가 ::after 로 48px 히트존을 만든다(note-editor-aids.css).
 */
export function MobileNudgeBubble({ editor, model, stage, scroll }: Props) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const actions = model?.actions ?? [];
  const pos = useNudgeBubblePlacement({
    editor,
    anchorPos: model?.anchorPos ?? null,
    stage,
    scroll,
    bubbleRef,
    contentKey: actions.map((a) => `${a.key}:${a.text}`).join("|"),
  });
  if (!model || actions.length === 0) return null;

  return (
    <div
      ref={bubbleRef}
      className="mobile-nudge-bubble"
      data-testid="mobile-nudge-bubble"
      data-placement={pos.placement}
      role="status"
      aria-label={t("mobileInput.bubble_group")}
      // left/top 이 아니라 transform — absolute + left 는 버블의 shrink-to-fit 너비를 줄여 글이 접힌다.
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
      onMouseDown={keepEditorFocus}
    >
      <div className="mobile-nudge-bubble-surface overlay">
        {actions.map((a) => {
          const Icon = a.key === "date" ? IconCalendar : IconMapPin;
          return (
            <div key={a.key} className="mobile-nudge-bubble-action" data-kind={a.key}>
              <button
                type="button"
                className="mobile-nudge-bubble-main"
                tabIndex={-1}
                aria-label={a.ariaLabel}
                disabled={busy === a.key}
                onClick={() => {
                  setBusy(a.key);
                  void (async () => {
                    try {
                      await a.onApply();
                    } catch {
                      // silent-ok: onApply 구현이 call() 토스트·진단으로 이미 알렸다 — 제안은 남겨 다시 누를 수 있게 한다.
                    } finally {
                      setBusy(null);
                    }
                  })();
                }}
              >
                <Icon size={16} strokeWidth={2} aria-hidden="true" />
                <span className="mobile-nudge-bubble-text">{a.text}</span>
              </button>
              <button
                type="button"
                className="mobile-nudge-bubble-x"
                tabIndex={-1}
                aria-label={t("mobileInput.chip_dismiss")}
                onClick={a.onDismiss}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
