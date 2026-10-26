import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProductUpdateCard } from "./ProductUpdateCard";
import { useUpdateStatus } from "./updateStatus";
import { useSettingsStore } from "../../stores/settings";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("0.5.3"),
}));

let mockBrowser = false;
vi.mock("../../lib/env", () => ({ isBrowser: () => mockBrowser }));

vi.mock("../../lib/invoke", () => ({
  call: vi.fn().mockResolvedValue(undefined),
  callSilent: vi.fn().mockResolvedValue(undefined),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
}));

const probe = vi.fn().mockResolvedValue(undefined);
const install = vi.fn().mockResolvedValue(undefined);

function setPhase(s: Partial<ReturnType<typeof useUpdateStatus.getState>>) {
  useUpdateStatus.setState({ phase: "idle", version: undefined, notes: null, probe, install, ...s });
}

describe("ProductUpdateCard (PLAN-2026-10-24 D2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowser = false;
    useSettingsStore.setState({ uiLang: "ko", updateCheckAuto: true } as never);
    setPhase({});
  });

  it("이름과 버전을 보여준다", async () => {
    render(<ProductUpdateCard />);
    const card = screen.getByTestId("settings-product-card");
    expect(card.textContent).toContain("Brise");
    await waitFor(() => expect(screen.getByTestId("settings-product-version").textContent).toBe("v0.5.3"));
  });

  it("available: 'v{버전}로 업데이트' 주 버튼, 누르면 install", () => {
    setPhase({ phase: "available", version: "0.6.0" });
    render(<ProductUpdateCard />);
    const btn = screen.getByTestId("settings-update-install");
    expect(btn.textContent).toBe("v0.6.0로 업데이트");
    expect(btn.className).toContain("btn-primary");
    fireEvent.click(btn);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("available + notes: 변경 요약을 줄바꿈만 살린 평문으로 보여준다 (HTML 해석 없음)", () => {
    setPhase({ phase: "available", version: "0.6.0", notes: "첫 줄\n<b>둘째</b>" });
    render(<ProductUpdateCard />);
    const notes = screen.getByTestId("settings-update-notes");
    expect(notes.textContent).toBe("첫 줄\n<b>둘째</b>");
    expect(notes.querySelector("b")).toBeNull();
    expect(notes.style.whiteSpace).toBe("pre-line");
  });

  it("available 이어도 notes 가 없으면 요약 영역이 없다", () => {
    setPhase({ phase: "available", version: "0.6.0", notes: null });
    render(<ProductUpdateCard />);
    expect(screen.queryByTestId("settings-update-notes")).toBeNull();
  });

  it("checking: 비활성 '확인 중…' 버튼", () => {
    setPhase({ phase: "checking" });
    render(<ProductUpdateCard />);
    const btn = screen.getByTestId("settings-update-check") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe("확인 중…");
    expect(screen.queryByTestId("settings-update-install")).toBeNull();
  });

  it("latest: 최신 문구 + 업데이트 확인 버튼(다시 probe)", () => {
    setPhase({ phase: "latest" });
    render(<ProductUpdateCard />);
    expect(screen.getByTestId("settings-product-card").textContent).toContain("최신 버전입니다");
    fireEvent.click(screen.getByTestId("settings-update-check"));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("error: 실패 문구 + 다시 확인 버튼", () => {
    setPhase({ phase: "error" });
    render(<ProductUpdateCard />);
    expect(screen.getByTestId("settings-product-card").textContent).toContain("업데이트 확인에 실패했습니다");
    fireEvent.click(screen.getByTestId("settings-update-check"));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("installing: 설치 중 문구만, 버튼은 없다", () => {
    setPhase({ phase: "installing", version: "0.6.0" });
    render(<ProductUpdateCard />);
    expect(screen.getByTestId("settings-product-card").textContent).toContain("설치 중");
    expect(screen.queryByTestId("settings-update-install")).toBeNull();
    expect(screen.queryByTestId("settings-update-check")).toBeNull();
  });

  it("idle(자동 확인 전/꺼짐): 수동 확인 버튼", () => {
    render(<ProductUpdateCard />);
    fireEvent.click(screen.getByTestId("settings-update-check"));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("자동 확인은 스위치다 — 켜짐을 aria-checked 가 말하고, 누르면 설정이 바뀐다", () => {
    const setUpdateCheckAuto = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState({ updateCheckAuto: true, setUpdateCheckAuto } as never);
    render(<ProductUpdateCard />);
    const toggle = screen.getByTestId("settings-update-auto-toggle");
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(setUpdateCheckAuto).toHaveBeenCalledWith(false);
  });

  it("브라우저(태블릿)에서는 업데이트 컨트롤·자동 확인 스위치가 없다", () => {
    mockBrowser = true;
    setPhase({ phase: "available", version: "0.6.0", notes: "메모" });
    render(<ProductUpdateCard />);
    expect(screen.getByTestId("settings-product-card").textContent).toContain("Brise");
    expect(screen.queryByTestId("settings-update-install")).toBeNull();
    expect(screen.queryByTestId("settings-update-check")).toBeNull();
    expect(screen.queryByTestId("settings-update-auto-toggle")).toBeNull();
    expect(screen.queryByTestId("settings-update-notes")).toBeNull();
  });
});
