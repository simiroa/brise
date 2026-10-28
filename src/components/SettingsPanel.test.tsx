import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { t } from "../i18n/t";
import { useSettingsStore } from "../stores/settings";
import { SettingsPanel } from "./SettingsPanel";
import { useUpdateStatus } from "./settings/updateStatus";

// 설정 창이 열릴 때의 무음 업데이트 확인 — 상태 스토어가 쓰는 probe 를 목으로 갈아 끼운다(실제 네트워크 없음).
const mockProbe = vi.fn().mockResolvedValue({ status: "latest" });
vi.mock("../lib/updater", () => ({
  probeUpdate: () => mockProbe(),
  installUpdate: vi.fn().mockResolvedValue("error"),
}));

const mockGenerateRefactorPlan = vi.fn();
vi.mock("../stores/aiAgentActions", () => ({
  generateWorkspaceRefactorPlan: () => mockGenerateRefactorPlan(),
}));

// 딥링크의 "이미 열린 창" 경로 — Rust 가 보내는 settings-navigate 핸들러를 잡는다.
const navListeners: Record<string, (e: { payload: unknown }) => void> = {};
vi.mock("../lib/tauriListen", () => ({
  listenMany: (specs: ReadonlyArray<readonly [string, (e: { payload: unknown }) => void]>) => {
    for (const [event, h] of specs) navListeners[event] = h;
    return () => {};
  },
}));
vi.mock("../lib/invoke", () => ({
  call: vi.fn().mockResolvedValue({ settings: {} }),
  callSilent: vi.fn().mockResolvedValue({ settings: {} }),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));
vi.mock("./settings/GeneralSection", () => ({ GeneralSection: () => <div>mock-general</div> }));
vi.mock("./settings/EditorSection", () => ({ EditorSection: () => <div>mock-editor</div> }));
vi.mock("./settings/AppearanceSection", () => ({ AppearanceSection: () => <div>mock-appearance</div> }));
vi.mock("./settings/DashboardTabsSection", () => ({ DashboardTabsSection: () => <div>mock-dashboard-tabs</div> }));
vi.mock("./settings/ViewSection", () => ({ ViewSection: () => <div>mock-view</div> }));
vi.mock("./settings/NotificationsSection", () => ({ NotificationsSection: () => <div>mock-notifications</div> }));
vi.mock("./settings/AiChatSection", () => ({ AiChatSection: () => <div>mock-ai-chat</div> }));
vi.mock("./settings/LicenseSection", () => ({ LicenseSection: () => <div>mock-license</div> }));
vi.mock("./settings/AiProviderSection", () => ({ AiProviderSection: () => <div>mock-ai-provider</div> }));
vi.mock("./settings/AiPresetsSection", () => ({ AiPresetsSection: () => <div id="settings-anchor-ai_presets">mock-ai-presets</div> }));
vi.mock("./settings/PetPersonaSection", () => ({ PetPersonaSection: () => <div>mock-pet-persona</div> }));
vi.mock("./settings/AiPermissionsSection", () => ({ AiPermissionsSection: () => <div>mock-ai-permissions</div> }));
vi.mock("./settings/AiCapabilityCatalog", () => ({ AiCapabilityCatalog: () => <div>mock-ai-capability-catalog</div> }));
vi.mock("./settings/SyncSection", () => ({ SyncSection: () => <div>mock-sync</div> }));
vi.mock("./settings/CollectSection", () => ({ CollectSection: () => <div>mock-collect</div> }));
vi.mock("./settings/ExcludedDomainsSection", () => ({ ExcludedDomainsSection: () => <div>mock-excluded-domains</div> }));
// 수집 페이지의 나머지 세 섹션도 SettingsPanel 이 lazy 로 부른다. 목이 빠져 있어서 이 파일만
// 돌릴 때는 통과하고 전체 스위트에서는 실패했다 — 진짜 dynamic import 세 개가 얹히면서
// findByText 의 기본 1초를 넘겼다(페이지 구성만 보는 테스트라 실물이 필요 없다).
vi.mock("./settings/AttachmentStorageSection", () => ({ AttachmentStorageSection: () => <div>mock-attachment-storage</div> }));
vi.mock("./settings/BriefingSection", () => ({
  BriefingSection: () => <div id="settings-anchor-habits">mock-briefing</div>,
}));
const reportFallbackMock = vi.fn();
vi.mock("../lib/diag", () => ({ reportFallback: (...a: unknown[]) => reportFallbackMock(...a) }));
vi.mock("./settings/PetSection", () => ({ PetSection: () => <div>mock-pet</div> }));
vi.mock("./settings/DataManagementSection", () => ({ DataManagementSection: () => <div>mock-data-mgmt</div> }));
vi.mock("./settings/TestDataSection", () => ({ TestDataSection: () => <div>mock-test-data</div> }));

beforeEach(() => {
  // 업데이트 상태 스토어는 모듈 전역이다 — 테스트마다 확인 전(idle)에서 시작한다.
  useUpdateStatus.setState({ phase: "idle", version: undefined, notes: null });
});

describe("SettingsPanel — 페이지 전환 (W10)", () => {
  it("기본으로 일반(general) 페이지가 보이고 레일에서 항목을 고르면 그 페이지만 보인다", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    render(<SettingsPanel onClose={() => {}} />);

    expect(screen.getByText("mock-general")).toBeTruthy();
    expect(screen.queryByText("mock-appearance")).toBeNull();

    await userEvent.click(screen.getByTestId("settings-nav-appearance"));
    expect(await screen.findByText("mock-appearance")).toBeTruthy();
    expect(screen.queryByText("mock-general")).toBeNull();

    await userEvent.click(screen.getByTestId("settings-nav-ai"));
    expect(await screen.findByText("mock-ai-provider")).toBeTruthy();
    expect(screen.queryByText("mock-appearance")).toBeNull();
  });
});

describe("SettingsPanel — AI 페이지 2분할 (PLAN-2026-08-30 W1)", () => {
  // (a) "ai"·"ai_permissions"·"ai_features" 세 페이지가 각각 자기 섹션을 렌더한다.
  // PLAN-2026-09-12 §1(D8): 권한은 기능 페이지 맨 위에 얹혀 있던 것을 자기 페이지로 뗐다.
  it("AI 연결·권한·기능 페이지가 각자 자기 섹션만 렌더한다", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    useSettingsStore.setState({ aiEnabled: true } as any);
    render(<SettingsPanel onClose={() => {}} />);

    await userEvent.click(screen.getByTestId("settings-nav-ai"));
    expect(await screen.findByText("mock-ai-provider")).toBeTruthy();
    expect(screen.queryByText("mock-ai-permissions")).toBeNull();
    expect(screen.queryByTestId("ai-action-edit-open")).toBeNull();

    await userEvent.click(screen.getByTestId("settings-nav-ai_permissions"));
    expect(await screen.findByText("mock-ai-permissions")).toBeTruthy();
    expect(screen.queryByText("mock-ai-capability-catalog")).toBeNull();
    expect(screen.queryByText("mock-ai-provider")).toBeNull();

    await userEvent.click(screen.getByTestId("settings-nav-ai_features"));
    expect(await screen.findByText("mock-ai-capability-catalog")).toBeTruthy();
    expect(await screen.findByTestId("settings-ai-actions-card")).toBeTruthy();
    expect(screen.queryByText("mock-ai-permissions")).toBeNull();
  });

  // (b) 기존 "ai" 딥링크가 AI 연결 페이지(AiProviderSection)로 간다
  it("기존 ai 딥링크는 AI 연결 페이지로 간다", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    render(<SettingsPanel onClose={() => {}} />);

    await userEvent.click(screen.getByTestId("settings-nav-ai"));
    expect(await screen.findByText("mock-ai-provider")).toBeTruthy();
    expect(screen.queryByText("mock-ai-permissions")).toBeNull();
  });

  it("AI 프리셋은 별도 페이지가 아니라 AI 기능 페이지 맨 아래에 있고, AI 가 꺼져 있어도 보인다", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    useSettingsStore.setState({ aiEnabled: false } as any);
    render(<SettingsPanel onClose={() => {}} />);

    expect(screen.queryByTestId("settings-nav-ai_presets")).toBeNull();
    await userEvent.click(screen.getByTestId("settings-nav-ai_features"));
    const catalog = await screen.findByText("mock-ai-capability-catalog");
    const presets = await screen.findByText("mock-ai-presets");
    expect(catalog.compareDocumentPosition(presets) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("이미 열린 창에 온 settings-navigate 이벤트가 그 페이지로 옮긴다", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    expect(screen.getByText("mock-general")).toBeTruthy();
    await act(async () => {
      navListeners["settings-navigate"]({ payload: "ai_presets" }); // 옛 id → AI 기능 페이지로 보낸다
    });
    expect(await screen.findByText("mock-ai-capability-catalog")).toBeTruthy();
    expect(await screen.findByText("mock-ai-presets")).toBeTruthy();
  });

  it("옛 ai_presets 딥링크는 AI 기능 페이지의 프리셋 카드 앵커까지 간다 — 앵커를 따로 준 호출은 그 앵커가 우선", async () => {
    reportFallbackMock.mockClear();
    render(<SettingsPanel onClose={() => {}} />);
    await act(async () => {
      navListeners["settings-navigate"]({ payload: "ai_presets" });
    });
    expect(await screen.findByText("mock-ai-presets")).toBeTruthy();
    // 앵커를 소비했다 = 프리셋 카드가 강조된다(맨 위에 떨어지지 않는다).
    await vi.waitFor(() =>
      expect(document.getElementById("settings-anchor-ai_presets")!.classList.contains("settings-anchor-flash")).toBe(true),
    );
    // 명시한 앵커가 있으면 별칭의 기본 앵커를 쓰지 않는다(없는 앵커라 진단만 남는다).
    act(() => navListeners["settings-navigate"]({ payload: { page: "ai_presets", anchor: "nope" } }));
    await vi.waitFor(() => expect(reportFallbackMock).toHaveBeenCalledWith("settings", "anchor_not_found", "nope"), { timeout: 2000 });
    expect(reportFallbackMock).not.toHaveBeenCalledWith("settings", "anchor_not_found", "ai_presets");
  });

  it("URL 쿼리 ?page=ai_presets 로 새 창이 열려도 프리셋 카드 앵커를 소비한다", async () => {
    const orig = window.location.href;
    window.history.replaceState(null, "", "/index.html?page=ai_presets#/settings");
    try {
      render(<SettingsPanel onClose={() => {}} />);
      expect(await screen.findByText("mock-ai-presets")).toBeTruthy();
      await vi.waitFor(() =>
        expect(document.getElementById("settings-anchor-ai_presets")!.classList.contains("settings-anchor-flash")).toBe(true),
      );
    } finally {
      window.history.replaceState(null, "", orig);
    }
  });

  // 딥링크(settings_window_open 의 page 인자) — 새 창은 URL 쿼리(`?page=`)로 첫 페이지를 받는다.
  it("URL 쿼리 ?page= 가 첫 페이지를 정하고, 모르는 id 는 첫 페이지로 떨어진다", async () => {
    const orig = window.location.href;
    window.history.replaceState(null, "", "/index.html?page=ai_presets#/settings");
    try {
      const { unmount } = render(<SettingsPanel onClose={() => {}} />);
      expect(await screen.findByText("mock-ai-capability-catalog")).toBeTruthy();
      unmount();
      window.history.replaceState(null, "", "/index.html?page=nope#/settings");
      render(<SettingsPanel onClose={() => {}} />);
      expect(await screen.findByText("mock-general")).toBeTruthy();
    } finally {
      window.history.replaceState(null, "", orig);
    }
  });
});

describe("SettingsPanel — 플러그인 페이지 (W13, P0, P1)", () => {
  it("펫 페이지를 누르면 펫 섹션이 렌더된다", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    render(<SettingsPanel onClose={() => {}} />);

    await userEvent.click(screen.getByTestId("settings-nav-pet"));
    expect(await screen.findByText("mock-pet")).toBeTruthy();
  });

  // P0 플러그인 프레임: 플러그인은 기능 페이지가 아니라 레일 맨 아래 "플러그인" 그룹으로 산다.
  it("플러그인 항목(펫)은 레일 맨 뒤 플러그인 그룹에 선다", () => {
    render(<SettingsPanel onClose={() => {}} />);

    const nav = screen.getByTestId("settings-nav");
    const rendered = Array.from(nav.children).map((el) => el.getAttribute("data-testid"));
    // 맨 끝은 버전·업데이트 상주 블록(PLAN-2026-09-01 W0) — 항목 목록은 그 앞까지다.
    expect(rendered[rendered.length - 1]).toBe("settings-nav-footer");
    expect(rendered[rendered.length - 4]).toBe("settings-nav-group-plugins");
    expect(rendered[rendered.length - 3]).toBe("settings-nav-pet");
  });
});

// PLAN-2026-09-12 §1(D1): 레일은 5그룹이고 **고아 항목이 없다**. 그룹 헤더는 그룹의 첫 항목
// 앞에만 서므로, 헤더 개수 = 그룹 개수이고 순서는 배열 순서가 곧 화면 순서다.
describe("SettingsPanel — 레일 5그룹 IA (PLAN-2026-09-12 §1)", () => {
  it("레일이 일반·기능·AI·시스템·플러그인 순으로 갈리고 고아 항목이 없다", () => {
    render(<SettingsPanel onClose={() => {}} />);

    const nav = screen.getByTestId("settings-nav");
    const rendered = Array.from(nav.children).map((el) => el.getAttribute("data-testid"));

    expect(rendered).toEqual([
      "settings-nav-group-general",
      "settings-nav-general",
      "settings-nav-editor",
      "settings-nav-attachments",
      "settings-nav-notifications",
      "settings-nav-appearance",
      "settings-nav-view",
      "settings-nav-dashboard",
      "settings-nav-group-feature",
      "settings-nav-collect",
      "settings-nav-connect",
      "settings-nav-group-ai",
      "settings-nav-ai",
      "settings-nav-ai_permissions",
      "settings-nav-ai_features",
      "settings-nav-ai_chat",
      "settings-nav-group-system",
      "settings-nav-data",
      "settings-nav-license",
      "settings-nav-group-plugins",
      "settings-nav-pet",
      "settings-nav-briefing",
      "settings-nav-footer",
    ]);
  });

  it("그룹 헤더는 그룹당 정확히 하나씩, 5개만 선다", () => {
    render(<SettingsPanel onClose={() => {}} />);

    const nav = screen.getByTestId("settings-nav");
    const groups = Array.from(nav.children)
      .map((el) => el.getAttribute("data-testid"))
      .filter((id) => id?.startsWith("settings-nav-group-"));
    expect(groups).toHaveLength(5);
    expect(new Set(groups).size).toBe(5);
  });

  // 라벨은 그룹 헤더가 말하는 맥락만큼 줄어든다(D10 포함) — id 는 그대로다.
  it("AI 그룹 항목 라벨에서 'AI' 접두가 빠지고 보기 페이지가 '지역'이 된다", () => {
    render(<SettingsPanel onClose={() => {}} />);

    expect(screen.getByTestId("settings-nav-ai").textContent).toBe(t("settings.page_ai"));
    expect(screen.getByTestId("settings-nav-ai_permissions").textContent).toBe(t("settings.page_ai_permissions"));
    expect(screen.getByTestId("settings-nav-view").textContent).toBe(t("settings.page_view"));
    expect(screen.getByTestId("settings-nav-group-ai").textContent).toBe(t("settings.group_ai"));
  });
});

// 오너 QA 2026-09-15 R3·R5.
describe("SettingsPanel — 알림 및 일정 페이지 · 본문 블록 간격 (QA 2026-09-15)", () => {
  // 2026-09-20: "에디터" 페이지가 일반 바로 뒤에 새로 끼어들면서, 알림 및 일정은 이제 일반의
  // 바로 다음이 아니라 에디터 다음이다 — R5 가 정한 "일반 바로 뒤"는 이제 에디터가 차지한다.
  it("R5: 알림 및 일정 페이지가 일반·에디터 바로 뒤에 서고, 누르면 그 섹션만 렌더한다 (데스크톱 17페이지)", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    render(<SettingsPanel onClose={() => {}} />);

    const nav = screen.getByTestId("settings-nav");
    const pages = Array.from(nav.children)
      .map((el) => el.getAttribute("data-testid") ?? "")
      .filter((id) => id.startsWith("settings-nav-") && !id.startsWith("settings-nav-group-") && id !== "settings-nav-footer");
    expect(pages).toHaveLength(17);
    expect(pages.indexOf("settings-nav-editor")).toBe(pages.indexOf("settings-nav-general") + 1);
    expect(pages.indexOf("settings-nav-attachments")).toBe(pages.indexOf("settings-nav-editor") + 1); // 2026-10-27 신설
    expect(pages.indexOf("settings-nav-notifications")).toBe(pages.indexOf("settings-nav-attachments") + 1);
    expect(screen.getByTestId("settings-nav-notifications").textContent).toBe(t("settings.page_notifications"));

    await userEvent.click(screen.getByTestId("settings-nav-notifications"));
    expect(await screen.findByText("mock-notifications")).toBeTruthy();
    expect(screen.queryByText("mock-general")).toBeNull();
  });

  it("R3: 본문 래퍼가 세로 flex + gap 으로 블록 사이를 띄운다 (카드는 자기 margin 이 없다)", () => {
    render(<SettingsPanel onClose={() => {}} />);
    const body = screen.getByTestId("settings-page-body");
    expect(body.style.display).toBe("flex");
    expect(body.style.flexDirection).toBe("column");
    expect(body.style.gap).toBe("var(--space-7)");
  });

  it("R1-D(GRILL-2026-10-19): 본문 캔버스는 프레임을 지우지 않고, 헤더는 스크롤 밖 맨 시트 위에 있다 (PLAN-2026-10-24 D1)", () => {
    render(<SettingsPanel onClose={() => {}} />);
    const content = screen.getByTestId("settings-content");
    expect(content.classList.contains("content-canvas")).toBe(true);
    // 클래스의 외곽선·라운드·인셋을 인라인으로 지우지 않는다(메인 본문과 같은 관계).
    expect(content.style.border).toBe("");
    expect(content.style.borderRadius).toBe("");
    expect(content.style.margin).toBe("");
    const header = screen.getByTestId("settings-header");
    const close = screen.getByTestId("settings-window-close");
    expect(content.contains(close)).toBe(false);
    expect(header.contains(close)).toBe(true);
    expect(header.style.height).toBe("var(--row-chrome)");
    // 2026-10-27: 창은 하나의 그리드다 — 헤더(1행 2열)·범위 칸(1행 1열)·내비(2행 1열)·본문(2행 2열)이 같은 트랙을 공유한다.
    const panel = screen.getByTestId("settings-panel");
    expect(panel.style.display).toBe("grid");
    expect(header.contains(screen.getByTestId("settings-nav"))).toBe(false);
    expect(header.parentElement).toBe(panel);
    expect(screen.getByTestId("settings-nav").parentElement).toBe(panel);
    // 검색 줄 안쪽 열과 페이지 본문이 같은 열 클래스(.settings-column)를 쓴다 — 좌우 기하의 단일 출처.
    // (2026-10-27 C1: 검색창은 본문 열 안쪽 여백이 아니라 구분선에 붙는다 — 헤더는 .settings-column 이 아니라 .settings-search-box.)
    expect(header.querySelector(".settings-search-box")).not.toBeNull();
    expect(screen.getByTestId("settings-page-body").classList.contains("settings-column")).toBe(true);
  });
});

// PLAN-2026-10-24 D5 — 헤더 범위 칩은 allPages[].scope 한 곳에서 정한다.
describe("SettingsPanel — 헤더 범위 칩 (PLAN-2026-10-24 D5)", () => {
  it("노트북별 페이지는 노트북 이름, 앱 전체 페이지는 '앱 전체' 로 바뀐다", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    const invoke = await import("../lib/invoke");
    vi.mocked(invoke.callSilent).mockImplementation((async (cmd: string) =>
      cmd === "workspace_list"
        ? { workspaces: [{ id: "ws-1", name: "역사 노트" }], active_id: "ws-1" }
        : { settings: {} }) as never);
    render(<SettingsPanel onClose={() => {}} />);

    expect((await screen.findByTestId("settings-scope-chip")).textContent).toBe("역사 노트");

    for (const id of ["collect", "connect", "license", "pet"]) {
      await userEvent.click(screen.getByTestId(`settings-nav-${id}`));
      await waitFor(() => expect(screen.getByTestId("settings-scope-chip").getAttribute("data-scope")).toBe("app"));
      expect(screen.getByTestId("settings-scope-chip").textContent).toBe(t("workspace.scope_app_label"));
    }

    for (const id of ["appearance", "ai", "data", "briefing"]) {
      await userEvent.click(screen.getByTestId(`settings-nav-${id}`));
      await waitFor(() => expect(screen.getByTestId("settings-scope-chip").getAttribute("data-scope")).toBe("notebook"));
      expect(screen.getByTestId("settings-scope-chip").textContent).toBe("역사 노트");
    }
    vi.mocked(invoke.callSilent).mockResolvedValue({ settings: {} } as never);
  });

  it("헤더에는 검색 입력이 있고, 레일 맨 위에는 제목·노트북 이름 블록이 없다", () => {
    render(<SettingsPanel onClose={() => {}} />);
    expect(screen.getByTestId("settings-search-input")).toBeTruthy();
    expect(screen.queryByTestId("settings-nav-header")).toBeNull();
  });
});

describe("SettingsPanel — 업데이트 점 (PLAN-2026-10-24 D2)", () => {
  it("업데이트가 있으면 일반 레일 항목에만 점이 붙는다", () => {
    act(() => useUpdateStatus.setState({ phase: "available", version: "9.9.9" }));
    render(<SettingsPanel onClose={() => {}} />);
    const dot = screen.getByTestId("settings-nav-dot-general");
    expect(dot.getAttribute("aria-label")).toBe(t("settings.nav_update_available"));
    expect(screen.queryByTestId("settings-nav-dot-editor")).toBeNull();
    act(() => useUpdateStatus.setState({ phase: "latest" }));
    expect(screen.queryByTestId("settings-nav-dot-general")).toBeNull();
  });

  it("창이 열릴 때 자동 확인이 켜져 있으면 무음 확인을 한 번 건다", async () => {
    mockProbe.mockClear();
    useSettingsStore.setState({ updateCheckAuto: true } as never);
    render(<SettingsPanel onClose={() => {}} />);
    await waitFor(() => expect(mockProbe).toHaveBeenCalledTimes(1));
  });

  it("자동 확인이 꺼져 있으면 걸지 않는다", () => {
    mockProbe.mockClear();
    useSettingsStore.setState({ updateCheckAuto: false } as never);
    render(<SettingsPanel onClose={() => {}} />);
    expect(mockProbe).not.toHaveBeenCalled();
  });
});

describe("SettingsPanel — 대시보드 페이지 (PLAN-2026-09-01 W0)", () => {
  it("대시보드 페이지는 상단 탭 구성·미리보기만 렌더한다 (문구 팩은 브리핑으로, 사이드바 구성은 보기 탭, 태그 관리는 폐지)", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    render(<SettingsPanel onClose={() => {}} />);

    await userEvent.click(screen.getByTestId("settings-nav-dashboard"));
    // 미리보기는 DashboardTabsSection 안 SubGroup 이다(PLAN-2026-09-15 §4) — 여기선 목 하나로 보인다.
    expect(await screen.findByText("mock-dashboard-tabs")).toBeTruthy();
    // GRILL-2026-10-19 R4: 문구 팩 카드는 문구와 함께 설정 › 브리핑으로 이사했다(BriefingSection 이 마운트 —
    // BriefingSettings.test.tsx 가 순서를 지킨다). 대시보드 페이지엔 다시 생기지 않는다.
    expect(screen.queryByTestId("settings-phrase-packs")).toBeNull();
    expect(screen.queryByText("mock-briefing")).toBeNull();
    expect(screen.queryByText("mock-view")).toBeNull();
  });
});

describe("SettingsPanel — 신설 페이지 (PLAN-2026-09-01 W0)", () => {
  it("보기·AI 채팅·라이선스 페이지가 각각 자기 섹션만 렌더한다", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    render(<SettingsPanel onClose={() => {}} />);

    await userEvent.click(screen.getByTestId("settings-nav-view"));
    expect(await screen.findByText("mock-view")).toBeTruthy();

    await userEvent.click(screen.getByTestId("settings-nav-ai_chat"));
    expect(await screen.findByText("mock-ai-chat")).toBeTruthy();
    expect(screen.queryByText("mock-view")).toBeNull();

    await userEvent.click(screen.getByTestId("settings-nav-license"));
    expect(await screen.findByText("mock-license")).toBeTruthy();
  });

  it("버전·업데이트는 페이지가 아니라 레일 하단에 상주한다", () => {
    render(<SettingsPanel onClose={() => {}} />);
    expect(screen.getByTestId("settings-nav-footer")).toBeTruthy();
  });
});

describe("SettingsPanel — 연결 페이지 (PLAN-2026-09-01 W0·W6)", () => {
  // 2026-09-09 크롬 익스텐션 철수 — 연결 페이지에서 "브라우저 수집" 카드가 빠졌다.
  // 수집 제외 도메인은 수집 페이지(CollectSection)가 싣는다 — 연결 페이지는 동기화만.
  it("연결 페이지는 동기화 섹션만 렌더한다", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    render(<SettingsPanel onClose={() => {}} />);

    await userEvent.click(screen.getByTestId("settings-nav-connect"));
    expect(await screen.findByText("mock-sync")).toBeTruthy();
    expect(screen.queryByText("mock-excluded-domains")).toBeNull();
  });
});

describe("SettingsPanel — 수집 페이지 (PLAN-2026-09-01 W0)", () => {
  it("수집 페이지는 CollectSection 하나가 그린다(제외 도메인 카드는 그 안에 있다)", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    render(<SettingsPanel onClose={() => {}} />);

    await userEvent.click(screen.getByTestId("settings-nav-collect"));
    expect(await screen.findByText("mock-collect")).toBeTruthy();
    expect(screen.queryByText("mock-excluded-domains")).toBeNull();
  });
});

describe("SettingsPanel — 수집 레일 뱃지 (PLAN-2026-09-04-local-import §3b)", () => {
  it("collectDetectPending이 0보다 크면 수집 레일에 카운트 필이 붙고, 0이면 붙지 않는다", () => {
    useSettingsStore.setState({ collectDetectPending: 3 } as any);
    const { unmount } = render(<SettingsPanel onClose={() => {}} />);
    expect(screen.getByTestId("settings-nav-badge-collect").textContent).toBe("3");
    unmount();

    useSettingsStore.setState({ collectDetectPending: 0 } as any);
    render(<SettingsPanel onClose={() => {}} />);
    expect(screen.queryByTestId("settings-nav-badge-collect")).toBeNull();
    expect(screen.getByTestId("settings-nav-collect").textContent).toBe(t("settings.page_collect"));
  });
});

describe("SettingsPanel — AI 기능 카드 · 창 셸", () => {
  it("노트북 재편이 실패해도 미처리 rejection 없이 버튼이 돌아오고, 실패는 진단에 남는다", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    mockGenerateRefactorPlan.mockRejectedValueOnce(new Error("Refactor plan failure"));
    reportFallbackMock.mockClear();
    useSettingsStore.setState({ aiEnabled: true } as any);
    render(<SettingsPanel onClose={() => {}} />);

    await userEvent.click(screen.getByTestId("settings-nav-ai_features"));
    const refactorBtn = (await screen.findByText(t("ai.workspace_restructure"))) as HTMLButtonElement;
    await userEvent.click(refactorBtn);

    await waitFor(() => expect(refactorBtn.disabled).toBe(false));
    expect(refactorBtn.textContent).toBe(t("ai.workspace_restructure"));
    expect(reportFallbackMock).toHaveBeenCalledWith("ai", "restructure_plan_failed", "Refactor plan failure");
  });

  it("재편 계획이 비어 오면 말없이 돌아오지 않고 알린다", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    const invoke = await import("../lib/invoke");
    vi.mocked(invoke.emitNotice).mockClear();
    mockGenerateRefactorPlan.mockResolvedValueOnce(null);
    useSettingsStore.setState({ aiEnabled: true } as any);
    render(<SettingsPanel onClose={() => {}} />);

    await userEvent.click(screen.getByTestId("settings-nav-ai_features"));
    await userEvent.click(await screen.findByText(t("ai.workspace_restructure")));
    await waitFor(() => expect(invoke.emitNotice).toHaveBeenCalledWith(t("settings.ai_restructure_empty")));
  });

  it("계획을 만드는 동안 버튼은 '저장 중' 이 아니라 계획 중이라고 말한다", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    let resolve: (v: null) => void = () => {};
    mockGenerateRefactorPlan.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    useSettingsStore.setState({ aiEnabled: true } as any);
    render(<SettingsPanel onClose={() => {}} />);

    await userEvent.click(screen.getByTestId("settings-nav-ai_features"));
    const btn = (await screen.findByText(t("ai.workspace_restructure"))) as HTMLButtonElement;
    await userEvent.click(btn);
    await waitFor(() => expect(btn.textContent).toBe(t("settings.ai_restructure_planning")));
    expect(btn.textContent).not.toBe(t("note.saving"));
    await act(async () => resolve(null));
  });

  it("AI 연결 값은 섹션이 스스로 읽는다 — 창 셸은 settings_get_all 을 부르지 않는다", async () => {
    const invoke = await import("../lib/invoke");
    vi.mocked(invoke.call).mockClear();
    vi.mocked(invoke.callSilent).mockClear();
    render(<SettingsPanel onClose={() => {}} />);
    window.dispatchEvent(new Event("focus"));
    expect(invoke.call).not.toHaveBeenCalledWith("settings_get_all");
    expect(invoke.callSilent).not.toHaveBeenCalledWith("settings_get_all");
  });

  it("데이터 작업이 도는 동안엔 닫기 X 가 막히고 이유를 말한다", async () => {
    const { useSettingsBusy } = await import("./settings/settingsBusy");
    const onClose = vi.fn();
    act(() => useSettingsBusy.setState({ busy: "restore" }));
    const { unmount } = render(<SettingsPanel onClose={onClose} />);
    const x = screen.getByTestId("settings-window-close") as HTMLButtonElement;
    expect(x.disabled).toBe(true);
    expect(x.getAttribute("title")).toBe(t("settings.close_blocked_busy"));
    x.click();
    expect(onClose).not.toHaveBeenCalled();

    act(() => useSettingsBusy.setState({ busy: null }));
    const x2 = screen.getByTestId("settings-window-close") as HTMLButtonElement;
    expect(x2.disabled).toBe(false);
    x2.click();
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("본문 스크롤 칸은 스크롤바 자리를 늘 비워 둔다(페이지 간 폭 튐 방지)", () => {
    render(<SettingsPanel onClose={() => {}} />);
    expect((screen.getByTestId("settings-content") as HTMLElement).style.scrollbarGutter).toBe("stable");
  });
});

// W5 (WORKORDER-2026-09-02 §4): 태블릿(브라우저)은 이 패널을 그대로 띄우되, 원격에서 성립하지
// 않는 페이지는 렌더도 하지 않는다. isBrowser()(lib/env.ts) 는 이 파일에서 모킹하지 않는다 —
// 실제 세션 토큰 계약대로 sessionStorage 만 채우면 된다(AppearanceSection.test.tsx 와 같은 방식).
describe("SettingsPanel — 브라우저(태블릿) 페이지 필터 (W5)", () => {
  afterEach(() => {
    sessionStorage.removeItem("brise_sync_token");
  });

  // 제목 문구는 specs/features/mobile.yaml 의 covered_by 리터럴과 **한 문자열로 묶여 있다**
  // (check:features) — 한쪽만 고치면 그 링크가 끊어지니 반드시 둘을 동시에 고친다.
  // W3 개명(2026-09-12): 라벨이 "보기"→"지역"(D10)이고, 남는 것은 페이지 **와 그룹 헤더
  // 둘**(일반·시스템)이다 — 옛 제목의 "플러그인 그룹도 없다"가 그룹이 하나도 안 선다는 뜻으로
  // 읽혀서, 실제로 서는 두 헤더를 제목에 적었다.
  // 오너 QA 2026-09-15 R5: "알림 및 일정" 이 더해져 6페이지, 2026-09-20 "에디터" 가 더해져
  // 7페이지, 2026-10-27 "첨부파일" 이 더해져 8페이지다(다섯 키 전부 원격 허용 — remoteSettingsPolicy.ts 참고). 제목 문자열은
  // specs/features/mobile.yaml 의 covered_by 리터럴과 묶여 있다.
  it("브라우저 모드에서는 레일에 8페이지(일반·에디터·첨부파일·알림 및 일정·모양·지역·대시보드·라이선스)와 그룹 헤더 둘(일반·시스템)만 남는다", () => {
    sessionStorage.setItem("brise_sync_token", "t");
    render(<SettingsPanel onClose={() => {}} />);

    const nav = screen.getByTestId("settings-nav");
    const rendered = Array.from(nav.children).map((el) => el.getAttribute("data-testid"));
    expect(rendered).toEqual([
      "settings-nav-group-general",
      "settings-nav-general",
      "settings-nav-editor",
      "settings-nav-attachments",
      "settings-nav-notifications",
      "settings-nav-appearance",
      "settings-nav-view",
      "settings-nav-dashboard",
      "settings-nav-group-system",
      "settings-nav-license",
      "settings-nav-footer",
    ]);
  });

  it("걸러진 페이지를 보고 있던 중 브라우저 모드로 전환되면 첫 남은 페이지(general)로 폴백한다", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    const { rerender } = render(<SettingsPanel onClose={() => {}} />);

    // 데스크톱에서 걸러질 페이지(연결)로 미리 이동해 둔다.
    await userEvent.click(screen.getByTestId("settings-nav-connect"));
    expect(await screen.findByText("mock-sync")).toBeTruthy();

    // 같은 마운트가 브라우저 모드로 전환된다(예: 태블릿) — "connect" 는 이제 걸러진 id 다.
    // page state 는 그대로 "connect" 를 들고 있지만, pages 자체가 걸러지므로
    // activePage = pages.find(...) ?? pages[0] 가 자동으로 첫 페이지로 떨어진다.
    sessionStorage.setItem("brise_sync_token", "t");
    rerender(<SettingsPanel onClose={() => {}} />);

    expect(await screen.findByText("mock-general")).toBeTruthy();
    expect(screen.queryByText("mock-sync")).toBeNull();
    expect(screen.queryByTestId("settings-nav-connect")).toBeNull();
  });
});


describe("SettingsPanel — 앵커 딥링크", () => {
  it("settings-navigate {page, anchor} 로 페이지를 바꾸고 본문 컨테이너만 앵커 위치로 스크롤한다", async () => {
    // scrollIntoView 는 조상 전체(창 크롬 포함)를 밀어 올리므로 쓰지 않는다 — 호출되면 실패.
    const scrollIntoView = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView;
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.id === "settings-anchor-habits") return { top: 400 } as DOMRect;
      if (this.getAttribute("data-testid") === "settings-content") return { top: 100 } as DOMRect;
      return { top: 0 } as DOMRect;
    });
    render(<SettingsPanel onClose={() => {}} />);
    const box = screen.getByTestId("settings-content");
    act(() => navListeners["settings-navigate"]({ payload: { page: "briefing", anchor: "habits" } }));
    expect(await screen.findByText("mock-briefing")).toBeTruthy();
    await vi.waitFor(() => expect(box.scrollTop).toBe(300 - 16));
    expect(scrollIntoView).not.toHaveBeenCalled();
    rect.mockRestore();
  });
});

describe("SettingsPanel — 앵커 못 찾음", () => {
  it("요소가 끝내 없으면 reportFallback 만 남긴다", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    act(() => navListeners["settings-navigate"]({ payload: { page: "briefing", anchor: "nope" } }));
    await vi.waitFor(() => expect(reportFallbackMock).toHaveBeenCalledWith("settings", "anchor_not_found", "nope"), { timeout: 2000 });
  });
});

describe("SettingsPanel — 설정 검색 (PLAN-2026-10-24 W4)", () => {
  it("결과를 고르면 그 페이지로 옮기고 앵커 요소를 강조한다", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    useSettingsStore.setState({ uiLang: "ko" } as never);
    render(<SettingsPanel onClose={() => {}} />);
    expect(screen.getByText("mock-general")).toBeTruthy();

    await userEvent.type(screen.getByTestId("settings-search-input"), t("settings.briefing_habits_section"));
    await userEvent.click(await screen.findByTestId("settings-search-result-briefing-habits"));

    expect(await screen.findByText("mock-briefing")).toBeTruthy();
    expect(screen.queryByText("mock-general")).toBeNull();
    await vi.waitFor(() =>
      expect(document.getElementById("settings-anchor-habits")!.classList.contains("settings-anchor-flash")).toBe(true),
    );
    // 선택하면 검색창은 비고 목록은 닫힌다.
    expect((screen.getByTestId("settings-search-input") as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("브라우저 모드에서 걸러진 페이지의 항목은 검색에 나오지 않는다", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    useSettingsStore.setState({ uiLang: "ko" } as never);
    // 위 필터 테스트와 같은 방식 — 실제 세션 토큰 계약대로 sessionStorage 만 채운다. briefing 은 원격 허용 목록에 없다.
    sessionStorage.setItem("brise_sync_token", "t");
    try {
      render(<SettingsPanel onClose={() => {}} />);
      await userEvent.type(screen.getByTestId("settings-search-input"), t("settings.briefing_habits_section"));
      expect(screen.queryByTestId("settings-search-result-briefing-habits")).toBeNull();
      expect(await screen.findByTestId("settings-search-empty")).toBeTruthy();
    } finally {
      sessionStorage.removeItem("brise_sync_token");
    }
  });
});
