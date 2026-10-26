import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PetSection } from "./PetSection";
import { useSettingsStore } from "../../stores/settings";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
}));

const listeners = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: (e: { payload: unknown }) => void) => {
    listeners.set(event, cb);
    return Promise.resolve(() => listeners.delete(event));
  },
}));

const openMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

// 위치 선택기(P7)의 미니맵 — 단일 1920x1080 모니터.
vi.mock("@tauri-apps/api/window", () => ({
  availableMonitors: async () => [
    { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 },
  ],
  getCurrentWindow: () => ({ label: "main" }),
}));

let settings: Record<string, unknown> = {};
function mockBackend(s: Record<string, unknown>, packages: Array<Record<string, unknown>> = []) {
  settings = s;
  callMock.mockReset().mockImplementation((cmd: string) => {
    if (cmd === "settings_get_all") return Promise.resolve({ settings });
    if (cmd === "pet_assets_list") return Promise.resolve({ items: [] });
    if (cmd === "pet_packages_list") return Promise.resolve({ items: packages });
    if (cmd === "pet_package_asset") return Promise.resolve({ data_url: "data:image/png;base64,AAA" });
    if (cmd === "pet_position_reset") return Promise.resolve({ x: 1744, y: 884 });
    return Promise.resolve({ ok: true });
  });
}

const pkg = (id: string, selected: boolean) => ({
  id,
  display_name: id.toUpperCase(),
  description: "",
  sprite_version_number: 2,
  rows: 11,
  selected,
  dialect: "codex-v2",
  has_preview: false,
  clips: [],
});

describe("PetSection — 설정 > 펫 (PET.md §0.6 재설계)", () => {
  beforeEach(() => {
    mockBackend({});
    openMock.mockReset();
    listeners.clear();
    useSettingsStore.setState({ aiEnabled: true, closeToTray: true, uiLang: "en" } as never);
  });

  it("꺼져 있으면 마스터 행 카드와 한 줄 안내만 — 빈 카드는 없다", async () => {
    mockBackend({ pet_enabled: "0" });
    const { container } = render(<PetSection />);
    expect(await screen.findByTestId("settings-pet-off-hint")).toBeTruthy();
    expect(screen.getByTestId("settings-pet-toggle").getAttribute("aria-checked")).toBe("false");
    expect([...container.querySelectorAll(".card")].map((c) => c.getAttribute("data-testid"))).toEqual(["settings-pet-master-card"]);
    expect(screen.queryByTestId("settings-pet-gallery")).toBeNull();
  });

  it("켜져 있으면 캐릭터 · 동작 · 화면 위치 세 그룹이 이 순서로, 무드별 파일 표는 없다", async () => {
    mockBackend({ pet_enabled: "1" });
    const { container } = render(<PetSection />);
    await screen.findByTestId("settings-pet-gallery");
    const cards = [...container.querySelectorAll(".card")].map((c) => c.getAttribute("data-testid"));
    expect(cards).toEqual(["settings-pet-master-card", "settings-pet-gallery", "settings-pet-reaction-section", "settings-pet-position"]);
    // 미리보기는 갤러리와 같은 카드
    expect(screen.getByTestId("settings-pet-preview-frame").closest(".card")).toBe(screen.getByTestId("settings-pet-gallery"));
    expect(screen.queryByTestId("settings-pet-asset-registry")).toBeNull();
    expect(screen.queryByTestId("settings-pet-off-hint")).toBeNull();
  });

  it("마스터 토글은 첫 카드 첫 줄에 있고 pet_set_enabled 를 부른다", async () => {
    mockBackend({ pet_enabled: "0" });
    render(<PetSection />);
    const master = await screen.findByTestId("settings-pet-master-card");
    expect(master.contains(screen.getByTestId("settings-pet-toggle"))).toBe(true);
    await userEvent.click(screen.getByTestId("settings-pet-toggle"));
    expect(callMock).toHaveBeenCalledWith("pet_set_enabled", { enabled: true });
  });

  it("트레이 상주가 꺼져 있으면 경고 + 버튼이 close_to_tray 를 켠다", async () => {
    useSettingsStore.setState({ closeToTray: false } as never);
    mockBackend({ pet_enabled: "1" });
    render(<PetSection />);
    await userEvent.click(await screen.findByTestId("settings-pet-needs-tray-enable"));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { close_to_tray: true } }),
    );
  });

  it("동작: 더블클릭 드롭다운 + 페르소나 링크는 AI > 채팅으로 이동", async () => {
    mockBackend({ pet_enabled: "1" });
    const onNavigate = vi.fn();
    render(<PetSection onNavigate={onNavigate} />);
    expect(await screen.findByTestId("settings-pet-dblclick-action")).toBeTruthy();
    await userEvent.click(screen.getByTestId("settings-pet-persona-link"));
    expect(onNavigate).toHaveBeenCalledWith("ai_chat");
  });

  it("갤러리: 썸네일을 누르면 pet_package_select, 기본 타일은 실제 기본 캐릭터(SVG)를 그린다", async () => {
    mockBackend({ pet_enabled: "1" }, [pkg("pkg-a", true), pkg("pkg-b", false)]);
    render(<PetSection />);
    const a = await screen.findByTestId("settings-pet-package-pkg-a");
    expect(a.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("settings-pet-package-default").querySelector("svg.pet")).not.toBeNull();
    await userEvent.click(screen.getByTestId("settings-pet-package-pkg-b"));
    expect(callMock).toHaveBeenCalledWith("pet_package_select", { id: "pkg-b" });
  });

  it("갤러리 삭제: 확인 다이얼로그를 승인해야 pet_package_remove 가 호출된다", async () => {
    mockBackend({ pet_enabled: "1" }, [pkg("pkg-a", true)]);
    render(<PetSection />);
    await userEvent.hover(await screen.findByTestId("settings-pet-package-pkg-a"));
    await userEvent.click(await screen.findByTestId("settings-pet-package-remove-pkg-a"));
    expect(callMock).not.toHaveBeenCalledWith("pet_package_remove", { id: "pkg-a" });
    const confirms = screen.getAllByRole("button", { name: "Delete package" });
    await userEvent.click(confirms[confirms.length - 1]);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_package_remove", { id: "pkg-a" }));
  });

  it("무드 세그먼트는 미리보기만 바꾸고 아무것도 저장하지 않는다", async () => {
    mockBackend({ pet_enabled: "1" });
    render(<PetSection />);
    await screen.findByTestId("settings-pet-preview-frame");
    const before = callMock.mock.calls.length;
    await userEvent.click(screen.getByRole("radio", { name: "Happy" }));
    expect(screen.getByRole("radio", { name: "Happy" }).getAttribute("aria-checked")).toBe("true");
    expect(callMock.mock.calls.slice(before).some(([c]) => c === "settings_set" || c === "pet_asset_set")).toBe(false);
  });

  it("화면 위치: 저장된 자유 위치를 표시하고, 창 포커스가 돌아오면 다시 읽는다", async () => {
    mockBackend({ pet_enabled: "1", pet_pos_x: 500, pet_pos_y: 300 });
    render(<PetSection />);
    const marker = await screen.findByTestId("settings-pet-position-current");
    const left1 = parseFloat(marker.style.left);

    settings = { pet_enabled: "1", pet_pos_x: 1000, pet_pos_y: 300 };
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect(parseFloat(screen.getByTestId("settings-pet-position-current").style.left)).toBeGreaterThan(left1),
    );
  });

  it("화면 위치: 저장값이 없으면 기본 위치(주 모니터 우하단)를 그린다", async () => {
    mockBackend({ pet_enabled: "1" });
    render(<PetSection />);
    const marker = await screen.findByTestId("settings-pet-position-current");
    // 미니맵 안쪽은 퍼센트 좌표다(좁은 창에서 넘치지 않게) — 우하단 앵커 x=1744 / 모니터 폭 1920.
    expect(marker.style.left).toMatch(/%$/);
    expect(parseFloat(marker.style.left)).toBeCloseTo((1744 / 1920) * 100, 1);
    expect(screen.getByTestId("settings-pet-anchor-0-2-2").getAttribute("aria-pressed")).toBe("true");
  });

  it("화면 위치: 앵커는 pet_set_position, '기본 위치로'는 pet_position_reset", async () => {
    mockBackend({ pet_enabled: "1" });
    render(<PetSection />);
    await userEvent.click(await screen.findByTestId("settings-pet-anchor-0-2-2"));
    expect(callMock).toHaveBeenCalledWith("pet_set_position", { x: 1744, y: 884 });
    await userEvent.click(screen.getByRole("button", { name: "Default position" }));
    expect(callMock).toHaveBeenCalledWith("pet_position_reset", {});
  });
});
