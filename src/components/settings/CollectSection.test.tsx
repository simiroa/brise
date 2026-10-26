import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettingsStore } from "../../stores/settings";
import { CollectSection } from "./CollectSection";

// ponytail: full-suite runs contend for the CPU, so the default 10s test timeout is too tight
// for the typing-heavy save flows below. Raise per-file rather than globally in vitest.config.ts.
vi.setConfig({ testTimeout: 20000 });

const callMock = vi.fn();
const callSilentMock = vi.fn();
const emitNoticeMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
  registerFlush: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
}));

const mockAsk = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: (...args: unknown[]) => mockAsk(...args),
}));

const okSource = {
  id: "s1",
  workspace_id: "w1",
  kind: "rss",
  name: "Example Feed",
  config: "{}",
  enabled: true,
  last_run_at: new Date().toISOString(),
  last_status: "ok",
  last_error: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const errorSource = {
  id: "s2",
  workspace_id: "w1",
  kind: "claude_prompts",
  name: "My Prompts",
  config: "{}",
  enabled: false,
  last_run_at: "2026-01-01T00:00:00Z",
  last_status: "error",
  last_error: "fetch failed: timeout",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const neverSource = {
  id: "s3",
  workspace_id: "w1",
  kind: "rss",
  name: "Untried Feed",
  config: "{}",
  enabled: true,
  last_run_at: null,
  last_status: null,
  last_error: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function mockList(sources: unknown[]) {
  callMock.mockReset().mockImplementation((cmd: string) => {
    if (cmd === "collect_source_list") return Promise.resolve({ sources });
    return Promise.resolve({ ok: true });
  });
}

describe("CollectSection", () => {
  beforeEach(() => {
    callSilentMock.mockReset();
    callSilentMock.mockResolvedValue({ settings: {} });
    emitNoticeMock.mockReset();
    mockAsk.mockReset();
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as any);
    mockList([]);
  });

  it("loads and renders sources on mount, showing ok/error/never status", async () => {
    mockList([okSource, errorSource, neverSource]);
    render(<CollectSection />);

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("collect_source_list", {}));
    expect(await screen.findByText("Example Feed")).toBeTruthy();
    expect(screen.getByText("My Prompts")).toBeTruthy();
    expect(screen.getByText("Untried Feed")).toBeTruthy();
    expect(screen.getByText(/Error: fetch failed: timeout/)).toBeTruthy();
    expect(screen.getByText("Not run yet")).toBeTruthy();

    // cron-table axes (W5): 표에 칸이 없는 주기·저장 폴더·AI 는 이름 칸 툴팁이, 주소는 주소 칸이 말한다 —
    // 빈 config·폴더 없음·후처리 꺼짐인 맨 소스도 마찬가지.
    const okAxes = screen.getByTestId("collect-name-s1").getAttribute("title") ?? "";
    expect(okAxes).toContain("1 hour (Default)"); // interval_minutes unset -> defaults to 60
    expect(okAxes).toContain("Inbox (Default)"); // target_folder_id unset -> inbox fallback
    expect(okAxes).toContain("No AI"); // post_process unset -> off badge
    expect(screen.getByTestId("collect-address-s1").textContent).toContain("—"); // config "{}" has no url/project

    // a disabled source (errorSource has enabled: false) dims the whole row and explains why
    // only via a title tooltip (docs/DESIGN.md §설정 레이아웃 ④) — no permanent on-screen text.
    const disabledRow = screen.getByTestId("collect-row-s2");
    expect(disabledRow.getAttribute("style") ?? "").toContain("dim-disabled");
    expect(disabledRow.getAttribute("title")).toBeTruthy();
  });

  // PLAN-2026-09-15 §4 수집: 마스터 행 + 통계 타일 3 + 행 Badge.
  it("renders the master row with the toggle and a paused badge when collection is paused", async () => {
    useSettingsStore.setState({ collectPausedUntil: "2099-12-31T23:59:59+00:00" } as any);
    render(<CollectSection />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("collect_source_list", {}));

    const master = screen.getByTestId("settings-collect-master-card");
    expect(master.contains(screen.getByTestId("settings-collect-enabled-toggle"))).toBe(true);
    expect(master.textContent).toContain("Paused");
    useSettingsStore.setState({ collectPausedUntil: "" } as any);
  });

  it("renders today / 7-day / active-source metric tiles from collect_get_stats and the source list", async () => {
    callSilentMock.mockImplementation((cmd: string) => {
      if (cmd === "collect_get_stats") {
        return Promise.resolve({
          total_today: 4,
          total_since: 27,
          per_action: [{ action_type: "link_suggest", calls: 3 }],
        });
      }
      return Promise.resolve({ settings: {} });
    });
    mockList([okSource, errorSource, neverSource]);
    render(<CollectSection />);
    await screen.findByText("Example Feed");

    await waitFor(() => expect(screen.getByTestId("metric-tile-collect-today").textContent).toContain("4"));
    expect(screen.getByTestId("metric-tile-collect-week").textContent).toContain("27");
    expect(screen.getByTestId("metric-tile-collect-week").textContent).toContain("3");
    // 2 of 3 sources enabled (errorSource is disabled)
    expect(screen.getByTestId("metric-tile-collect-active").textContent).toContain("2 / 3");
    expect(screen.getByTestId("settings-collect-master-card").textContent ?? "").not.toContain("Paused");
  });

  it("shows an error status Badge only on rows whose last_status is error", async () => {
    mockList([okSource, errorSource]);
    render(<CollectSection />);
    await screen.findByText("Example Feed");
    expect(screen.getByTestId("collect-status-badge-s2").textContent).toContain("fetch failed");
    expect(screen.queryByTestId("collect-status-badge-s1")).toBeNull();
  });

  it("shows the empty-state hint when there are no sources", async () => {
    render(<CollectSection />);
    expect(await screen.findByText("No sources yet.")).toBeTruthy();
  });

  it("renders the cron-table axes (interval, address, target folder, AI) from the source config", async () => {
    const configuredSource = {
      ...okSource,
      id: "s4",
      name: "Configured Feed",
      config: JSON.stringify({ url: "https://example.com/feed.xml" }),
      target_folder_id: "folder-9",
      interval_minutes: 180,
      post_process: "suggest",
    };
    mockList([configuredSource]);
    render(<CollectSection />);
    await screen.findByText("Configured Feed");

    const axes = screen.getByTestId("collect-name-s4").getAttribute("title") ?? "";
    expect(axes).toContain("3 hours");
    expect(screen.getByTestId("collect-address-s4").textContent).toContain("https://example.com/feed.xml");
    expect(axes).toContain("folder-9"); // no matching folder in store -> raw id fallback
    expect(axes).toContain("AI Suggest");
  });

  it("renders the add-source action and does not render chatbot register toggle here", async () => {
    render(<CollectSection />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("collect_source_list", {}));
    expect(screen.queryByTestId("collect-quick-url-input")).toBeNull();
    expect(screen.getByTestId("collect-table-add-row")).toBeTruthy();
    expect(screen.queryByTestId("settings-collect-chat-register-toggle")).toBeNull();
  });

  it("toggling enabled calls collect_source_set_enabled with the new value", async () => {
    mockList([okSource]);
    render(<CollectSection />);
    await screen.findByText("Example Feed");
    callMock.mockClear();
    mockList([okSource]);

    await userEvent.click(screen.getByTestId("collect-enabled-s1"));

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("collect_source_set_enabled", { id: "s1", enabled: false }),
    );
  });

  it("run now calls collect_source_run_now and toasts the added count", async () => {
    mockList([okSource]);
    render(<CollectSection />);
    await screen.findByText("Example Feed");
    callMock.mockClear();
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "collect_source_run_now") return Promise.resolve({ ok: true, added: 3, error: null });
      if (cmd === "collect_source_list") return Promise.resolve({ sources: [okSource] });
      return Promise.resolve({ ok: true });
    });

    await userEvent.click(screen.getByTestId("collect-run-s1"));

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("collect_source_run_now", { id: "s1" }),
    );
    await waitFor(() => expect(emitNoticeMock).toHaveBeenCalledWith("Added 3"));
  });

  it("clicking run on another source while one is running says so instead of ignoring the click", async () => {
    mockList([okSource, neverSource]);
    render(<CollectSection />);
    await screen.findByText("Example Feed");
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "collect_source_run_now") return new Promise(() => {}); // 계속 도는 중
      if (cmd === "collect_source_list") return Promise.resolve({ sources: [okSource, neverSource] });
      return Promise.resolve({ ok: true });
    });

    await userEvent.click(screen.getByTestId("collect-run-s1"));
    await waitFor(() => expect((screen.getByTestId("collect-run-s1") as HTMLButtonElement).disabled).toBe(true));
    await userEvent.click(screen.getByTestId("collect-run-s3"));

    expect(emitNoticeMock).toHaveBeenCalledWith("Another source is running. Try again when it finishes.");
    expect(callMock.mock.calls.filter((c) => c[0] === "collect_source_run_now")).toHaveLength(1);
  });

  it("a failed list load says so (with retry) instead of claiming there are no sources", async () => {
    callMock.mockReset().mockImplementation((cmd: string) =>
      cmd === "collect_source_list" ? Promise.reject(new Error("db busy")) : Promise.resolve({ ok: true }),
    );
    render(<CollectSection />);

    expect(await screen.findByTestId("collect-load-failed")).toBeTruthy();
    expect(screen.queryByText("No sources yet.")).toBeNull();

    mockList([okSource]);
    await userEvent.click(screen.getByTestId("collect-load-retry"));
    expect(await screen.findByText("Example Feed")).toBeTruthy();
  });

  it("stat tiles show a dash, not 0, when the stats could not be read", async () => {
    callSilentMock.mockImplementation((cmd: string) =>
      cmd === "collect_get_stats" ? Promise.reject(new Error("x")) : Promise.resolve({ settings: {} }),
    );
    mockList([]);
    render(<CollectSection />);
    await waitFor(() => expect(callSilentMock).toHaveBeenCalledWith("collect_get_stats", {}));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("dry-run failure is reported once (call() already toasted)", async () => {
    mockList([okSource]);
    render(<CollectSection />);
    await screen.findByText("Example Feed");
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "collect_source_dry_run") return Promise.reject({ message: "boom" });
      if (cmd === "collect_source_list") return Promise.resolve({ sources: [okSource] });
      return Promise.resolve({ ok: true });
    });

    await userEvent.click(screen.getByTestId("collect-dry-run-s1"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("collect_source_dry_run", { id: "s1" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(emitNoticeMock).not.toHaveBeenCalledWith("boom");
  });

  it("run now toasts the raw error string when the run fails", async () => {
    mockList([okSource]);
    render(<CollectSection />);
    await screen.findByText("Example Feed");
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "collect_source_run_now") return Promise.resolve({ ok: false, added: 0, error: "feed unreachable" });
      if (cmd === "collect_source_list") return Promise.resolve({ sources: [okSource] });
      return Promise.resolve({ ok: true });
    });

    await userEvent.click(screen.getByTestId("collect-run-s1"));

    await waitFor(() => expect(emitNoticeMock).toHaveBeenCalledWith("feed unreachable"));
  });

  it("deleting a source asks for confirmation once, then calls collect_source_delete", async () => {
    mockList([okSource]);
    render(<CollectSection />);
    await screen.findByText("Example Feed");

    await userEvent.click(screen.getByTestId("collect-delete-s1"));
    // Confirmation dialog gates the actual delete call.
    expect(callMock).not.toHaveBeenCalledWith("collect_source_delete", { id: "s1" });

    callMock.mockClear();
    mockList([]);
    await userEvent.click(screen.getByText("Remove"));

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("collect_source_delete", { id: "s1" }));
  });

  it("opens create form modal and calls collect_source_create on save", async () => {
    mockList([]);
    render(<CollectSection />);
    await userEvent.click(screen.getByTestId("collect-table-add-row"));

    expect(screen.getByRole("heading", { name: "Add Source" })).toBeTruthy();
    await userEvent.type(screen.getByPlaceholderText("e.g. Tech blog"), "Tech RSS");
    await userEvent.type(screen.getByPlaceholderText("https://..."), "https://tech.example.com/rss");

    callMock.mockClear();
    callMock.mockResolvedValue({ id: "new_id" });

    await userEvent.click(screen.getByTestId("collect-form-save-btn"));

    await waitFor(() =>
      expect(callSilentMock).toHaveBeenCalledWith("collect_source_create", expect.objectContaining({
        kind: "rss",
        name: "Tech RSS",
        config: JSON.stringify({ url: "https://tech.example.com/rss", interval_minutes: 60 }),
      })),
    );
  });

  it("saving a youtube channel source resolves the feed url first, then creates it as kind=rss", async () => {
    mockList([]);
    render(<CollectSection />);
    await userEvent.click(screen.getByTestId("collect-table-add-row"));

    await userEvent.click(screen.getByRole("button", { name: "Source Type" }));
    await userEvent.click(screen.getByRole("option", { name: "YouTube Channel" }));

    await userEvent.type(screen.getByPlaceholderText("e.g. Tech blog"), "My Channel");
    await userEvent.type(
      screen.getByPlaceholderText("https://www.youtube.com/@channelname"),
      "https://www.youtube.com/@example",
    );

    // youtube_channel now goes through the same yt-dlp consent gate as kind=youtube (2026-08-29
    // fix — a channel source saves as kind='rss', so post-save there is no signal left to gate
    // on; must gate here, at creation). "already installed" keeps this test focused on the
    // resolve→create wiring; the gate's ask()/decline/install-failure paths are covered by the
    // "yt-dlp consent gate" describe block below for kind=youtube.
    // 저장 경로는 callSilent 다 — 실패는 폼 안 오류 줄 한 곳에서만 말한다(토스트 중복 없음).
    callSilentMock.mockReset().mockImplementation((cmd: string) => {
      if (cmd === "collect_ytdlp_status") return Promise.resolve({ installed: true });
      if (cmd === "collect_resolve_youtube_channel") {
        return Promise.resolve({ feed_url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxx" });
      }
      return Promise.resolve({ id: "new_id" });
    });

    await userEvent.click(screen.getByTestId("collect-form-save-btn"));

    await waitFor(() =>
      expect(callSilentMock).toHaveBeenCalledWith("collect_resolve_youtube_channel", {
        url: "https://www.youtube.com/@example",
      }),
    );
    await waitFor(() =>
      expect(callSilentMock).toHaveBeenCalledWith("collect_source_create", expect.objectContaining({
        kind: "rss",
        name: "My Channel",
        config: JSON.stringify({ url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxx" }),
      })),
    );
  });

  it("clicking test fetch (dry run) opens preview modal with dry run items", async () => {
    mockList([okSource]);
    render(<CollectSection />);
    await screen.findByText("Example Feed");

    callMock.mockImplementation((cmd: string) => {
      if (cmd === "collect_source_dry_run") {
        return Promise.resolve({
          ok: true,
          items: [
            { guid: "item-1", title: "Article 1", link: "https://example.com/1", seen: false, preview: "Summary of 1" },
            { guid: "item-2", title: "Article 2", link: "https://example.com/2", seen: true, preview: "Summary of 2" },
          ],
          total_found: 2,
          new_count: 1,
          seen_count: 1,
          error: null,
        });
      }
      return Promise.resolve({ ok: true });
    });

    await userEvent.click(screen.getByTestId("collect-dry-run-s1"));

    expect(await screen.findByText(/Dry Run Test Results/)).toBeTruthy();
    expect(screen.getByText("Article 1")).toBeTruthy();
    expect(screen.getByText("Article 2")).toBeTruthy();
    expect(screen.getByText("New")).toBeTruthy();
    expect(screen.getByText("Already Seen")).toBeTruthy();
  });

  describe("yt-dlp consent gate", () => {
    const youtubeSource = { ...okSource, id: "yt1", kind: "youtube", name: "Some Video", dry_run: false };

    // collect_ytdlp_status/collect_ytdlp_install both go through callSilent (ensureYtdlp in
    // CollectSection.tsx), never the auto-toasting call().
    function mockYtdlp(opts: { installed: boolean; installOk?: boolean }) {
      callSilentMock.mockReset().mockImplementation((cmd: string) => {
        if (cmd === "collect_ytdlp_status") return Promise.resolve({ installed: opts.installed });
        if (cmd === "collect_ytdlp_install") {
          return opts.installOk === false
            ? Promise.reject({ message: "network unreachable" })
            : Promise.resolve({ ok: true });
        }
        return Promise.resolve({ settings: {} });
      });
    }

    it("run now: already installed proceeds without asking", async () => {
      mockList([youtubeSource]);
      render(<CollectSection />);
      await screen.findByText("Some Video");
      mockYtdlp({ installed: true });

      await userEvent.click(screen.getByTestId("collect-run-yt1"));

      await waitFor(() => expect(callMock).toHaveBeenCalledWith("collect_source_run_now", { id: "yt1" }));
      expect(mockAsk).not.toHaveBeenCalled();
    });

    it("run now: declining the download blocks the run", async () => {
      mockList([youtubeSource]);
      render(<CollectSection />);
      await screen.findByText("Some Video");
      mockYtdlp({ installed: false });
      mockAsk.mockResolvedValue(false);

      await userEvent.click(screen.getByTestId("collect-run-yt1"));

      await waitFor(() => expect(mockAsk).toHaveBeenCalled());
      expect(callSilentMock).not.toHaveBeenCalledWith("collect_ytdlp_install", {});
      expect(callMock).not.toHaveBeenCalledWith("collect_source_run_now", { id: "yt1" });
    });

    it("run now: accepting downloads yt-dlp, then proceeds with the run", async () => {
      mockList([youtubeSource]);
      render(<CollectSection />);
      await screen.findByText("Some Video");
      mockYtdlp({ installed: false });
      mockAsk.mockResolvedValue(true);

      await userEvent.click(screen.getByTestId("collect-run-yt1"));

      await waitFor(() => expect(callSilentMock).toHaveBeenCalledWith("collect_ytdlp_install", {}));
      await waitFor(() => expect(callMock).toHaveBeenCalledWith("collect_source_run_now", { id: "yt1" }));
    });

    it("run now: an install failure blocks the run and toasts a localized error", async () => {
      mockList([youtubeSource]);
      render(<CollectSection />);
      await screen.findByText("Some Video");
      mockYtdlp({ installed: false, installOk: false });
      mockAsk.mockResolvedValue(true);

      await userEvent.click(screen.getByTestId("collect-run-yt1"));

      await waitFor(() =>
        expect(emitNoticeMock).toHaveBeenCalledWith("yt-dlp download failed: network unreachable"),
      );
      expect(callMock).not.toHaveBeenCalledWith("collect_source_run_now", { id: "yt1" });
    });

    it("run now: a non-youtube source never checks yt-dlp status", async () => {
      mockList([okSource]);
      render(<CollectSection />);
      await screen.findByText("Example Feed");
      callMock.mockClear();
      mockList([okSource]);

      await userEvent.click(screen.getByTestId("collect-run-s1"));

      await waitFor(() => expect(callMock).toHaveBeenCalledWith("collect_source_run_now", { id: "s1" }));
      expect(callSilentMock).not.toHaveBeenCalledWith("collect_ytdlp_status", {});
      expect(mockAsk).not.toHaveBeenCalled();
    });

    it("dry run: declining the download blocks the test fetch", async () => {
      mockList([youtubeSource]);
      render(<CollectSection />);
      await screen.findByText("Some Video");
      mockYtdlp({ installed: false });
      mockAsk.mockResolvedValue(false);

      await userEvent.click(screen.getByTestId("collect-dry-run-yt1"));

      await waitFor(() => expect(mockAsk).toHaveBeenCalled());
      expect(callMock).not.toHaveBeenCalledWith("collect_source_dry_run", { id: "yt1" });
    });

    it("saving a new youtube source: declining the download blocks the save", async () => {
      // ponytail: real per-keystroke timers (userEvent's default delay) race under full-suite
      // load — delay:null makes typing synchronous so this doesn't depend on the event loop
      // draining in time (2026-09-05 flake: passed alone, timed out under load).
      const user = userEvent.setup({ delay: null });
      mockList([]);
      render(<CollectSection />);
      await user.click(screen.getByTestId("collect-table-add-row"));
      await user.click(screen.getByRole("button", { name: "Source Type" }));
      await user.click(screen.getByRole("option", { name: "YouTube" }));
      await user.type(screen.getByPlaceholderText("e.g. Tech blog"), "My Video");
      await user.type(screen.getByPlaceholderText("https://..."), "https://www.youtube.com/watch?v=abc");

      mockYtdlp({ installed: false });
      mockAsk.mockResolvedValue(false);
      callMock.mockClear();

      await user.click(screen.getByTestId("collect-form-save-btn"));

      await waitFor(() => expect(mockAsk).toHaveBeenCalled(), { timeout: 5000 });
      expect(callSilentMock).not.toHaveBeenCalledWith("collect_source_create", expect.anything());
    });
  });

  describe("local source detection (W8, PLAN-2026-09-04-local-import)", () => {
    const chromeCandidate = {
      key: "chrome:Default",
      kind: "browser_history",
      label: "Chrome — Default",
      detail: "479 visits",
      recent_count: 479,
      last_seen_at: null,
      source_id: null,
      config: JSON.stringify({ browser: "chrome", profile: "Default" }),
    };
    const claudeCandidate = {
      key: "claude_prompts",
      kind: "claude_prompts",
      label: "Claude prompts",
      detail: "29 sessions",
      recent_count: 29,
      last_seen_at: null,
      source_id: null,
      config: "{}",
    };
    const alreadySourcedCandidate = {
      ...claudeCandidate,
      key: "codex_prompts",
      label: "Codex prompts",
      source_id: "existing-source-id",
    };

    it("detect button calls collect_detect_local and renders a ghost row per candidate with a null source_id", async () => {
      mockList([]);
      render(<CollectSection />);
      await waitFor(() => expect(callMock).toHaveBeenCalledWith("collect_source_list", {}));
      callMock.mockImplementation((cmd: string) => {
        if (cmd === "collect_detect_local") {
          return Promise.resolve({ candidates: [chromeCandidate, claudeCandidate, alreadySourcedCandidate] });
        }
        return Promise.resolve({ sources: [] });
      });

      await userEvent.click(screen.getByTestId("collect-detect-btn"));

      await waitFor(() => expect(callMock).toHaveBeenCalledWith("collect_detect_local", {}));
      expect(await screen.findByTestId("collect-ghost-chrome:Default")).toBeTruthy();
      expect(screen.getByText("Chrome — Default")).toBeTruthy();
      expect(screen.getByText("479 visits")).toBeTruthy();
      expect(screen.getByTestId("collect-ghost-claude_prompts")).toBeTruthy();
      // candidate with a non-null source_id already has a real row elsewhere — no ghost for it.
      expect(screen.queryByTestId("collect-ghost-codex_prompts")).toBeNull();
    });

    it("shows the empty-detection line when no candidates come back", async () => {
      mockList([]);
      render(<CollectSection />);
      await waitFor(() => expect(callMock).toHaveBeenCalledWith("collect_source_list", {}));
      callMock.mockImplementation((cmd: string) =>
        cmd === "collect_detect_local" ? Promise.resolve({ candidates: [] }) : Promise.resolve({ sources: [] }),
      );

      await userEvent.click(screen.getByTestId("collect-detect-btn"));

      expect(await screen.findByText("No local sources detected.")).toBeTruthy();
    });

    it("import -> dry run -> confirm calls collect_source_run_now with the created source id and refreshes", async () => {
      mockList([]);
      render(<CollectSection />);
      await waitFor(() => expect(callMock).toHaveBeenCalledWith("collect_source_list", {}));

      const createdSource = { ...okSource, id: "created-1", kind: "claude_prompts", name: "Claude prompts" };
      callMock.mockImplementation((cmd: string) => {
        if (cmd === "collect_detect_local") return Promise.resolve({ candidates: [claudeCandidate] });
        if (cmd === "collect_import_local") return Promise.resolve(createdSource);
        if (cmd === "collect_source_dry_run") {
          return Promise.resolve({ ok: true, items: [], total_found: 0, new_count: 0, seen_count: 0, error: null });
        }
        if (cmd === "collect_source_run_now") return Promise.resolve({ ok: true, added: 7, error: null });
        if (cmd === "collect_source_list") return Promise.resolve({ sources: [createdSource] });
        return Promise.resolve({ ok: true });
      });

      await userEvent.click(screen.getByTestId("collect-detect-btn"));
      await screen.findByTestId("collect-ghost-claude_prompts");

      await userEvent.click(screen.getByTestId("collect-ghost-import-claude_prompts"));
      await waitFor(() => expect(callMock).toHaveBeenCalledWith("collect_import_local", { key: "claude_prompts" }));
      await waitFor(() => expect(callMock).toHaveBeenCalledWith("collect_source_dry_run", { id: "created-1" }));

      const confirmBtn = await screen.findByTestId("collect-dry-run-confirm-btn");
      await userEvent.click(confirmBtn);

      await waitFor(() => expect(callMock).toHaveBeenCalledWith("collect_source_run_now", { id: "created-1" }));
      await waitFor(() => expect(emitNoticeMock).toHaveBeenCalledWith("Added 7"));
      // modal closes and the ghost row for the imported candidate is gone.
      await waitFor(() => expect(screen.queryByTestId("modal-shell")).toBeNull());
      expect(screen.queryByTestId("collect-ghost-claude_prompts")).toBeNull();
    });

    it("closing the dry-run modal without confirming does not run the created source", async () => {
      mockList([]);
      render(<CollectSection />);
      await waitFor(() => expect(callMock).toHaveBeenCalledWith("collect_source_list", {}));

      const createdSource = { ...okSource, id: "created-2", kind: "claude_prompts", name: "Claude prompts" };
      callMock.mockImplementation((cmd: string) => {
        if (cmd === "collect_detect_local") return Promise.resolve({ candidates: [claudeCandidate] });
        if (cmd === "collect_import_local") return Promise.resolve(createdSource);
        if (cmd === "collect_source_dry_run") {
          return Promise.resolve({ ok: true, items: [], total_found: 0, new_count: 0, seen_count: 0, error: null });
        }
        if (cmd === "collect_source_list") return Promise.resolve({ sources: [createdSource] });
        return Promise.resolve({ ok: true });
      });

      await userEvent.click(screen.getByTestId("collect-detect-btn"));
      await screen.findByTestId("collect-ghost-claude_prompts");
      await userEvent.click(screen.getByTestId("collect-ghost-import-claude_prompts"));
      await screen.findByTestId("collect-dry-run-confirm-btn");

      await userEvent.click(screen.getByTestId("collect-dry-run-close-btn"));

      expect(screen.queryByTestId("modal-shell")).toBeNull();
      expect(callMock).not.toHaveBeenCalledWith("collect_source_run_now", { id: "created-2" });
    });

    it("shows the open-tabs hint in the dry-run modal for a browser_history candidate", async () => {
      mockList([]);
      render(<CollectSection />);
      await waitFor(() => expect(callMock).toHaveBeenCalledWith("collect_source_list", {}));

      const createdSource = { ...okSource, id: "created-3", kind: "browser_history", name: "Chrome — Default" };
      callMock.mockImplementation((cmd: string) => {
        if (cmd === "collect_detect_local") return Promise.resolve({ candidates: [chromeCandidate] });
        if (cmd === "collect_import_local") return Promise.resolve(createdSource);
        if (cmd === "collect_source_dry_run") {
          return Promise.resolve({ ok: true, items: [], total_found: 0, new_count: 0, seen_count: 0, error: null });
        }
        return Promise.resolve({ ok: true });
      });

      await userEvent.click(screen.getByTestId("collect-detect-btn"));
      await screen.findByTestId("collect-ghost-chrome:Default");
      await userEvent.click(screen.getByTestId("collect-ghost-import-chrome:Default"));

      expect(await screen.findByText("Open tabs are only recorded after you close them.")).toBeTruthy();
    });
  });

  describe("first-run auto-detect badge (§3b, PLAN-2026-09-04-local-import)", () => {
    const claudeCandidate = {
      key: "claude_prompts",
      kind: "claude_prompts",
      label: "Claude prompts",
      detail: "29 sessions",
      recent_count: 29,
      last_seen_at: null,
      source_id: null,
      config: "{}",
    };

    it("with a pending badge, mounting runs detection first, shows the candidates, then clears the badge", async () => {
      useSettingsStore.setState({ collectDetectSeen: false, collectDetectPending: 4 } as any);
      callMock.mockReset().mockImplementation((cmd: string) => {
        if (cmd === "collect_source_list") return Promise.resolve({ sources: [] });
        if (cmd === "collect_detect_local") return Promise.resolve({ candidates: [claudeCandidate] });
        return Promise.resolve({ ok: true });
      });
      render(<CollectSection />);

      await waitFor(() =>
        expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { collect_detect_seen: true } }),
      );
      // 뱃지가 가리키던 후보가 화면에 먼저 보이고, 그 다음에 뱃지가 지워진다.
      expect(await screen.findByTestId("collect-ghost-claude_prompts")).toBeTruthy();
      await waitFor(() =>
        expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { collect_detect_pending: 0 } }),
      );
      const names = callMock.mock.calls.map((c) => c[0]);
      const clearIdx = callMock.mock.calls.findIndex(
        (c) => c[0] === "settings_set" && (c[1] as any).entries.collect_detect_pending === 0,
      );
      expect(names.indexOf("collect_detect_local")).toBeLessThan(clearIdx);
      expect(useSettingsStore.getState().collectDetectSeen).toBe(true);
      expect(useSettingsStore.getState().collectDetectPending).toBe(0);
    });

    it("keeps the badge when the auto-detection fails (the detect button can retry)", async () => {
      useSettingsStore.setState({ collectDetectSeen: true, collectDetectPending: 2 } as any);
      callMock.mockReset().mockImplementation((cmd: string) => {
        if (cmd === "collect_source_list") return Promise.resolve({ sources: [] });
        if (cmd === "collect_detect_local") return Promise.reject(new Error("boom"));
        return Promise.resolve({ ok: true });
      });
      render(<CollectSection />);

      await waitFor(() => expect(callMock).toHaveBeenCalledWith("collect_detect_local", {}));
      await new Promise((r) => setTimeout(r, 0));
      expect(callMock).not.toHaveBeenCalledWith("settings_set", { entries: { collect_detect_pending: 0 } });
      expect(useSettingsStore.getState().collectDetectPending).toBe(2);
      expect(screen.getByTestId("collect-detect-btn")).toBeTruthy();
    });

    it("does not re-write settings_set when already seen and pending is already 0", async () => {
      useSettingsStore.setState({ collectDetectSeen: true, collectDetectPending: 0 } as any);
      mockList([]);
      render(<CollectSection />);
      await waitFor(() => expect(callMock).toHaveBeenCalledWith("collect_source_list", {}));

      expect(callMock).not.toHaveBeenCalledWith("settings_set", { entries: { collect_detect_seen: true } });
      expect(callMock).not.toHaveBeenCalledWith("settings_set", { entries: { collect_detect_pending: 0 } });
    });

    it("shows the trust hint above the ghost rows once detection has run", async () => {
      mockList([]);
      render(<CollectSection />);
      await waitFor(() => expect(callMock).toHaveBeenCalledWith("collect_source_list", {}));
      callMock.mockImplementation((cmd: string) =>
        cmd === "collect_detect_local" ? Promise.resolve({ candidates: [] }) : Promise.resolve({ sources: [] }),
      );

      await userEvent.click(screen.getByTestId("collect-detect-btn"));

      expect(await screen.findByTestId("collect-detect-trust-hint")).toBeTruthy();
      expect(screen.getByText(/read-only|Nothing has been saved yet/i)).toBeTruthy();
    });
  });

  describe("browser_history kind", () => {
    it("shows the Browser history option and its fields in the create form", async () => {
      mockList([]);
      render(<CollectSection />);
      await userEvent.click(screen.getByTestId("collect-table-add-row"));

      await userEvent.click(screen.getByRole("button", { name: "Source Type" }));
      await userEvent.click(screen.getByRole("option", { name: "Browser history" }));

      expect(screen.getByText("Browser")).toBeTruthy();
      expect(screen.getByText("Profile")).toBeTruthy();
      expect(screen.getByText("Minimum time on page (seconds)")).toBeTruthy();
      expect(screen.getByText("Look back (days)")).toBeTruthy();
      // no URL field for this kind
      expect(screen.queryByText("URL")).toBeNull();
    });

    it("offers Brave, Vivaldi and Whale alongside Chrome and Edge (§TASKS 3, PLAN-2026-09-04-local-import)", async () => {
      mockList([]);
      render(<CollectSection />);
      await userEvent.click(screen.getByTestId("collect-table-add-row"));
      await userEvent.click(screen.getByRole("button", { name: "Source Type" }));
      await userEvent.click(screen.getByRole("option", { name: "Browser history" }));

      await userEvent.click(screen.getByRole("button", { name: "Browser" }));

      expect(screen.getByRole("option", { name: "Chrome" })).toBeTruthy();
      expect(screen.getByRole("option", { name: "Edge" })).toBeTruthy();
      expect(screen.getByRole("option", { name: "Brave" })).toBeTruthy();
      expect(screen.getByRole("option", { name: "Vivaldi" })).toBeTruthy();
      expect(screen.getByRole("option", { name: "Whale" })).toBeTruthy();
    });

    it("serializes browser/profile/min_seconds/backfill_days on save", async () => {
      // ponytail: same fix as the youtube-save-decline test above — this is the other
      // typing-heavy case (5 type/clear round trips) that timed out under full-suite load.
      const user = userEvent.setup({ delay: null });
      mockList([]);
      render(<CollectSection />);
      await user.click(screen.getByTestId("collect-table-add-row"));

      await user.click(screen.getByRole("button", { name: "Source Type" }));
      await user.click(screen.getByRole("option", { name: "Browser history" }));
      await user.type(screen.getByPlaceholderText("e.g. Tech blog"), "My browsing");

      await user.click(screen.getByRole("button", { name: "Browser" }));
      await user.click(screen.getByRole("option", { name: "Edge" }));

      const profileInput = screen.getByPlaceholderText("Default");
      await user.clear(profileInput);
      await user.type(profileInput, "MyProfile");

      const minSecondsInput = screen.getByDisplayValue("15");
      await user.clear(minSecondsInput);
      await user.type(minSecondsInput, "30");

      const backfillInput = screen.getByDisplayValue("7");
      await user.clear(backfillInput);
      await user.type(backfillInput, "14");

      callMock.mockClear();
      callMock.mockResolvedValue({ id: "new_id" });

      await user.click(screen.getByTestId("collect-form-save-btn"));

      await waitFor(
        () =>
          expect(callSilentMock).toHaveBeenCalledWith("collect_source_create", expect.objectContaining({
            kind: "browser_history",
            name: "My browsing",
            config: JSON.stringify({
              browser: "edge",
              profile: "MyProfile",
              min_seconds: 30,
              backfill_days: 14,
              interval_minutes: 60,
            }),
          })),
        { timeout: 5000 },
      );
    });
  });

  describe("claude/codex prompts backfill_days", () => {
    it("shows the backfill days field next to the project filter, defaulting to 14", async () => {
      mockList([]);
      render(<CollectSection />);
      await userEvent.click(screen.getByTestId("collect-table-add-row"));

      await userEvent.click(screen.getByRole("button", { name: "Source Type" }));
      await userEvent.click(screen.getByRole("option", { name: "Claude Prompts" }));

      expect(screen.getByText("Project Filter (Optional)")).toBeTruthy();
      expect(screen.getByText("Look back (days)")).toBeTruthy();
      expect(screen.getByDisplayValue("14")).toBeTruthy();
    });

    it("serializes project and backfill_days on save for claude_prompts", async () => {
      mockList([]);
      render(<CollectSection />);
      await userEvent.click(screen.getByTestId("collect-table-add-row"));

      await userEvent.click(screen.getByRole("button", { name: "Source Type" }));
      await userEvent.click(screen.getByRole("option", { name: "Claude Prompts" }));
      await userEvent.type(screen.getByPlaceholderText("e.g. Tech blog"), "My prompts");

      const backfillInput = screen.getByDisplayValue("14");
      await userEvent.clear(backfillInput);
      await userEvent.type(backfillInput, "30");

      callMock.mockClear();
      callMock.mockResolvedValue({ id: "new_id" });

      await userEvent.click(screen.getByTestId("collect-form-save-btn"));

      await waitFor(() =>
        expect(callSilentMock).toHaveBeenCalledWith("collect_source_create", expect.objectContaining({
          kind: "claude_prompts",
          name: "My prompts",
          config: JSON.stringify({ backfill_days: 30, interval_minutes: 60 }),
        })),
      );
    });
  });

  describe("summary post-process option", () => {
    it("offers the Summary option alongside None and AI Suggest", async () => {
      mockList([]);
      render(<CollectSection />);
      await userEvent.click(screen.getByTestId("collect-table-add-row"));

      // Advanced options is collapsed by default for new sources; open it to access AI Post-Processing
      await userEvent.click(screen.getByTestId("collect-form-advanced-toggle"));

      await userEvent.click(screen.getByRole("button", { name: "AI Post-Processing (Suggest)" }));
      expect(screen.getByRole("option", { name: "Summary" })).toBeTruthy();

      await userEvent.click(screen.getByRole("option", { name: "Summary" }));
      expect(screen.getByText(/Summarizes the day's prompts/)).toBeTruthy();
    });

    it("allows entering and saving a custom post-processing prompt", async () => {
      mockList([]);
      render(<CollectSection />);
      await userEvent.click(screen.getByTestId("collect-table-add-row"));

      // Fill in URL and name
      await userEvent.type(screen.getByPlaceholderText("https://..."), "https://example.com/rss.xml");

      // Expand advanced options
      await userEvent.click(screen.getByTestId("collect-form-advanced-toggle"));

      // Set post-process to summary so AI prompt input is rendered
      await userEvent.click(screen.getByRole("button", { name: "AI Post-Processing (Suggest)" }));
      await userEvent.click(screen.getByRole("option", { name: "Summary" }));

      // Type custom prompt
      const promptInput = screen.getByPlaceholderText(/3-line summary/);
      await userEvent.type(promptInput, "Summarize key architecture trade-offs");

      await userEvent.click(screen.getByTestId("collect-form-save-btn"));

      expect(callSilentMock).toHaveBeenCalledWith("collect_source_create", expect.objectContaining({
        config: expect.stringContaining('"prompt":"Summarize key architecture trade-offs"'),
      }));
    });
  });

  describe("modal category switching & chat session detection (D12)", () => {
    it("switching to chat tab calls collect_detect_chat_sessions once and reuses cache on tab switch", async () => {
      mockList([]);
      callSilentMock.mockReset().mockImplementation((cmd: string) => {
        if (cmd === "collect_detect_chat_sessions") {
          return Promise.resolve({
            sessions: [
              {
                id: "claude:sess1",
                kind: "claude_prompts",
                project: "Brise",
                title: "How to fix freeze",
                last_prompt: "fixed",
                prompt_count: 5,
                last_active_at: "2026-09-14T00:00:00Z",
                relative_time: "1 hour ago",
              },
            ],
          });
        }
        return Promise.resolve({ settings: {} });
      });

      render(<CollectSection />);
      await userEvent.click(screen.getByTestId("collect-table-add-row"));

      // Switch to chat tab
      await userEvent.click(screen.getByTestId("collect-quick-chat-session"));
      await waitFor(() => expect(callSilentMock).toHaveBeenCalledWith("collect_detect_chat_sessions", {}));
      expect(await screen.findByText(/How to fix freeze/)).toBeTruthy();

      const callCountBefore = callSilentMock.mock.calls.filter((c) => c[0] === "collect_detect_chat_sessions").length;
      expect(callCountBefore).toBe(1);

      // Switch to browser tab, then back to chat tab
      await userEvent.click(screen.getByTestId("collect-quick-browser-history"));
      await userEvent.click(screen.getByTestId("collect-quick-chat-session"));

      // Should not call collect_detect_chat_sessions again (cached)
      const callCountAfter = callSilentMock.mock.calls.filter((c) => c[0] === "collect_detect_chat_sessions").length;
      expect(callCountAfter).toBe(1);
      expect(screen.getByText(/How to fix freeze/)).toBeTruthy();
    });

    it("clicking detect button forces re-detection", async () => {
      mockList([]);
      callSilentMock.mockReset().mockImplementation((cmd: string) => {
        if (cmd === "collect_detect_chat_sessions") {
          return Promise.resolve({ sessions: [] });
        }
        return Promise.resolve({ settings: {} });
      });

      render(<CollectSection />);
      await userEvent.click(screen.getByTestId("collect-table-add-row"));
      await userEvent.click(screen.getByTestId("collect-quick-chat-session"));

      await waitFor(() => expect(callSilentMock).toHaveBeenCalledWith("collect_detect_chat_sessions", {}));
      const callCount1 = callSilentMock.mock.calls.filter((c) => c[0] === "collect_detect_chat_sessions").length;
      expect(callCount1).toBe(1);

      // Explicit click on detect button should force reload
      await userEvent.click(screen.getByTestId("collect-modal-detect-btn"));
      await waitFor(() => {
        const count = callSilentMock.mock.calls.filter((c) => c[0] === "collect_detect_chat_sessions").length;
        expect(count).toBe(2);
      });
    });
  });

});
