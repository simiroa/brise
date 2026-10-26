/**
 * 설정/활동/AI 히스토리 OS 창의 공통 크롬.
 *
 * 별도 OS 창인 이유·`owner` vs `parent`·Acrylic 전제는 src-tauri/src/aux_window.rs 참고.
 * 엔트리가 App.tsx 를 부팅하지 않으므로 tokens.css 를 여기서 직접 로드한다.
 *
 * 창 크롬(제목/닫기/드래그)은 데코레이션 없이 여기서 그린다. 배경은 칠하지 않는다:
 * 네이티브 Acrylic 재질이 뒤에 있는 본 창을 실제로 블러하고, `.app` 시트가 --sheet-alpha
 * 만큼만 덮는다(tokens.css 단일 시트 계약).
 */
import { useEffect, type JSX, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettingsStore } from "../stores/settings";
import { applySavedAppearanceSeed } from "../lib/appearance";
import { listenSettingsChanged } from "../lib/settingsChanged";
import { WindowCloseButton } from "./common/WindowCloseButton";
import { isOverlayOpen } from "../lib/overlayStack";
import { closeActionForLabel } from "../lib/invoke";
import { isBrowser } from "../lib/env";
import { reportFallback } from "../lib/diag";
import { waitForPaintedFrame } from "../lib/bootWindow";
import "../styles/tokens.css";

// WAVE K — React 렌더 이전에 동기로 외형 시드 적용 (첫 페인트 스타일 지연 깜빡임 방지)
applySavedAppearanceSeed();

// ponytail: 보조 창 3개가 상주한다. 메모리가 문제되면 설정만 hide, 나머지는 close
// 섹션 분리 창만 예외 — close() 로 onCloseRequested(lib/invoke.ts)를 태워 저장 후 destroy 한다
// (그 창은 "존재 = 분리 중"이라 숨기면 본 창이 영원히 분리 상태로 본다).
export function closeCurrentAuxWindow(): void {
  const win = getCurrentWindow();
  if (closeActionForLabel(win.label) === "destroy") void win.close();
  else void win.hide();
}

/** 한 프레임이 실제로 그려진 뒤 창을 보인다. 이미 보이는 창(다시 열기·브라우저 모드)에는 무해하다. */
async function revealAfterPaint(): Promise<void> {
  if (isBrowser()) return;
  await waitForPaintedFrame();
  try {
    await getCurrentWindow().show();
  } catch (e) {
    // Rust failsafe(aux_window::reveal_failsafe)가 3초 뒤 띄운다 — 여기선 기록만.
    reportFallback("aux_window", "show_failed", String(e));
  }
}

export function AuxWindowChrome(props: {
  title: string;
  closeTestId: string;
  /** Mount-only. Called after load + applySurfaceEffectAfterShow. Do not put in effect deps. */
  onReady?: () => void;
  /**
   * PLAN-2026-09-15 D10: 타이틀 스트립을 아예 그리지 않는다(children 만). 설정 창만 켠다 —
   * 제목은 레일 맨 위, 닫기 X 는 본문 우상단으로 옮겨 그리고, 드래그 영역도 그 둘이 맡는다.
   */
  hideHeader?: boolean;
  /**
   * 제목 자리(고정 <h1>{title}</h1>)를 대신 그릴 커스텀 콘텐츠 — HANDOFF-2026-08-30 캔버스
   * UX 2차, "페이지 선택기를 창 제목 자리로 이전". 지금은 캔버스 창만 쓴다: 페이지 선택기가
   * "캔버스" 라벨 자리를 대신 차지해 누르면 페이지를 전환한다. 설정·활동이력·AI 히스토리
   * 3개 창은 이 prop 을 넘기지 않으므로 지금까지와 100% 동일하게 <h1> 로 그려진다 — 아래
   * 렌더에서 `titleSlot ?? <h1>...</h1>` 로 완전히 대체하지 않고 골라 그리기 때문에, 세 창의
   * 회귀 위험은 "이 prop 을 실수로 넘기는 호출부가 생기는 것"뿐이다.
   */
  titleSlot?: ReactNode;
  /** 기본 true. 섹션 분리 창은 끈다 — 에디터 안의 Esc(표 벗어나기·선택 해제 등)가 전부 overlayStack 에
   *  등록돼 있지 않아, 켜 두면 편집 중 Esc 한 번에 창이 닫힌다. */
  escapeCloses?: boolean;
  /** 제목줄 오른쪽, 닫기 버튼 앞에 렌더할 컨트롤(브리핑 창의 "편집" 토글). 안 넘기면 아무것도 추가되지 않는다. */
  actions?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const { title, closeTestId, onReady, hideHeader, titleSlot, escapeCloses = true, actions, children } = props;

  useEffect(() => {
    // 이 창들은 숨긴 채 만들어진다(src-tauri/src/aux_window.rs) — 설정을 읽고, 그 모습이 한 프레임
    // 그려진 뒤에 show() 한다. 보이는 채로 만들던 때는 빈 창 → 불투명 부팅색 → 뚫린 투명 창 → 완성이
    // 첫 열기마다 ~1초 보였다. 아크릴은 그 **뒤**다 — load() 는 아크릴을 걸지 않는다: 숨긴 HWND 에
    // window-vibrancy 를 걸면 창이 영영 안 뜬다(applySurfaceEffectAfterShow, stores/settings.ts).
    // 안 부르면 보조 창만 영원히 flat 으로 남는다(2026-08-14 실측). show 가 실패해도 Rust failsafe 가 띄운다.
    void useSettingsStore
      .getState()
      .load()
      .then(revealAfterPaint, (e: unknown) => {
        // 설정을 못 읽어도 창은 보여야 한다 — 시드(지난 모습)로 그린 채 드러낸다.
        reportFallback("aux_window", "load_failed_reveal", String(e));
        return revealAfterPaint();
      })
      .then(() => useSettingsStore.getState().applySurfaceEffectAfterShow())
      .then(() => onReady?.());
  }, []);

  // 다른 창에서 테마/강조색을 바꿔도 이미 열려 있는 이 창에 반영되도록.
  useEffect(() => listenSettingsChanged(), []);

  // 본 창과 같은 키(Escape)로 닫힌다 — 단, Escape 소비 체인(lib/overlayStack.ts,
  // HANDOFF-2026-08-30 §0 "Escape 소비 체인 재설계")이 완전히 비어 있을 때만. 이 창은 설정·
  // 활동이력·AI 히스토리 3개가 공유하는 크롬이다(2026-09-28: 캔버스 플러그인 제거로 4개→3개) —
  // 이들은 오버레이(팝오버·모달) 정도만 이 체인에 등록하지만, 이 hook(useEscapeConsumer) 자체는
  // 여전히 범용이라 "무언가 진행 중이면 Esc 로 창이 안 꺼지고, 정말 아무 것도 안 하고 있을 때만
  // 꺼진다"를 창 종류 구분 없이 만족한다.
  //
  // `isOverlayOpen()` 만 보고 `e.defaultPrevented` 는 보지 않는다 — 의도적이다. 체인 등록
  // (`pushOverlay`)은 이 keydown 이 벌어지기 훨씬 전, 그 모드가 켜지던 시점에 이미 끝나
  // 있으므로 `isOverlayOpen()` 은 항상 정확하다. `defaultPrevented` 는 그렇지 않다 — 같은
  // keydown 디스패치 안에서 "누가 먼저 preventDefault 를 부르는가"에 기대는 신호라 리스너
  // 등록 순서에 우연히 좌우된다(실측: 테스트로 재현됨. AuxWindowChrome.test.tsx 참고).
  //
  // `capture: true` 로 등록하는 이유도 같은 순서 문제 때문이다 — 텍스트 편집·드로우 모드처럼
  // 나중에 상태 전환으로 등록되는 소비자들의 keydown 리스너(전부 버블 단계, capture 없음)가
  // 이 리스너보다 먼저 켜져 있어도, capture 리스너는 캡처 단계에서 항상 먼저 실행되므로 —
  // 그 소비자가 스택에서 자기 항목을 미처 팝하기 전에 — `isOverlayOpen()` 이 그 항목을 정확히
  // 본다. capture 없이 버블 단계에만 등록했다면 등록 순서에 따라 소비자가 먼저 팝해버린 뒤
  // 이 리스너가 빈 스택을 보고 잘못 닫는 경우가 생긴다(재현: 마운트와 동시에 등록되는 소비자로
  // 테스트했을 때 실패).
  useEffect(() => {
    if (!escapeCloses) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.isComposing) return; // IME 조합 취소 — 모드 이탈이 아니다.
      if (isOverlayOpen()) return; // 체인에 아직 뭔가 남아 있음(오버레이·편집·드로우 모드 등)
      closeCurrentAuxWindow();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [escapeCloses]);

  return (
    <div className="app" style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      {!hideHeader && (
        // 머리줄은 메인 창 스트립과 같은 높이(--row-chrome) · 아래 구분선 없음 · 제목 크기는 설정 레일
        // 헤더와 같은 --text-lg/600 하나(GRILL-2026-10-19 R1-E). 높이가 고정이라 세로 패딩은 두지
        // 않는다. titleSlot(섹션 분리 창의 이름 입력)도 같은 크기를 쓴다 — SectionNameTitle.tsx.
        <div
          data-tauri-drag-region
          data-testid="aux-window-header"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            height: "var(--row-chrome)",
            padding: "0 var(--space-3) 0 var(--space-7)",
            flex: "none",
          }}
        >
          {titleSlot ?? (
            <h1
              data-tauri-drag-region
              style={{ margin: 0, fontSize: "var(--text-lg)", fontFamily: "var(--font-heading)", fontWeight: 600 }}
            >
              {title}
            </h1>
          )}
          <div style={{ marginLeft: "auto", ...(actions ? { display: "flex", alignItems: "center", gap: "var(--space-3)" } : null) }}>
            {actions}
            <WindowCloseButton onClose={closeCurrentAuxWindow} testId={closeTestId} />
          </div>
        </div>
      )}
      {children}
    </div>
  );
}
