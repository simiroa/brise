import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettingsStore } from "../../stores/settings";
import { useWorkspacesStore } from "../../stores/workspaces";
import { useNotesStore } from "../../stores/notes";
import { useOnboardingSession } from "../../stores/onboardingSession";
import { OnboardingWizard } from "./OnboardingWizard";

// The wizard's own job (PLAN-2026-09-28-onboarding-rebuild.md §6) is wiring the first screen + 5
// setup pages (테마 → 데이터 → 지역 → AI → 기기 연결) + summary around these leaf components —
// their own internals are covered by their own dedicated test files, so they're stubbed here to
// keep this file focused on the shell's navigation/draft/completion contract.
const dataLocationMock = {
  root: "/default/brise-data",
  attachments_dir: "/default/brise-data/attachments",
  backups_dir: "/default/brise-data/backups",
  is_default: true,
  split: false,
};
vi.mock("./OnboardingDataStep", () => ({
  OnboardingDataStep: () => <div>mock-data-step</div>,
  useDataLocation: () => ({ current: dataLocationMock, loading: false, reload: vi.fn() }),
}));
// runDataMove is the only lib/dataMove export the shell itself calls directly (D4, §6) — every
// child step that also uses call/callSilent is mocked away above/below, so this single mock is
// enough for the whole file. Contract (parallel Rust worker, 2026-09-29): on success the process
// restarts and the promise never resolves in real life — the mock resolves so tests can observe
// what ran before that point; on rejection it clears its own "moving" flag and rethrows.
const runDataMoveMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../lib/dataMove", () => ({
  runDataMove: (...args: unknown[]) => runDataMoveMock(...args),
}));
vi.mock("./OnboardingRegionStep", () => ({
  OnboardingRegionStep: (props: { onSelectionChange: (s: { label: string; lat: number; lng: number } | null) => void }) => (
    <button onClick={() => props.onSelectionChange({ label: "Seoul", lat: 37.5, lng: 127 })}>mock-region-pick</button>
  ),
}));
// onAdoptReady mirrors OnboardingAiStep.tsx's real contract: it hands the shell an adopt function
// (or null) whenever readiness changes. mock-ai-ready-* buttons let tests flip that without
// re-implementing the real component's test/adopt flow.
vi.mock("./OnboardingAiStep", () => ({
  OnboardingAiStep: (props: {
    onAdopted: (info: { provider: string; model: string | null }) => void;
    onAdoptReady?: (adopt: (() => Promise<boolean>) | null) => void;
  }) => (
    <div>
      <div>mock-ai-step</div>
      <button onClick={() => props.onAdopted({ provider: "Gemini", model: "gemini-pro" })}>mock-ai-adopt</button>
      <button
        onClick={() =>
          props.onAdoptReady?.(async () => {
            props.onAdopted({ provider: "Gemini", model: "gemini-pro" });
            return true;
          })
        }
      >
        mock-ai-ready
      </button>
      <button onClick={() => props.onAdoptReady?.(async () => false)}>mock-ai-ready-fails</button>
    </div>
  ),
}));
vi.mock("./OnboardingConnectStep", () => ({
  OnboardingConnectStep: (props: { onStatusChange: (s: { enabled: boolean; qrSvg: string | null }) => void }) => (
    <div>
      <div>mock-connect-step</div>
      <button onClick={() => props.onStatusChange({ enabled: true, qrSvg: "<svg>mock</svg>" })}>mock-connect-enable</button>
    </div>
  ),
  ConnectQr: ({ svg }: { svg: string }) => <div data-testid="mock-connect-qr">{svg}</div>,
}));
vi.mock("./OnboardingImportStep", () => ({
  OnboardingImportStep: (props: { onImported: () => void; onCancel: () => void }) => (
    <div>
      <button onClick={props.onImported}>mock-import-done</button>
      <button onClick={props.onCancel}>mock-import-cancel</button>
    </div>
  ),
}));

describe("OnboardingWizard", () => {
  beforeEach(() => {
    runDataMoveMock.mockReset().mockResolvedValue(undefined);
    useOnboardingSession.getState().restart();
    useOnboardingSession.setState({ nameIdeaIdx: 0 });
    useSettingsStore.setState({
      onboardingCompleted: false,
      uiLang: "en",
      theme: "dark",
      surfaceStyle: "flat",
      accent: "#5b8def",
      defaultMapLocation: { lat: 37.5665, lng: 126.978, zoom: 150 },
      regionEnabled: true,
      setTheme: vi.fn().mockResolvedValue(undefined),
      setSurfaceStyle: vi.fn().mockResolvedValue(undefined),
      setUiLang: vi.fn().mockResolvedValue(undefined),
      setOnboardingCompleted: vi.fn().mockImplementation((v: boolean) => {
        useSettingsStore.setState({ onboardingCompleted: v });
        return Promise.resolve();
      }),
      setDefaultMapLocation: vi.fn().mockResolvedValue(true),
      setRegionEnabled: vi.fn().mockResolvedValue(undefined),
    });
    useWorkspacesStore.setState({
      workspaces: [{ id: "w1", name: "My workspace" }] as any,
      activeId: "w1",
      rename: vi.fn().mockResolvedValue(undefined),
    } as any);
    useNotesStore.setState({ newNote: vi.fn().mockResolvedValue(undefined) } as any);
  });

  it("does not render when onboarding is already completed", () => {
    useSettingsStore.setState({ onboardingCompleted: true });
    const { container } = render(<OnboardingWizard />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the first screen with three paths", () => {
    render(<OnboardingWizard />);
    expect(screen.getByTestId("onboarding-start-blank")).toBeTruthy();
    expect(screen.getByTestId("onboarding-go-import")).toBeTruthy();
    expect(screen.getByTestId("onboarding-go-setup")).toBeTruthy();
  });

  it("바로 시작하기 creates a note and completes onboarding only on success", async () => {
    const newNote = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);
    useNotesStore.setState({ newNote } as any);
    render(<OnboardingWizard />);

    await userEvent.click(screen.getByTestId("onboarding-start-blank"));
    expect(useSettingsStore.getState().onboardingCompleted).toBe(false);

    await userEvent.click(screen.getByTestId("onboarding-start-blank"));
    expect(useSettingsStore.getState().onboardingCompleted).toBe(true);
  });

  it("기록 가져오기 opens the import view; cancel stays there, 처음으로 returns, nothing completes", async () => {
    render(<OnboardingWizard />);
    await userEvent.click(screen.getByTestId("onboarding-go-import"));
    expect(screen.getByText("mock-import-done")).toBeTruthy();

    // 파일 선택 취소는 가져오기 화면에 남는다(끌어다 놓기로 다시 시도) — 완료 아님.
    await userEvent.click(screen.getByText("mock-import-cancel"));
    expect(screen.getByText("mock-import-done")).toBeTruthy();
    expect(useSettingsStore.getState().onboardingCompleted).toBe(false);

    await userEvent.click(screen.getByTestId("onboarding-import-back"));
    expect(screen.getByTestId("onboarding-start-blank")).toBeTruthy();
  });

  it("완료된 가져오기는 새 노트 없이 바로 완료 처리한다", async () => {
    render(<OnboardingWizard />);
    await userEvent.click(screen.getByTestId("onboarding-go-import"));
    await userEvent.click(screen.getByText("mock-import-done"));
    expect(useSettingsStore.getState().onboardingCompleted).toBe(true);
  });

  it("a seeded-name notebook gets a fun suggestion by default and the first screen holds the language; setup page 1 is theme only", async () => {
    useWorkspacesStore.setState({ workspaces: [{ id: "w1", name: "Brise" }] as any });
    render(<OnboardingWizard />);
    expect(screen.getByDisplayValue("New Notes")).toBeTruthy();
    expect(document.querySelector('[aria-label="Language"]')).toBeTruthy();

    await userEvent.click(screen.getByTestId("onboarding-go-setup"));
    expect(screen.queryByTestId("onboarding-notebook-name-input")).toBeNull();
    expect(screen.getByRole("radio", { name: "Light" })).toBeTruthy();
  });

  it("the notebook name typed on the first screen is saved when a path is taken", async () => {
    render(<OnboardingWizard />);
    const input = screen.getByTestId("onboarding-notebook-name-input");
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed notebook");
    expect(useWorkspacesStore.getState().rename).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("onboarding-go-setup"));
    expect(useWorkspacesStore.getState().rename).toHaveBeenCalledWith("w1", "Renamed notebook");
  });

  it("a notebook with its own name defaults to that name and is not renamed by any path taken untouched", async () => {
    render(<OnboardingWizard />);
    expect(screen.getByDisplayValue("My workspace")).toBeTruthy();
    // 손대지 않았으면 "그대로 두기" 링크도 필요 없다.
    expect(screen.queryByTestId("onboarding-notebook-name-keep")).toBeNull();

    await userEvent.click(screen.getByTestId("onboarding-go-setup"));
    expect(useWorkspacesStore.getState().rename).not.toHaveBeenCalled();
  });

  it("shuffle suggests another name; keeping the current name avoids renaming an existing notebook", async () => {
    render(<OnboardingWizard />);
    await userEvent.click(screen.getByTestId("onboarding-notebook-name-shuffle"));
    expect(screen.getByDisplayValue("Idea Garden")).toBeTruthy();

    // "My workspace" 는 사용자가 지은 이름 — 조용히 바꾸지 않도록 그대로 두기를 고를 수 있다.
    await userEvent.click(screen.getByTestId("onboarding-notebook-name-keep"));
    expect(screen.getByDisplayValue("My workspace")).toBeTruthy();
    await userEvent.click(screen.getByTestId("onboarding-go-setup"));
    expect(useWorkspacesStore.getState().rename).not.toHaveBeenCalled();
  });

  it("summary shows no region when one was only picked and the page was skipped", async () => {
    render(<OnboardingWizard />);
    await userEvent.click(screen.getByTestId("onboarding-go-setup"));
    await userEvent.click(screen.getByRole("button", { name: "Next" })); // 1 -> 2 (data)
    await userEvent.click(screen.getByTestId("onboarding-setup-page2-next")); // 2 -> 3 (region)
    await userEvent.click(screen.getByText("mock-region-pick"));
    await userEvent.click(screen.getByTestId("onboarding-setup-skip")); // 3 -> 4 without confirming
    await userEvent.click(screen.getByTestId("onboarding-setup-skip")); // 4 -> 5
    await userEvent.click(screen.getByTestId("onboarding-setup-skip")); // 5 -> summary

    expect(useSettingsStore.getState().setDefaultMapLocation).not.toHaveBeenCalled();
    expect(screen.getByTestId("onboarding-done-region").textContent).not.toContain("Seoul");
  });

  it("no keep-current hint on a fresh profile (seeded name)", () => {
    useWorkspacesStore.setState({ workspaces: [{ id: "w1", name: "Brise" }] as any });
    render(<OnboardingWizard />);
    expect(screen.queryByTestId("onboarding-notebook-name-keep")).toBeNull();
  });

  // 언어를 바꾸면 App.tsx 의 .app(key={uiLang}) 이 리마운트된다 — 이동 상태가 세션 스토어에 있어
  // 입력한 이름·보던 화면이 살아남아야 한다.
  it("the name draft and current screen survive a remount (language change)", async () => {
    const { unmount } = render(<OnboardingWizard />);
    const input = screen.getByTestId("onboarding-notebook-name-input");
    await userEvent.clear(input);
    await userEvent.type(input, "Draft name");
    unmount();

    render(<OnboardingWizard />);
    expect(screen.getByDisplayValue("Draft name")).toBeTruthy();
  });

  it("a failed notebook rename keeps the user on the first screen", async () => {
    useWorkspacesStore.setState({ rename: vi.fn().mockRejectedValue(new Error("boom")) } as any);
    render(<OnboardingWizard />);
    const input = screen.getByTestId("onboarding-notebook-name-input");
    await userEvent.clear(input);
    await userEvent.type(input, "New");
    await userEvent.click(screen.getByTestId("onboarding-go-setup"));
    expect(screen.getByTestId("onboarding-go-setup")).toBeTruthy();
  });

  it("theme click calls setTheme immediately (before 다음), not as a draft", async () => {
    render(<OnboardingWizard />);
    await userEvent.click(screen.getByTestId("onboarding-go-setup"));

    expect(useSettingsStore.getState().setTheme).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(useSettingsStore.getState().setTheme).toHaveBeenCalledWith("light");

    // surface style click is the same live contract.
    await userEvent.click(screen.getByRole("radio", { name: "Acrylic" }));
    expect(useSettingsStore.getState().setSurfaceStyle).toHaveBeenCalledWith("acrylic");
  });

  it("data page (2/5) just shows the data step, no gate", async () => {
    render(<OnboardingWizard />);
    await userEvent.click(screen.getByTestId("onboarding-go-setup"));
    await userEvent.click(screen.getByRole("button", { name: "Next" })); // page 1 (theme) -> page 2 (data)

    expect(screen.getByText("mock-data-step").closest("[hidden]")).toBeNull();
    await userEvent.click(screen.getByTestId("onboarding-setup-page2-next")); // -> page 3 (region)
    expect(screen.getByText("mock-region-pick")).toBeTruthy();
  });

  it("region confirm is disabled until a selection is made", async () => {
    render(<OnboardingWizard />);
    await userEvent.click(screen.getByTestId("onboarding-go-setup"));
    await userEvent.click(screen.getByRole("button", { name: "Next" })); // page 1 (theme) -> page 2 (data)
    await userEvent.click(screen.getByTestId("onboarding-setup-page2-next")); // page 2 -> page 3 (region)

    const confirm = screen.getByTestId("onboarding-setup-page3-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    await userEvent.click(screen.getByText("mock-region-pick"));
    expect(confirm.disabled).toBe(false);

    await userEvent.click(confirm);
    expect(useSettingsStore.getState().setDefaultMapLocation).toHaveBeenCalledWith({
      lat: 37.5,
      lng: 127,
      zoom: 150,
    });
    expect(screen.getByText("mock-ai-step").closest("[hidden]")).toBeNull();
  });

  it("region confirm stays on page 3 when the location save fails", async () => {
    // 스토어가 되돌리고 false 를 돌려준다(토스트는 call() 몫) — 지역을 켜거나 다음 쪽으로 가지 않는다.
    useSettingsStore.setState({ regionEnabled: false, setDefaultMapLocation: vi.fn().mockResolvedValue(false) });
    render(<OnboardingWizard />);
    await userEvent.click(screen.getByTestId("onboarding-go-setup"));
    await userEvent.click(screen.getByRole("button", { name: "Next" })); // page 1 (theme) -> page 2 (data)
    await userEvent.click(screen.getByTestId("onboarding-setup-page2-next")); // page 2 -> page 3 (region)
    await userEvent.click(screen.getByText("mock-region-pick"));
    await userEvent.click(screen.getByTestId("onboarding-setup-page3-confirm"));

    expect(useSettingsStore.getState().setDefaultMapLocation).toHaveBeenCalled();
    expect(useSettingsStore.getState().setRegionEnabled).not.toHaveBeenCalled();
    expect(screen.getByText("mock-ai-step").closest("[hidden]")).not.toBeNull();
    expect(screen.getByTestId("onboarding-setup-page3-confirm")).toBeTruthy();
  });

  it("page 5's QR replaces the connect art once a qrSvg is reported", async () => {
    render(<OnboardingWizard />);
    await userEvent.click(screen.getByTestId("onboarding-go-setup"));
    await userEvent.click(screen.getByRole("button", { name: "Next" })); // 1 -> 2 (data)
    await userEvent.click(screen.getByTestId("onboarding-setup-skip")); // 2 -> 3 (region)
    await userEvent.click(screen.getByTestId("onboarding-setup-skip")); // 3 -> 4 (ai)
    await userEvent.click(screen.getByTestId("onboarding-setup-skip")); // 4 -> 5 (connect)

    expect(screen.queryByTestId("mock-connect-qr")).toBeNull();
    await userEvent.click(screen.getByText("mock-connect-enable"));
    expect(screen.getByTestId("mock-connect-qr")).toBeTruthy();
  });

  it("the footer skip sits beside the primary action on every page and advances without saving", async () => {
    // 첫 화면 이름은 현재 이름 그대로 — 여기서 보는 건 설정 쪽 건너뛰기가 아무것도 저장하지 않는지다.
    useOnboardingSession.setState({ notebookDraft: "My workspace" });
    render(<OnboardingWizard />);
    await userEvent.click(screen.getByTestId("onboarding-go-setup"));
    for (let page = 1; page <= 5; page++) {
      const skip = screen.getByTestId("onboarding-setup-skip");
      // 같은 줄(형제) 에 주 행동 버튼이 있다.
      expect(skip.parentElement!.querySelector(".btn-primary")).toBeTruthy();
      await userEvent.click(skip);
    }
    expect(useSettingsStore.getState().setDefaultMapLocation).not.toHaveBeenCalled();
    expect(useWorkspacesStore.getState().rename).not.toHaveBeenCalled();
    // 5쪽 건너뛰기는 요약 화면으로 간다 — 아직 마무리(newNote)하지 않는다.
    expect(useNotesStore.getState().newNote).not.toHaveBeenCalled();
    expect(screen.getByTestId("onboarding-done-summary")).toBeTruthy();
  });

  it("page 5's 다음 goes to the summary screen, which shows the region label and AI info", async () => {
    render(<OnboardingWizard />);
    await userEvent.click(screen.getByTestId("onboarding-go-setup"));
    await userEvent.click(screen.getByRole("button", { name: "Next" })); // 1 -> 2 (data)
    await userEvent.click(screen.getByTestId("onboarding-setup-page2-next")); // 2 -> 3 (region)
    await userEvent.click(screen.getByText("mock-region-pick"));
    await userEvent.click(screen.getByTestId("onboarding-setup-page3-confirm")); // 3 -> 4 (ai)
    await userEvent.click(screen.getByText("mock-ai-adopt"));
    await userEvent.click(screen.getByRole("button", { name: "Next" })); // 4 -> 5 (connect)
    await userEvent.click(screen.getByTestId("onboarding-setup-page5-next")); // 5 -> summary

    expect(screen.getByTestId("onboarding-done-region").textContent).toContain("Seoul");
    expect(screen.getByTestId("onboarding-done-ai").textContent).toContain("Gemini");
  });

  it("summary shows the default storage location when nothing was picked", async () => {
    render(<OnboardingWizard />);
    await userEvent.click(screen.getByTestId("onboarding-go-setup"));
    for (let page = 1; page <= 5; page++) {
      await userEvent.click(screen.getByTestId("onboarding-setup-skip"));
    }
    // 요약 칩은 폴더 이름만 보이고 전체 경로는 title 에 든다(띠가 한 줄에 들어가야 해서).
    const chip = screen.getByTestId("onboarding-done-data-location");
    expect(chip.textContent).toContain("brise-data");
    expect(chip.getAttribute("title")).toContain(dataLocationMock.root);
  });

  it("summary's 내 노트 시작하기 creates a note and completes onboarding", async () => {
    render(<OnboardingWizard />);
    await userEvent.click(screen.getByTestId("onboarding-go-setup"));
    for (let page = 1; page <= 5; page++) {
      await userEvent.click(screen.getByTestId("onboarding-setup-skip"));
    }
    expect(useNotesStore.getState().newNote).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Start my notes" }));
    expect(useNotesStore.getState().newNote).toHaveBeenCalled();
    expect(useSettingsStore.getState().onboardingCompleted).toBe(true);
    // 저장 위치를 고르지 않았으면(§6 D4) 이동 관문도 부르지 않는다.
    expect(runDataMoveMock).not.toHaveBeenCalled();
  });

  // §6 D4: 새 저장 위치는 요약 화면 "내 노트 시작하기"에서 한 번 — 순서는
  // onboardingCompleted 저장 → runDataMove(같은 관문, main 창) → (성공하면 재시작이 대신 끝낸다).
  // 이 경로에서는 초안 노트를 만들지 않는다(재시작 뒤 사라질 초안이라 저장할 이유가 없다).
  it("applies a pending data location on finish, in order: onboardingCompleted -> runDataMove; no draft note", async () => {
    useOnboardingSession.setState({ pendingDataPath: "/new/location" });
    const order: string[] = [];
    useSettingsStore.setState({
      setOnboardingCompleted: vi.fn().mockImplementation((v: boolean) => {
        order.push("onboardingCompleted");
        useSettingsStore.setState({ onboardingCompleted: v });
        return Promise.resolve();
      }),
    });
    runDataMoveMock.mockImplementation(async () => {
      order.push("runDataMove");
      // 실제 성공 시엔 재시작이 대신 끝나므로 이 프라미스는 해석되지 않는다 — 테스트에서는
      // 그 전까지 뭐가 돌았는지만 본다.
      return new Promise(() => {});
    });
    render(<OnboardingWizard />);

    await userEvent.click(screen.getByTestId("onboarding-start-blank"));

    await waitFor(() => expect(runDataMoveMock).toHaveBeenCalledWith("/new/location"));
    expect(order).toEqual(["onboardingCompleted", "runDataMove"]);
    expect(useNotesStore.getState().newNote).not.toHaveBeenCalled();
  });

  it("a failed data move clears pendingDataPath and still lands the user in a note", async () => {
    useOnboardingSession.setState({ pendingDataPath: "/new/location" });
    runDataMoveMock.mockRejectedValueOnce(new Error("boom"));
    render(<OnboardingWizard />);

    await userEvent.click(screen.getByTestId("onboarding-start-blank"));

    await waitFor(() => expect(useNotesStore.getState().newNote).toHaveBeenCalled());
    expect(useSettingsStore.getState().onboardingCompleted).toBe(true);
    expect(useOnboardingSession.getState().pendingDataPath).toBeNull();
  });

  it("summary's 이전 returns to page 5, keeping its state", async () => {
    render(<OnboardingWizard />);
    await userEvent.click(screen.getByTestId("onboarding-go-setup"));
    for (let page = 1; page <= 5; page++) {
      await userEvent.click(screen.getByTestId("onboarding-setup-skip"));
    }

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("mock-connect-step").closest("[hidden]")).toBeNull();
  });

  // The developer sponsor link is a placeholder (SPONSOR_URL is empty until the owner supplies a
  // real one) — the button must not render an unusable link.
  it("hides the sponsor button while SPONSOR_URL is empty", async () => {
    render(<OnboardingWizard />);
    await userEvent.click(screen.getByTestId("onboarding-go-setup"));
    for (let page = 1; page <= 5; page++) {
      await userEvent.click(screen.getByTestId("onboarding-setup-skip"));
    }
    expect(screen.queryByTestId("onboarding-done-sponsor")).toBeNull();
  });

  // 오너 2026-09-29 (B): 온보딩은 X 로만 닫힌다 — 긴 입력 흐름에서 실수로 바깥을 클릭하거나
  // Escape 를 눌러 전체가 닫히는 사고를 막는다(ModalShell dismissible prop).
  it("backdrop click and Escape do not close the wizard; only X does", async () => {
    render(<OnboardingWizard />);
    await userEvent.click(screen.getByTestId("modal-backdrop"));
    expect(screen.getByTestId("modal-shell")).toBeTruthy();

    await userEvent.keyboard("{Escape}");
    expect(screen.getByTestId("modal-shell")).toBeTruthy();

    await userEvent.click(screen.getByTestId("modal-close-btn"));
    expect(screen.queryByTestId("modal-shell")).toBeNull();
  });

  // AI 쪽(4/5) 셸 주 버튼 — OnboardingAiStep 이 onAdoptReady 로 채택 함수를 올리면 라벨이 바뀌고,
  // 누르면 그 함수를 먼저 부른 뒤 true 를 돌려줄 때만 다음 쪽으로 간다(오너 2026-09-29 A).
  it("AI page footer switches label when adopt is ready and only advances once adopt resolves true", async () => {
    render(<OnboardingWizard />);
    await userEvent.click(screen.getByTestId("onboarding-go-setup"));
    await userEvent.click(screen.getByRole("button", { name: "Next" })); // 1 -> 2 (data)
    await userEvent.click(screen.getByTestId("onboarding-setup-page2-next")); // 2 -> 3 (region)
    await userEvent.click(screen.getByText("mock-region-pick"));
    await userEvent.click(screen.getByTestId("onboarding-setup-page3-confirm")); // 3 -> 4 (ai)

    // 준비 전엔 평범한 "다음".
    expect(screen.getByTestId("onboarding-setup-page4-next").textContent).toBe("Next");

    // 실패하는 채택 함수 — 라벨은 바뀌지만 누르면 4쪽에 남는다.
    await userEvent.click(screen.getByText("mock-ai-ready-fails"));
    expect(screen.getByTestId("onboarding-setup-page4-next").textContent).toBe("Turn on and continue");
    await userEvent.click(screen.getByTestId("onboarding-setup-page4-next"));
    expect(screen.getByText("mock-ai-step")).toBeTruthy();

    // 성공하는 채택 함수 — 누르면 채택되고(onAdopted) 5쪽으로 넘어간다.
    await userEvent.click(screen.getByText("mock-ai-ready"));
    await userEvent.click(screen.getByTestId("onboarding-setup-page4-next"));
    expect(screen.getByText("mock-connect-step")).toBeTruthy();
  });

  it("X closes for this run only: onboarding is not marked completed, restart reopens the first screen", async () => {
    render(<OnboardingWizard />);
    await userEvent.click(screen.getByTestId("onboarding-go-setup"));
    await userEvent.click(screen.getByTestId("modal-close-btn"));
    expect(screen.queryByTestId("modal-shell")).toBeNull();
    expect(useSettingsStore.getState().onboardingCompleted).toBe(false);
    expect(useSettingsStore.getState().setOnboardingCompleted).not.toHaveBeenCalled();

    act(() => useOnboardingSession.getState().restart());
    expect(screen.getByTestId("onboarding-start-blank")).toBeTruthy();
  });
});
