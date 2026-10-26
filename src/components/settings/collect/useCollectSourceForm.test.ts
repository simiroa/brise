import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSettingsStore } from "../../../stores/settings";
import { t } from "../../../i18n/t";
import type { CollectSource } from "../../../lib/commands.gen";
import { DEFAULT_FORM, useCollectSourceForm } from "./useCollectSourceForm";

const callMock = vi.fn();
const callSilentMock = vi.fn();
const emitNoticeMock = vi.fn();
vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
}));

const reportFallbackMock = vi.fn();
vi.mock("../../../lib/diag", () => ({ reportFallback: (...args: unknown[]) => reportFallbackMock(...args) }));

const askMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: (...args: unknown[]) => askMock(...args) }));

function setup(onSaved = vi.fn().mockResolvedValue(undefined)) {
  const hook = renderHook(() => useCollectSourceForm(onSaved));
  return { ...hook, onSaved };
}

// 폼 상태를 통째로 덮어 쓰는 헬퍼 — 입력 UI 없이 saveForm 의 분기만 본다.
function fill(result: { current: ReturnType<typeof useCollectSourceForm> }, patch: Partial<typeof DEFAULT_FORM>) {
  act(() => result.current.setFormState((prev) => ({ ...prev, ...patch })));
}

const baseSource = {
  id: "s1",
  kind: "rss",
  name: "Feed",
  config: "{}",
  enabled: true,
} as unknown as CollectSource;

describe("useCollectSourceForm", () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ ok: true });
    callSilentMock.mockReset().mockResolvedValue({ installed: true });
    reportFallbackMock.mockReset();
    emitNoticeMock.mockReset();
    askMock.mockReset();
    useSettingsStore.setState({ uiLang: "en" } as any);
  });

  describe("openCreateForm / closeForm", () => {
    it("기본값으로 열고, 닫으면 formOpen 만 내린다", () => {
      const { result } = setup();
      expect(result.current.formOpen).toBe(false);

      act(() => result.current.openCreateForm());
      expect(result.current.formOpen).toBe(true);
      expect(result.current.formState).toEqual(DEFAULT_FORM);
      expect(result.current.formError).toBeNull();

      act(() => result.current.closeForm());
      expect(result.current.formOpen).toBe(false);
    });
  });

  describe("openEditForm", () => {
    it("config JSON 에서 url·project·browser·profile·min_seconds·backfill_days·prompt 를 읽는다", () => {
      const { result } = setup();
      act(() =>
        result.current.openEditForm({
          ...baseSource,
          kind: "browser_history",
          config: JSON.stringify({ browser: "edge", profile: "P2", min_seconds: 20, backfill_days: 3, url: "u", project: "p", prompt: "pp" }),
        } as CollectSource),
      );
      expect(result.current.formOpen).toBe(true);
      expect(result.current.formState).toMatchObject({
        id: "s1",
        kind: "browser_history",
        url: "u",
        project: "p",
        browser: "edge",
        profile: "P2",
        minSeconds: "20",
        backfillDays: "3",
        postProcessPrompt: "pp",
      });
    });

    it("config 에 backfill_days 가 없으면 browser_history 는 7, 그 밖은 14 로 보인다", () => {
      const { result } = setup();
      act(() => result.current.openEditForm({ ...baseSource, kind: "browser_history" } as CollectSource));
      expect(result.current.formState.backfillDays).toBe("7");
      act(() => result.current.openEditForm({ ...baseSource, kind: "claude_prompts" } as CollectSource));
      expect(result.current.formState.backfillDays).toBe("14");
    });

    it("기본값에서 벗어난 고급 옵션이 하나라도 있으면 고급 영역을 펼친 채로 연다", () => {
      const { result } = setup();
      act(() => result.current.openEditForm(baseSource));
      expect(result.current.formState.advancedOpen).toBe(false);
      expect(result.current.formState.intervalMinutes).toBe("60");

      for (const extra of [
        { dry_run: true },
        { target_folder_id: "f1" },
        { interval_minutes: 180 },
        { post_process: "suggest" },
        { post_process_model: "m" },
        { config: JSON.stringify({ prompt: "x" }) },
      ]) {
        act(() => result.current.openEditForm({ ...baseSource, ...extra } as unknown as CollectSource));
        expect(result.current.formState.advancedOpen).toBe(true);
      }
    });

    it("알 수 없는 post_process 는 none 으로, 깨진 config 는 기본값으로 연다", () => {
      const { result } = setup();
      act(() =>
        result.current.openEditForm({ ...baseSource, post_process: "weird", config: "{oops" } as unknown as CollectSource),
      );
      expect(result.current.formState.postProcess).toBe("none");
      expect(result.current.formState.url).toBe("");
    });
  });

  // 현재 판정 그대로를 못 박는 특성화 테스트다 — URL 판정 통합(오너 결정 대기) 전에 동작이 바뀌면 여기서 걸린다.
  describe("handleUrlChange (신규 소스의 kind·이름 자동 판정)", () => {
    it("유튜브 영상 URL 은 youtube, 채널 URL 은 youtube_channel", () => {
      const { result } = setup();
      act(() => result.current.openCreateForm());
      act(() => result.current.handleUrlChange("https://www.youtube.com/watch?v=abc"));
      expect(result.current.formState.kind).toBe("youtube");
      act(() => result.current.handleUrlChange("https://www.youtube.com/@someone"));
      expect(result.current.formState.kind).toBe("youtube_channel");
    });

    it(".xml/.rss/.atom 확장자나 /feed·/rss 경로는 rss", () => {
      const { result } = setup();
      act(() => result.current.openCreateForm());
      fill(result, { kind: "web" });
      act(() => result.current.handleUrlChange("https://x.com/a.xml"));
      expect(result.current.formState.kind).toBe("rss");
      fill(result, { kind: "web" });
      act(() => result.current.handleUrlChange("https://x.com/feed"));
      expect(result.current.formState.kind).toBe("rss");
    });

    it("일반 http URL 은 rss 는 유지하고, youtube 류에서 넘어오면 web 으로 바꾼다", () => {
      const { result } = setup();
      act(() => result.current.openCreateForm());
      act(() => result.current.handleUrlChange("https://x.com/page"));
      expect(result.current.formState.kind).toBe("rss");
      fill(result, { kind: "youtube" });
      act(() => result.current.handleUrlChange("https://x.com/page"));
      expect(result.current.formState.kind).toBe("web");
    });

    it("이름이 비어 있으면 호스트(www 제외)로 채우고, 이미 이름이 있으면 건드리지 않는다", () => {
      const { result } = setup();
      act(() => result.current.openCreateForm());
      act(() => result.current.handleUrlChange("https://www.example.com/x"));
      expect(result.current.formState.name).toBe("example.com");
      fill(result, { name: "Mine" });
      act(() => result.current.handleUrlChange("https://other.com/x"));
      expect(result.current.formState.name).toBe("Mine");
    });

    it("수정 중(id 있음)에는 url 만 바뀌고 kind·name 은 그대로다", () => {
      const { result } = setup();
      act(() => result.current.openEditForm({ ...baseSource, name: "" } as CollectSource));
      act(() => result.current.handleUrlChange("https://www.youtube.com/watch?v=abc"));
      expect(result.current.formState.url).toBe("https://www.youtube.com/watch?v=abc");
      expect(result.current.formState.kind).toBe("rss");
      expect(result.current.formState.name).toBe("");
    });
  });

  describe("saveForm", () => {
    it("이름이 비면 오류를 세우고 IPC 를 부르지 않는다", async () => {
      const { result, onSaved } = setup();
      act(() => result.current.openCreateForm());
      await act(() => result.current.saveForm());
      expect(result.current.formError).toBe(t("settings.collect_required_field", { field: t("settings.collect_source_name") }));
      expect(callSilentMock).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled();
    });

    it("url 이 필요한 kind 에서 url 이 비면 url 필수 오류", async () => {
      const { result } = setup();
      act(() => result.current.openCreateForm());
      fill(result, { name: "N" });
      await act(() => result.current.saveForm());
      expect(result.current.formError).toBe(t("settings.collect_required_field", { field: t("settings.collect_url_label") }));
      expect(callSilentMock).not.toHaveBeenCalled();
    });

    it("새 rss 소스는 collect_source_create 로 저장하고 알린 뒤 닫고 onSaved 를 부른다", async () => {
      const { result, onSaved } = setup();
      act(() => result.current.openCreateForm());
      fill(result, { name: " Tech ", url: " https://t.example/rss " });
      await act(() => result.current.saveForm());

      expect(callSilentMock).toHaveBeenCalledWith("collect_source_create", {
        kind: "rss",
        name: "Tech",
        config: JSON.stringify({ url: "https://t.example/rss", interval_minutes: 60 }),
        dry_run: false,
        show_in_briefing: true,
        target_folder_id: null,
        post_process: "none",
        post_process_model: null,
        interval_minutes: 60,
      });
      expect(emitNoticeMock).toHaveBeenCalledWith(t("settings.collect_add_done"));
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(result.current.formOpen).toBe(false);
      expect(result.current.formSaving).toBe(false);
    });

    it("수정(id 있음)은 collect_source_update 로 id 와 함께 보낸다(kind 는 보내지 않는다)", async () => {
      const { result } = setup();
      act(() => result.current.openEditForm({ ...baseSource, config: JSON.stringify({ url: "https://a/f.xml" }) } as CollectSource));
      await act(() => result.current.saveForm());

      expect(callSilentMock).toHaveBeenCalledWith("collect_source_update", expect.objectContaining({ id: "s1", name: "Feed" }));
      expect(callSilentMock).not.toHaveBeenCalledWith("collect_source_create", expect.anything());
      // 수정은 "추가했습니다"가 아니다.
      expect(emitNoticeMock).toHaveBeenCalledWith(t("settings.collect_save_done"));
      expect(emitNoticeMock).not.toHaveBeenCalledWith(t("settings.collect_add_done"));
    });

    it("수정은 폼이 모르는 config 키를 지우지 않고, 비운 칸의 키만 걷어 낸다", async () => {
      const { result } = setup();
      act(() =>
        result.current.openEditForm({
          ...baseSource,
          config: JSON.stringify({ url: "https://a/f.xml", prompt: "old", etag: "W/1", custom: { a: 1 } }),
        } as CollectSource),
      );
      fill(result, { postProcessPrompt: "" });
      await act(() => result.current.saveForm());

      const args = callSilentMock.mock.calls.find((c) => c[0] === "collect_source_update")?.[1] as { config: string };
      const saved = JSON.parse(args.config);
      expect(saved).toEqual({ url: "https://a/f.xml", interval_minutes: 60, etag: "W/1", custom: { a: 1 } });
    });

    it("저장된 config 를 읽지 못하면 진단에 남기고, 저장 때 config 를 덮어쓰지 않는다", async () => {
      const { result } = setup();
      act(() => result.current.openEditForm({ ...baseSource, config: "{oops" } as CollectSource));
      expect(reportFallbackMock).toHaveBeenCalledWith("collect", "source_config_unparseable", expect.stringContaining("s1"));
      expect(result.current.formError).toBe(t("settings.collect_config_unreadable"));

      fill(result, { url: "https://new/f.xml" });
      await act(() => result.current.saveForm());
      const args = callSilentMock.mock.calls.find((c) => c[0] === "collect_source_update")?.[1] as Record<string, unknown>;
      expect(args.config).toBeUndefined();
      expect(args.name).toBe("Feed");
    });

    it("브리핑에 표시: 기본 켜짐으로 보내고, 끈 소스는 편집 폼에서 꺼진 채 열려 update 에 false 를 보낸다", async () => {
      const { result } = setup();
      act(() => result.current.openEditForm({ ...baseSource, config: JSON.stringify({ url: "https://a/f.xml" }), show_in_briefing: false } as CollectSource));
      expect(result.current.formState.showInBriefing).toBe(false);
      expect(result.current.formState.advancedOpen).toBe(true); // 토글이 보이도록 고급 영역을 연다
      await act(() => result.current.saveForm());
      expect(callSilentMock).toHaveBeenCalledWith("collect_source_update", expect.objectContaining({ id: "s1", show_in_briefing: false }));

      // 토글을 켜면 true 로 저장된다.
      fill(result, { showInBriefing: true });
      await act(() => result.current.saveForm());
      expect(callSilentMock).toHaveBeenLastCalledWith("collect_source_update", expect.objectContaining({ show_in_briefing: true }));
    });

    it("youtube_channel 은 채널 URL 을 피드로 해석해 kind='rss' 로 만든다", async () => {
      callSilentMock.mockImplementation((cmd: string) =>
        cmd === "collect_resolve_youtube_channel"
          ? Promise.resolve({ feed_url: "https://f/x" })
          : Promise.resolve({ ok: true, installed: true }),
      );
      const { result } = setup();
      act(() => result.current.openCreateForm());
      fill(result, { kind: "youtube_channel", name: "Ch", url: "https://www.youtube.com/@zz" });
      await act(() => result.current.saveForm());

      expect(callSilentMock).toHaveBeenCalledWith("collect_resolve_youtube_channel", { url: "https://www.youtube.com/@zz" });
      expect(callSilentMock).toHaveBeenCalledWith(
        "collect_source_create",
        expect.objectContaining({ kind: "rss", config: JSON.stringify({ url: "https://f/x" }) }),
      );
    });

    it("yt-dlp 설치를 거절하면 저장을 멈춘다(드라이런 소스는 게이트를 타지 않는다)", async () => {
      callSilentMock.mockResolvedValue({ installed: false });
      askMock.mockResolvedValue(false);
      const { result } = setup();
      act(() => result.current.openCreateForm());
      fill(result, { kind: "youtube", name: "V", url: "https://www.youtube.com/watch?v=a" });
      await act(() => result.current.saveForm());
      expect(askMock).toHaveBeenCalled();
      expect(callSilentMock).not.toHaveBeenCalledWith("collect_source_create", expect.anything());

      askMock.mockClear();
      fill(result, { dryRun: true });
      await act(() => result.current.saveForm());
      expect(askMock).not.toHaveBeenCalled();
      expect(callSilentMock).toHaveBeenCalledWith("collect_source_create", expect.objectContaining({ dry_run: true }));
    });

    it("저장이 실패하면 오류 문구를 세우고 폼은 열어 둔 채 saving 을 푼다", async () => {
      callSilentMock.mockRejectedValue(new Error("upd fail"));
      const { result, onSaved } = setup();
      act(() => result.current.openCreateForm());
      fill(result, { name: "N", url: "https://a/rss" });
      await act(() => result.current.saveForm());

      expect(result.current.formError).toBe("upd fail");
      // 오류는 폼 안 한 곳에서만 — 토스트를 겹쳐 띄우지 않는다(callSilent).
      expect(callMock).not.toHaveBeenCalled();
      expect(emitNoticeMock).not.toHaveBeenCalled();
      expect(result.current.formOpen).toBe(true);
      expect(result.current.formSaving).toBe(false);
      expect(onSaved).not.toHaveBeenCalled();
    });
  });

  describe("detectChatSessions", () => {
    const sessions = [{ id: "c1", kind: "claude_prompts", project: "P", title: "T", last_prompt: "", prompt_count: 1, last_active_at: null, relative_time: "" }];

    it("한 번 감지하면 캐시를 쓰고, force 나 openCreateForm 이후에만 다시 부른다", async () => {
      callSilentMock.mockResolvedValue({ sessions });
      const { result } = setup();

      await act(() => result.current.detectChatSessions(false));
      expect(result.current.detectedSessions).toEqual(sessions);
      expect(result.current.detectedSessionsDone).toBe(true);

      await act(() => result.current.detectChatSessions(false));
      expect(callSilentMock).toHaveBeenCalledTimes(1);

      await act(() => result.current.detectChatSessions(true));
      expect(callSilentMock).toHaveBeenCalledTimes(2);

      act(() => result.current.openCreateForm());
      await act(() => result.current.detectChatSessions(false));
      expect(callSilentMock).toHaveBeenCalledTimes(3);
    });

    it("감지가 실패해도 빈 목록으로 완료 처리한다", async () => {
      callSilentMock.mockRejectedValue(new Error("x"));
      const { result } = setup();
      await act(() => result.current.detectChatSessions(false));
      expect(result.current.detectedSessions).toEqual([]);
      expect(result.current.detectedSessionsDone).toBe(true);
      expect(result.current.detectingSessions).toBe(false);
    });
  });
});
