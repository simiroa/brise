import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

/** call() 을 커맨드별로 그럴싸한 기본값으로 응답 — usePetTheme/PetSprite 의 부수 조회까지
 *  전부 이 창이 부트에서 실제로 부르는 커맨드다. */
function defaultCall(cmd: string) {
  switch (cmd) {
    case "pet_theme":
      return Promise.resolve({
        theme: "dark",
        accent: "#5b8def",
        font_scale: 1,
        capture_screenshot: false,
        surface_style: "flat",
        sheet_alpha: 0.85,
        ai_enabled: true,
        pet_dblclick_action: "new_note",
        chat_write_enabled: true,
      });
    case "pet_packages_list":
      return Promise.resolve({ items: [] });
    case "pet_assets_list":
      return Promise.resolve({ items: [] });
    case "pet_notifications":
      return Promise.resolve({ items: [] });
    case "pet_package_asset":
      return Promise.resolve({});
    case "pet_bubble_notice":
      return Promise.resolve({ shown: true });
    case "pet_bubble_toggle":
    case "pet_open_main":
    case "pet_chat_clear":
    case "pet_bubble_close":
    case "pet_close":
    case "pet_set_position":
    case "pet_menu_popup":
      return Promise.resolve({});
    default:
      return Promise.reject(new Error("unexpected pet cmd: " + cmd));
  }
}
const callMock = vi.fn(defaultCall);
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => (callMock as (...a: unknown[]) => unknown)(...args),
  callSilent: (...args: unknown[]) => (callMock as (...a: unknown[]) => unknown)(...args),
}));

const listenMock = vi.fn();
const emitMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
  emit: (...args: unknown[]) => emitMock(...args),
}));

const winMock = {
  onMoved: vi.fn(async () => () => {}),
  outerPosition: vi.fn(async () => ({ toLogical: () => ({ x: 0, y: 0 }) })),
  scaleFactor: vi.fn(async () => 1),
  startDragging: vi.fn(async () => {}),
};
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => winMock,
}));

import { PetApp } from "./PetApp";

/** listen() 에 등록된 핸들러를 이벤트 이름으로 꺼내 직접 쏜다(브리지 테스트들과 같은 모양). */
function fire(event: string, payload: unknown): void {
  const entry = listenMock.mock.calls.find((c) => c[0] === event);
  if (!entry) throw new Error(`no handler registered for ${event}`);
  act(() => {
    (entry[1] as (e: { payload: unknown }) => void)({ payload });
  });
}

// act()로 감싼다 — PetSprite의 usePetPackage가 이제 Promise.all(list, asset)을 동시에 쏘고
// 합쳐서 setState하므로(직렬 워터폴 제거, 핸드오프 2026-08-10), act() 밖에서 awaiting만 하면
// React가 그 갱신을 커밋 안 하고 남겨둘 수 있다("not wrapped in act" 경고가 바로 그 신호).
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

function reset() {
  callMock.mockClear();
  // 한 테스트에서 갈아 끼운 응답이 다음 테스트로 새지 않게 매번 기본값으로 되돌린다.
  callMock.mockImplementation(defaultCall);
  listenMock.mockReset();
  listenMock.mockResolvedValue(vi.fn());
  emitMock.mockReset();
  emitMock.mockResolvedValue(undefined);
}

describe("PetApp — remote-note-write 필터", () => {
  beforeEach(reset);

  it("origin이 remote면 무시한다(activity가 idle에 머문다)", async () => {
    render(<PetApp />);
    await flush();
    fire("remote-note-write", { note_id: "n1", created: true, origin: "remote" });
    await flush();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("idle");
  });

  it("created:false 는 무시한다 — 자동저장 업데이트 폭풍을 흡수", async () => {
    render(<PetApp />);
    await flush();
    fire("remote-note-write", { note_id: "n1", created: false, origin: "local" });
    await flush();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("idle");
  });

  it("origin:local && created:true 는 succeeded 로 전환한다(SVG 폴백 aria-label로 확인)", async () => {
    render(<PetApp />);
    await flush();
    fire("remote-note-write", { note_id: "n1", created: true, origin: "local" });
    await flush();
    // LEGACY_MOOD: succeeded → "happy"
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("happy");
  });
});

describe("PetApp — pet-signal 라우팅", () => {
  beforeEach(reset);

  it("알려진 kind는 activity에 반영된다(failure → alert)", async () => {
    render(<PetApp />);
    await flush();
    fire("pet-signal", { kind: "failure" });
    await flush();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("alert");
  });

  it("알 수 없는 kind는 무시하고 크래시하지 않는다", async () => {
    render(<PetApp />);
    await flush();
    expect(() => fire("pet-signal", { kind: "not-a-real-kind" })).not.toThrow();
    await flush();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("idle");
  });
});

describe("PetApp — 드래그와 클릭 구분", () => {
  beforeEach(reset);

  it("드래그 없이 누르고 떼면 pet_bubble_toggle 을 부른다(greet)", async () => {
    render(<PetApp />);
    await flush();
    const sprite = document.querySelector(".pet-app__sprite") as HTMLElement;
    callMock.mockClear();
    fireEvent.pointerDown(sprite, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(sprite, { button: 0, clientX: 10, clientY: 10 });
    await flush();
    expect(callMock.mock.calls.some((c) => c[0] === "pet_bubble_toggle")).toBe(true);
  });

  it("문턱 이상 움직이면 드래그로 승격되고, 뗄 때 채팅을 열지 않는다", async () => {
    render(<PetApp />);
    await flush();
    const sprite = document.querySelector(".pet-app__sprite") as HTMLElement;
    callMock.mockClear();
    fireEvent.pointerDown(sprite, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(sprite, { button: 0, clientX: 40, clientY: 40 }); // > 4px 문턱
    fireEvent.pointerUp(sprite, { button: 0, clientX: 40, clientY: 40 });
    await flush();
    expect(callMock.mock.calls.some((c) => c[0] === "pet_bubble_toggle")).toBe(false);
    expect(winMock.startDragging).toHaveBeenCalled();
  });

  it("더블클릭 액션(new_note)과 트리플클릭(openMain)이 의도대로 동작한다", async () => {
    render(<PetApp />);
    await flush();
    const sprite = document.querySelector(".pet-app__sprite") as HTMLElement;
    callMock.mockClear();

    // 더블클릭 (기본값 new_note -> pet_open_main + pet-action-new-note)
    fireEvent.click(sprite, { button: 0, detail: 2 });
    await flush();
    expect(callMock.mock.calls.some((c) => c[0] === "pet_open_main")).toBe(true);

    callMock.mockClear();
    fireEvent.click(sprite, { button: 0, detail: 3 });
    await flush();
    expect(callMock.mock.calls.some((c) => c[0] === "pet_open_main")).toBe(true);
  });

  it("AI 비활성화 시 채팅 액션이 메인 창 열기로 폴백된다", async () => {
    // W18 B2: 반응 설정은 pet_theme 경유로 온다 — settings_get_all 은 펫 창에서 금지된
    // 커맨드라 성공 목으로 스텁하지 않는다(AUDIT-2026-08-22-debris.md §7.1).
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "pet_theme") {
        return Promise.resolve({
          theme: "dark",
          accent: "#5b8def",
          font_scale: 1,
          capture_screenshot: false,
          surface_style: "flat",
          sheet_alpha: 0.85,
          ai_enabled: false,
          pet_dblclick_action: "off",
          chat_write_enabled: true,
        });
      }
      return defaultCall(cmd);
    });

    render(<PetApp />);
    await flush();
    const sprite = document.querySelector(".pet-app__sprite") as HTMLElement;
    callMock.mockClear();

    fireEvent.pointerDown(sprite, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(sprite, { button: 0, clientX: 10, clientY: 10 });
    await flush();

    // AI 꺼짐 -> chat 대신 메인 창 열기(openMain) 호출
    expect(callMock.mock.calls.some((c) => c[0] === "pet_bubble_toggle")).toBe(false);
    expect(callMock.mock.calls.some((c) => c[0] === "pet_open_main")).toBe(true);
  });

  it("금지 커맨드(settings_get_all)를 부르지 않는다 — pet_theme 경유로만 반응 설정을 읽는다", async () => {
    render(<PetApp />);
    await flush();
    expect(callMock.mock.calls.some((c) => c[0] === "settings_get_all")).toBe(false);
  });
});

describe("PetApp — 우클릭 메뉴(= 트레이 메뉴)", () => {
  beforeEach(reset);

  it("우클릭은 Rust 의 공용 메뉴를 띄우고, HTML 로 두 번째 목록을 그리지 않는다", async () => {
    render(<PetApp />);
    await flush();
    callMock.mockClear();
    fireEvent.contextMenu(document.querySelector(".pet-app__sprite") as HTMLElement, {
      clientX: 5,
      clientY: 5,
    });
    await flush();
    expect(callMock.mock.calls.some((c) => c[0] === "pet_menu_popup")).toBe(true);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("메뉴의 클립보드 저장(pet-menu-run)은 Rust 가 읽은 텍스트를 다리로 넘긴다", async () => {
    render(<PetApp />);
    await flush();
    fire("pet-menu-run", { action: "clipboard", text: "  hello  " });
    await flush();
    expect(emitMock).toHaveBeenCalledWith("pet-clipboard-save", { text: "hello" });
  });

  it("빈 클립보드는 다리로 넘기지 않고 말풍선으로 알린다", async () => {
    render(<PetApp />);
    await flush();
    callMock.mockClear();
    fire("pet-menu-run", { action: "clipboard", text: "   " });
    await flush();
    expect(emitMock).not.toHaveBeenCalledWith("pet-clipboard-save", expect.anything());
    const calls = callMock.mock.calls as unknown as [string, { text?: string }][];
    expect(calls.some((c) => c[0] === "pet_bubble_notice" && (c[1]?.text ?? "").includes("비어"))).toBe(true);
  });
});

describe("PetApp — 화면 저장 감시 타이머", () => {
  beforeEach(() => {
    reset();
    callMock.mockImplementation((cmd: string) =>
      cmd === "pet_theme"
        ? Promise.resolve({
            theme: "dark",
            accent: "#5b8def",
            font_scale: 1,
            capture_screenshot: true,
            surface_style: "flat",
            sheet_alpha: 0.85,
            ai_enabled: true,
            pet_dblclick_action: "new_note",
            chat_write_enabled: true,
          })
        : defaultCall(cmd),
    );
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 회귀: emit() 성공은 "누가 들었다"가 아니다 — 메인 창이 안 듣고 있으면 "살펴보는 중…"
   *  말풍선이 영원히 남았다. */
  it("결과 신호가 안 오면 실패 안내로 바꾼다", async () => {
    render(<PetApp />);
    await flush();
    fire("pet-menu-run", { action: "capture" });
    await flush();
    expect(emitMock).toHaveBeenCalledWith("pet-screenshot-capture", {});

    callMock.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(85_000);
    });
    // callMock 은 (cmd) 시그니처라 두 번째 인자는 타입에 없다 — 검사만 넓혀 읽는다.
    const calls = callMock.mock.calls as unknown as [string, { text?: string }][];
    expect(
      calls.some((c) => c[0] === "pet_bubble_notice" && (c[1]?.text ?? "").includes("응답하지 않아요")),
    ).toBe(true);
  });

  it("브리지가 결과를 주면(task-done) 타이머가 풀려 실패 안내가 안 뜬다", async () => {
    render(<PetApp />);
    await flush();
    fire("pet-menu-run", { action: "capture" });
    await flush();

    fire("pet-signal", { kind: "task-done" });
    callMock.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(85_000);
    });
    expect(callMock.mock.calls.some((c) => c[0] === "pet_bubble_notice")).toBe(false);
  });
});
