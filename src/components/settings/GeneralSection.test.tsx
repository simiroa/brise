import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { GeneralSection } from "./GeneralSection";
import { useSettingsStore } from "../../stores/settings";
import { emitNotice } from "../../lib/invoke";

const callMock = vi.fn();
const callSilentMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

const mockReportFallback = vi.fn();
vi.mock("../../lib/diag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/diag")>()),
  reportFallback: (...args: unknown[]) => mockReportFallback(...args),
}));

const mockIsEnabled = vi.fn().mockResolvedValue(false);
const mockEnable = vi.fn().mockResolvedValue(undefined);
const mockDisable = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: () => mockIsEnabled(),
  enable: () => mockEnable(),
  disable: () => mockDisable(),
}));

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn().mockResolvedValue("0.5.3") }));

const mockRelaunch = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: () => mockRelaunch(),
}));

const mockEmit = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/event", () => ({
  emit: (...args: unknown[]) => mockEmit(...args),
}));

const mockOpenDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpenDialog(...args),
}));

vi.mock("@tauri-apps/api/path", () => ({
  pictureDir: async () => "C:/Users/me/Pictures",
  join: async (...parts: string[]) => parts.join("/"),
}));

// mock*-prefixed so the vi.mock factory (hoisted above this let) may reference it — same
// convention as stores/ai.test.ts's mockReloadActive etc.
let mockBrowser = false;
vi.mock("../../lib/env", () => ({
  isBrowser: () => mockBrowser,
}));

const STATS = {
  note_count: 12,
  attachment_count: 5,
  distinct_note_days: 7,
  db_size_bytes: 1024 * 1024,
  attachments_size_bytes: 2 * 1024 * 1024,
  image_size_bytes: 1024 * 1024,
  disk_free_bytes: 412 * 1024 * 1024 * 1024,
};

describe("GeneralSection", () => {
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowser = false;
    mockIsEnabled.mockResolvedValue(false);
    mockRelaunch.mockReset().mockResolvedValue(undefined);
    mockEmit.mockReset().mockResolvedValue(undefined);
    mockOpenDialog.mockReset();
    const impl = async (cmd: string) => {
      if (cmd === "db_stats") return STATS;
      if (cmd === "backup_auto_status") {
        return { last_backup_at: "2026-07-20T10:00:00Z", interval: "weekly", keep: 3, last_error: null };
      }
      if (cmd === "settings_get_all") return { settings: { capture_screenshot_enabled: "0" } };
      if (cmd === "data_location_get") {
        return {
          root: "C:/Users/me/AppData/Roaming/brise",
          attachments_dir: "C:/Users/me/AppData/Roaming/brise/attachments",
          backups_dir: "C:/Users/me/AppData/Roaming/brise/backups",
          is_default: true,
          split: false,
        };
      }
      return {};
    };
    callMock.mockImplementation(impl);
    callSilentMock.mockImplementation(impl);
    useSettingsStore.setState({
      userName: "",
      uiLang: "ko",
      weekStart: "sunday",
      onboardingCompleted: true,
      closeToTray: true,
      notificationsEnabled: false,
      reminderAllDayAt: "00:00",
      sourceOriginalPolicy: "ask",
    } as any);
  });

  // 화면 저장 폴더(오너 2026-10-16: 펫이 꺼져 있어도 캡처가 폴더에 남는다).
  describe("화면 저장 폴더", () => {
    const withCaptureOn = (dir?: string) => {
      const base = callSilentMock.getMockImplementation()!;
      const impl = async (cmd: string, args?: unknown) =>
        cmd === "settings_get_all"
          ? { settings: { capture_screenshot_enabled: "1", ...(dir ? { capture_screenshot_dir: dir } : {}) } }
          : base(cmd, args);
      callSilentMock.mockImplementation(impl);
    };

    it("캡처가 꺼져 있으면 폴더 행이 없다", async () => {
      render(<GeneralSection onClose={onClose} />);
      await act(async () => {});
      expect(screen.queryByTestId("settings-capture-dir")).toBeNull();
    });

    it("켜져 있고 지정이 없으면 기본 폴더(<사진>/Brise)를 보여 주고, 고른 폴더를 저장한다", async () => {
      withCaptureOn();
      mockOpenDialog.mockResolvedValue("D:/Shots");
      render(<GeneralSection onClose={onClose} />);
      await waitFor(() => expect(screen.getByText("기본 폴더 — C:/Users/me/Pictures/Brise")).toBeTruthy());
      fireEvent.click(screen.getByTestId("settings-capture-dir-change"));
      await waitFor(() =>
        expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { capture_screenshot_dir: "D:/Shots" } }),
      );
      expect(screen.getByText("D:/Shots")).toBeTruthy();
    });

    it("저장이 실패하면 이전 값으로 되돌린다", async () => {
      withCaptureOn("E:/Old");
      mockOpenDialog.mockResolvedValue("D:/Shots");
      const base = callMock.getMockImplementation()!;
      callMock.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === "settings_set") throw new Error("nope");
        return base(cmd, args);
      });
      render(<GeneralSection onClose={onClose} />);
      await waitFor(() => expect(screen.getByText("E:/Old")).toBeTruthy());
      fireEvent.click(screen.getByTestId("settings-capture-dir-change"));
      await waitFor(() => expect(callMock).toHaveBeenCalledWith("settings_set", expect.anything()));
      await waitFor(() => expect(screen.getByText("E:/Old")).toBeTruthy());
    });
  });

  // ── 앱 동작 카드 (PLAN-2026-09-12 §3, 오너 결정 D3·D7 — D12 는 지역 페이지 2단이다) ──
  // 오너 QA 2026-09-15 R5: 알림 스위치·종일 알림 시각·트레이 경고는 "알림 및 일정" 페이지
  // (NotificationsSection)로 갔다. 2026-09-15 2차 QA: AI 마스터까지 격자에 넣어 2×2 — 토글이
  // 행마다 다른 자리에 서지 않는다. 원본 처리·온보딩도 이 카드의 행이다(단일 컨트롤 카드 금지).
  it("앱 동작 카드: 언어 셀렉트 + 토글 셋(시작/트레이/캡처)이 2열 격자에 서고, 온보딩 행이 있다", () => {
    render(<GeneralSection onClose={onClose} />);

    expect(screen.getByTestId("settings-app-behavior")).toBeTruthy();
    expect(screen.getByLabelText("언어 (Language)")).toBeTruthy();
    expect(screen.getByTestId("switch-grid").style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
    expect(screen.getByTestId("switch-grid-toggle-autostart")).toBeTruthy();
    expect(screen.getByTestId("switch-grid-toggle-close-to-tray")).toBeTruthy();
    expect(screen.getByTestId("switch-grid-toggle-capture-screenshot")).toBeTruthy();
    // AI 마스터는 AI 제공자 페이지 첫 줄로 갔다(PLAN-2026-10-24 D7) — 일반에 다시 나타나면 두 벌이 된다.
    expect(screen.queryByTestId("switch-grid-toggle-ai-enabled")).toBeNull();
    expect(screen.queryByTestId("settings-ai-enabled-toggle")).toBeNull();
    expect(screen.queryByTestId("switch-grid-toggle-notifications")).toBeNull();
    const card = screen.getByTestId("settings-app-behavior");
    expect(card.contains(screen.getByTestId("settings-onboarding"))).toBe(true);
    expect(screen.queryByTestId("settings-switch-notifications")).toBeNull();
    expect(screen.queryByTestId("settings-notifications-all-day-at")).toBeNull();
  });

  // PLAN-2026-09-01 W0 — 일반 탭이 "그 밖의 전부" 서랍이 되어 있었다. 이사한 것들이 여기 다시
  // 나타나면 서랍으로 되돌아간 것이므로 부재를 명시적으로 못박는다.
  // 2026-09-20: 날짜 자동등록·지역 제안 엄격도·원본 처리 세 행이 "에디터" 페이지로 이사한
  // 것도 여기 같이 못박는다(EditorSection.test.tsx 가 그쪽에 있다는 것도 증명).
  it("이사한 항목들(사용자 이름·주 시작일·지역/날씨·버전·라이선스·날짜 자동등록·지역 제안·원본 처리)은 더는 일반 탭에 없다", () => {
    render(<GeneralSection onClose={onClose} />);

    expect(screen.queryByPlaceholderText("이름 입력 (선택)")).toBeNull();
    expect(screen.queryByLabelText("주 시작일")).toBeNull();
    // 버전·업데이트는 레일이 아니라 일반 페이지 맨 위 제품 카드에 산다(PLAN-2026-10-24 D2).
    expect(screen.queryByTestId("settings-open-licenses-btn")).toBeNull();
    expect(screen.queryByTestId("settings-date-nudge-auto")).toBeNull();
    expect(screen.queryByTestId("settings-region-nudge-strict")).toBeNull();
    expect(screen.queryByTestId("settings-original-policy")).toBeNull();
  });

  it("제품·업데이트 카드가 페이지 맨 위에 선다", () => {
    const { container } = render(<GeneralSection onClose={onClose} />);
    const card = screen.getByTestId("settings-product-card");
    expect(container.firstElementChild).toBe(card);
    expect(card.textContent).toContain("Brise");
  });

  it("toggles autostart via plugin", async () => {
    render(<GeneralSection onClose={onClose} />);
    const toggle = screen.getByTestId("switch-grid-toggle-autostart");
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(mockEnable).toHaveBeenCalled();
    });
  });

  it("자동 실행을 못 바꾸면 알림으로 보이고 진단에 남기며, 토글은 OS 의 실제 상태로 돌아간다", async () => {
    mockEnable.mockRejectedValueOnce(new Error("registry denied"));
    render(<GeneralSection onClose={onClose} />);
    const toggle = screen.getByTestId("switch-grid-toggle-autostart");
    fireEvent.click(toggle);
    await waitFor(() => expect(emitNotice).toHaveBeenCalledWith("자동 실행 설정을 바꾸지 못했습니다."));
    expect(mockReportFallback).toHaveBeenCalledWith("autostart", "enable_failed", expect.stringContaining("registry denied"));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  });

  it("자동 실행 상태 조회가 실패하면 진단에 남기고 꺼짐으로 둔다", async () => {
    mockIsEnabled.mockRejectedValueOnce(new Error("plugin missing"));
    render(<GeneralSection onClose={onClose} />);
    await waitFor(() =>
      expect(mockReportFallback).toHaveBeenCalledWith("autostart", "is_enabled_failed", expect.stringContaining("plugin missing")),
    );
    expect(screen.getByTestId("switch-grid-toggle-autostart").getAttribute("aria-checked")).toBe("false");
  });

  it("화면 저장 토글은 call() 로 저장하고, 실패하면 이전 값으로 되돌린다", async () => {
    const base = callMock.getMockImplementation()!;
    callMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "settings_set") throw new Error("nope");
      return base(cmd, args);
    });
    render(<GeneralSection onClose={onClose} />);
    const toggle = screen.getByTestId("switch-grid-toggle-capture-screenshot");
    await act(async () => {});
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { capture_screenshot_enabled: "1" } }),
    );
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(callSilentMock).not.toHaveBeenCalledWith("settings_set", expect.anything());
  });

  it("앱 동작 격자는 자체 구분선을 긋지 않는다(선은 영역 경계에만)", () => {
    render(<GeneralSection onClose={onClose} />);
    const grid = screen.getByTestId("switch-grid");
    const parent = grid.parentElement as HTMLElement;
    expect(parent.getAttribute("data-testid")).toBe("settings-app-behavior");
  });

  it("toggles close_to_tray setting", () => {
    render(<GeneralSection onClose={onClose} />);
    const toggle = screen.getByTestId("switch-grid-toggle-close-to-tray");
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    act(() => {
      fireEvent.click(toggle);
    });
    expect(useSettingsStore.getState().closeToTray).toBe(false);
  });

  // 2026-09-20: region_nudge_strict 토글은 date_nudge_auto 와 함께 "에디터" 페이지로 옮겼다 —
  // 이 행의 클릭 동작 테스트는 EditorSection.test.tsx 로 이사했다(covered_by 문자열은 그쪽 참고).

  // W5: 브라우저 탭엔 트레이도, 이 토글이 가로채는 창 닫기 자체도 없다 — 죽은 컨트롤은 통째로
  // 가린다(비활성 표시가 아니라). R5 로 알림 스위치까지 다른 페이지로 갔으니 격자 블록이 통째로 빠진다.
  it("브라우저 모드에서는 데스크톱 전용 스위치 셋이 격자째 빠지고 알림 행도 여기 없다", () => {
    mockBrowser = true;
    render(<GeneralSection onClose={onClose} />);

    expect(screen.queryByTestId("switch-grid")).toBeNull();
    expect(screen.queryByTestId("switch-grid-toggle-close-to-tray")).toBeNull();
    expect(screen.queryByTestId("settings-switch-notifications")).toBeNull();
    expect(screen.queryByTestId("settings-notifications-needs-tray")).toBeNull();
    expect(screen.queryByTestId("settings-ai-enabled-toggle")).toBeNull();
  });

  it("트레이 경고는 더는 일반 탭의 것이 아니다 (알림 및 일정 페이지로 이사)", () => {
    act(() => {
      useSettingsStore.setState({ notificationsEnabled: true, closeToTray: false });
    });
    render(<GeneralSection onClose={onClose} />);
    expect(screen.queryByTestId("settings-notifications-needs-tray")).toBeNull();
  });

  it("resets onboarding completed flag and closes on restart onboarding click", () => {
    render(<GeneralSection onClose={onClose} />);
    // 다른 카드들과 같은 머리를 단다 — 머리 없는 링크 한 줄은 페이지 맨 아래 잘린 조각처럼 읽혔다.
    expect(screen.getByTestId("settings-onboarding").textContent).toContain("Brise 시작하기");
    const btn = screen.getByRole("button", { name: "온보딩 다시 시작하기" });
    fireEvent.click(btn);
    expect(onClose).toHaveBeenCalled();
    expect(useSettingsStore.getState().onboardingCompleted).toBe(false);
  });

  // ── M3 디자인 시스템 공통 컴포넌트 통합 검증 ────────────────────────────────
  it("새로운 디자인 시스템 컴포넌트(SwitchGrid, MetricTileGroup)를 렌더링한다", async () => {
    render(<GeneralSection onClose={onClose} />);

    // 2. SwitchGrid (데스크톱 모드 2열 그리드)
    const toggleGrid = screen.getByTestId("switch-grid");
    expect(toggleGrid).toBeTruthy();
    expect(screen.getByTestId("switch-grid-toggle-autostart")).toBeTruthy();
    expect(screen.getByTestId("switch-grid-toggle-close-to-tray")).toBeTruthy();
    expect(screen.getByTestId("switch-grid-toggle-capture-screenshot")).toBeTruthy();
    expect(screen.getByText("시작 시 자동 실행")).toBeTruthy();
    expect(screen.getByText("닫기 버튼은 트레이로 보관")).toBeTruthy();
    expect(screen.getByText("트레이 메뉴에 화면 저장 추가")).toBeTruthy();

    // 3. MetricTileGroup (3열 저장소 통계 타일 — 페이지 위, 카드 밖)
    const metricGroup = screen.getByTestId("settings-storage-stats");
    expect(metricGroup).toBeTruthy();
    expect(await screen.findByText("7")).toBeTruthy();
    expect(await screen.findByText("12")).toBeTruthy();
    expect(await screen.findByText("5")).toBeTruthy();
    expect(screen.getByText("사용일")).toBeTruthy();
    expect(screen.getByText("노트")).toBeTruthy();
    expect(screen.getByText("첨부파일")).toBeTruthy();
    expect(screen.getByTestId("metric-tile-days")).toBeTruthy();
    expect(screen.getByTestId("metric-tile-notes")).toBeTruthy();
    expect(screen.getByTestId("metric-tile-attachments")).toBeTruthy();

    // 저장 공간 게이지와 저장 및 백업 카드는 데이터 관리로 갔다(PLAN-2026-10-24 D6).
    expect(screen.queryByTestId("storage-gauge")).toBeNull();
    expect(screen.queryByTestId("settings-storage-backup")).toBeNull();
  });
});
