import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { pushOverlay, useEscapeConsumer } from "../lib/overlayStack";

const win = {
  label: "settings",
  close: vi.fn(async () => {}),
  hide: vi.fn(async () => {}),
};

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));

vi.mock("../stores/settings", () => ({
  applySavedAppearanceSeed: vi.fn(),
  useSettingsStore: {
    getState: () => ({
      load: vi.fn(async () => {}),
      applySurfaceEffectAfterShow: vi.fn(async () => {}),
    }),
  },
}));

vi.mock("../lib/settingsChanged", () => ({
  listenSettingsChanged: () => () => {},
}));

vi.mock("../i18n/t", () => ({
  t: (k: string) => k,
}));

import { AuxWindowChrome } from "./AuxWindowChrome";

// 최소 stand-in: 실물 편집기(과거엔 canvas 플러그인의 TextNode) 대신 useEscapeConsumer 등록
// 계약만 재현한다 — 더블클릭으로 "편집 모드" 진입, 그 동안만 체인에 등록돼 있다.
function EditableStandIn() {
  const [editing, setEditing] = useState(false);
  useEscapeConsumer(editing, () => setEditing(false));
  return editing ? (
    <div data-testid="stand-in-editor" />
  ) : (
    <div data-testid="stand-in-node" onDoubleClick={() => setEditing(true)} />
  );
}

beforeEach(() => {
  win.label = "settings";
  win.close.mockClear();
  win.hide.mockClear();
});

describe("AuxWindowChrome", () => {
  it("actions 슬롯은 닫기 버튼 앞에 렌더되고, 안 넘기면 아무것도 추가되지 않는다", () => {
    const { rerender } = render(
      <AuxWindowChrome title="T" closeTestId="aux-close" actions={<button data-testid="aux-action">act</button>}>
        <div />
      </AuxWindowChrome>,
    );
    const close = screen.getByTestId("aux-close");
    const action = screen.getByTestId("aux-action");
    expect(action.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    rerender(
      <AuxWindowChrome title="T" closeTestId="aux-close">
        <div />
      </AuxWindowChrome>,
    );
    expect(screen.queryByTestId("aux-action")).toBeNull();
    expect(screen.getByTestId("aux-close").parentElement?.getAttribute("style")).toBe("margin-left: auto;");
  });

  it("renders title + children", () => {
    render(
      <AuxWindowChrome title="Settings" closeTestId="aux-close">
        <div data-testid="aux-child">panel</div>
      </AuxWindowChrome>,
    );

    expect(screen.getByText("Settings")).toBeTruthy();
    expect(screen.getByTestId("aux-child")).toBeTruthy();
    expect(screen.getByText("panel")).toBeTruthy();
  });

  it("close button calls win.hide", () => {
    render(
      <AuxWindowChrome title="Settings" closeTestId="aux-close">
        <div>panel</div>
      </AuxWindowChrome>,
    );

    fireEvent.click(screen.getByTestId("aux-close"));
    expect(win.hide).toHaveBeenCalledTimes(1);
  });

  it("section window (section-<id>): X closes (→ flush + destroy via onCloseRequested), never hides; Escape does not close when escapeCloses=false", () => {
    win.label = "section-abc";
    render(
      <AuxWindowChrome title="Section" closeTestId="aux-close" escapeCloses={false}>
        <div>panel</div>
      </AuxWindowChrome>,
    );
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(win.close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("aux-close"));
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(win.hide).not.toHaveBeenCalled();
  });

  it("Escape keydown on window calls win.hide when nothing else is active (idle canvas / plain window)", () => {
    render(
      <AuxWindowChrome title="Settings" closeTestId="aux-close">
        <div>panel</div>
      </AuxWindowChrome>,
    );

    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(win.hide).toHaveBeenCalledTimes(1);
  });

  // HANDOFF-2026-08-30 §0 "Escape 소비 체인 재설계" 의 오너 지적: (당시) 캔버스에서 텍스트 편집 중
  // Escape 를 누르면 편집만 취소돼야 하는데 창까지 꺼졌다. 편집기(구 canvas 플러그인의 TextNode,
  // 지금은 제거됨)는 편집 중일 때 lib/overlayStack.ts 의 useEscapeConsumer 로 스스로 등록한다 —
  // AuxWindowChrome 은 그 등록이 살아있는 동안 같은 Escape 로 닫히면 안 된다. openStack 은 모듈
  // 싱글턴이므로 두 컴포넌트(여기서는 최소 stand-in)를 실제로 함께 마운트해 그 계약을 교차
  // 검증한다(모킹으로 흉내내지 않는다).
  it("does not close while a mid-edit useEscapeConsumer registration is active (real overlayStack chain)", () => {
    render(
      <AuxWindowChrome title="Settings" closeTestId="aux-close">
        <EditableStandIn />
      </AuxWindowChrome>,
    );

    fireEvent.doubleClick(screen.getByTestId("stand-in-node"));
    expect(screen.getByTestId("stand-in-editor")).toBeDefined();

    // 편집 중 Escape — 창은 안 닫히고, 편집만 취소되어야 한다.
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(win.hide).not.toHaveBeenCalled();
    expect(screen.queryByTestId("stand-in-editor")).toBeNull();

    // 편집이 끝난 뒤(체인이 비었으니) 같은 키가 이제는 창을 닫는다 — "위젯 이동 상태"까지
    // 돌아온 다음에야 창 닫기라는 오너의 순서를 확인한다.
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(win.hide).toHaveBeenCalledTimes(1);
  });

  it("does not close while IME composition is in progress, even with no other consumer registered", () => {
    render(
      <AuxWindowChrome title="Settings" closeTestId="aux-close">
        <div>panel</div>
      </AuxWindowChrome>,
    );

    // 한글 등 조합 중의 Escape 는 조합 취소이지 모드/창 이탈이 아니다.
    fireEvent.keyDown(window, { key: "Escape", code: "Escape", isComposing: true });
    expect(win.hide).not.toHaveBeenCalled();
  });

  // 이 리스너는 창 마운트 시 가장 먼저 등록되므로, 같은 keydown 안에서 나중에 등록된 리스너가
  // preventDefault 를 부르는 시점보다 항상 먼저 실행된다 — 그래서 `e.defaultPrevented` 는
  // 신뢰할 수 없는 신호다(등록 순서에 우연히 기대게 됨. AuxWindowChrome.tsx 주석 참고). 대신
  // `isOverlayOpen()` 만 본다: 체인 등록은 이 keydown 이 벌어지기 전에 이미 끝나 있으므로
  // 순서 문제가 없다. 이 테스트는 그 설계 선택을 고정한다 — defaultPrevented 만으로는 창이
  // 안 닫는 걸 보장 못 한다는 회귀 방지용 대조군이다.
  it("preventDefault from an unrelated, later-registered listener does not by itself stop the close (only the escape chain does)", () => {
    render(
      <AuxWindowChrome title="Settings" closeTestId="aux-close">
        <div>panel</div>
      </AuxWindowChrome>,
    );

    const guard = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener("keydown", guard);
    try {
      fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
      expect(win.hide).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", guard);
    }
  });

  // 드로우 모드 등 (과거) 캔버스 페이지 레벨 임시 상태는 전부 이 hook 하나로 등록했다 — 여기서는
  // 그 정확한 계약(활성인 동안 체인에 남아 창이 안 닫히고, 소비되고 나면 즉시 빠져 다음 Escape 에
  // 창이 닫힐 수 있다)을 이 hook 자체로 검증한다.
  //
  // 이 자식은 마운트와 동시에 활성 상태로 등록된다 — 즉 useEscapeConsumer 의 (버블 단계) 리스너가
  // AuxWindowChrome 의 리스너보다 먼저 등록된다(React 는 자식 effect 를 부모보다 먼저 돈다).
  // 등록 순서만 봤다면 이 자식이 같은 keydown 안에서 먼저 스택을 비우고, AuxWindowChrome 은
  // 빈 스택을 보고 잘못 닫아야 한다 — 하지만 AuxWindowChrome 의 리스너는 `capture: true` 라
  // 등록 순서와 무관하게 항상 먼저 실행되어 정확히 본다. 이 테스트는 그 순서-불변성을 고정한다.
  it("does not close while any useEscapeConsumer-registered mode is active, regardless of registration order (e.g. draw mode)", () => {
    function DrawModeStandIn() {
      const [active, setActive] = useState(true);
      useEscapeConsumer(active, () => setActive(false));
      return null;
    }

    render(
      <AuxWindowChrome title="Canvas" closeTestId="aux-close">
        <DrawModeStandIn />
      </AuxWindowChrome>,
    );

    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(win.hide).not.toHaveBeenCalled();

    // 두 번째 Escape 는 위 이벤트에서 이미 "모드 종료"까지 소비했으니 이제 체인이 비어 창이 닫힌다.
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(win.hide).toHaveBeenCalledTimes(1);
  });

  it("leak guard: a properly-cleaned-up consumer does not keep blocking Escape after it's gone", () => {
    render(
      <AuxWindowChrome title="Canvas" closeTestId="aux-close">
        <div />
      </AuxWindowChrome>,
    );
    const removeOverlay = pushOverlay(() => {});
    removeOverlay();
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(win.hide).toHaveBeenCalledTimes(1);
  });

  // GRILL-2026-10-19 R1-E: 보조 창 머리줄 = 메인 창 스트립 높이(--row-chrome), 아래 구분선 없음,
  // 제목 크기는 설정 레일 헤더와 같은 --text-lg/600 하나.
  it("머리줄은 --row-chrome 높이 · 구분선 없음 · 제목은 --text-lg/600", () => {
    render(
      <AuxWindowChrome title="Briefing" closeTestId="aux-close">
        <div />
      </AuxWindowChrome>,
    );
    const header = screen.getByTestId("aux-window-header");
    expect(header.style.height).toBe("var(--row-chrome)");
    expect(header.style.borderBottom).toBe("");
    // 높이 고정 — 세로 패딩 없음(var() 섞인 단축 속성은 jsdom 이 롱핸드로 풀지 않아 원문으로 본다).
    expect(header.style.padding).toMatch(/^0(px)? \S+ 0(px)? \S+$/);
    const h1 = screen.getByText("Briefing");
    expect(h1.style.fontSize).toBe("var(--text-lg)");
    expect(h1.style.fontWeight).toBe("600");
  });

  // HANDOFF-2026-08-30 캔버스 UX 2차: 페이지 선택기를 창 제목 자리로 이전하기 위해 titleSlot 을
  // 추가했다. 설정/활동이력/AI 히스토리 3개 창은 이 prop 을 넘기지 않으므로 100% 동일하게 <h1> 로
  // 그려져야 한다(회귀 확인) — 캔버스 창만 titleSlot 을 넘겨 고정 라벨을 완전히 대체한다.
  describe("titleSlot", () => {
    it("renders the plain <h1>{title}</h1> when titleSlot is omitted (settings/activity/AI history — unchanged)", () => {
      render(
        <AuxWindowChrome title="Settings" closeTestId="aux-close">
          <div>panel</div>
        </AuxWindowChrome>,
      );
      const heading = screen.getByText("Settings");
      expect(heading.tagName).toBe("H1");
    });

    it("renders titleSlot instead of the <h1> title when provided", () => {
      render(
        <AuxWindowChrome
          title="Canvas"
          closeTestId="aux-close"
          titleSlot={<button type="button" data-testid="page-switcher-trigger">Page One</button>}
        >
          <div>panel</div>
        </AuxWindowChrome>,
      );
      expect(screen.queryByText("Canvas")).toBeNull();
      expect(screen.getByTestId("page-switcher-trigger").tagName).toBe("BUTTON");
      expect(screen.getByText("Page One")).toBeTruthy();
    });

    it("does not mark titleSlot content as a drag region — clicking it must not compete with window dragging", () => {
      render(
        <AuxWindowChrome
          title="Canvas"
          closeTestId="aux-close"
          titleSlot={<button type="button" data-testid="page-switcher-trigger">Page One</button>}
        >
          <div>panel</div>
        </AuxWindowChrome>,
      );
      const btn = screen.getByTestId("page-switcher-trigger");
      expect(btn.hasAttribute("data-tauri-drag-region")).toBe(false);
    });
  });
});
