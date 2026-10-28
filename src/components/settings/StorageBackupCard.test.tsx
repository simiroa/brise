import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { StorageBackupCard, StorageGaugeStrip } from "./StorageBackupCard";
import { useSettingsStore } from "../../stores/settings";
import { useSettingsBusy } from "./settingsBusy";

const callMock = vi.fn();
const callSilentMock = vi.fn();
const onRestored = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

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

const INSPECT_OK = {
  path: "D:/new-location",
  cloud_provider: null,
  writable: true,
  has_existing_data: false,
  free_bytes: 800 * 1024 * 1024 * 1024,
  total_bytes: 1000 * 1024 * 1024 * 1024,
  current_data_bytes: 30 * 1024 * 1024,
};

// 일반 페이지에서 이사 온 저장 공간 게이지·"저장 및 백업" 카드(PLAN-2026-10-24 D6).
describe("StorageBackupCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsBusy.setState({ busy: null });
    mockBrowser = false;
    mockRelaunch.mockReset().mockResolvedValue(undefined);
    mockEmit.mockReset().mockResolvedValue(undefined);
    mockOpenDialog.mockReset();
    const impl = async (cmd: string) => {
      if (cmd === "db_stats") return STATS;
      if (cmd === "backup_auto_status") {
        return { last_backup_at: "2026-07-20T10:00:00Z", interval: "weekly", keep: 3, last_error: null };
      }
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
    useSettingsStore.setState({ uiLang: "ko" } as any);
  });

  it("저장 공간 게이지가 DB·첨부 사용량과 드라이브 여유를 보여 준다", async () => {
    render(<StorageGaugeStrip />);
    await waitFor(() =>
      expect(screen.getByTestId("storage-gauge-breakdown").textContent).toBe("DB 1 MB · 첨부파일 2 MB (이미지 1 MB)"),
    );
    expect(screen.getByTestId("storage-gauge-ratio").textContent).toBe("3 MB · 여유 412.0 GB");
    expect(screen.getByTestId("storage-gauge-bar").getAttribute("role")).toBe("progressbar");
  });

  // 제목은 specs/features/settings.yaml F-ST02 의 covered_by 리터럴과 묶여 있다(check:features)
  it("저장 위치·자동 백업 행이 데이터 관리의 저장 및 백업 카드에 있다", async () => {
    render(<StorageBackupCard onRestored={onRestored} />);

    const card = screen.getByTestId("settings-storage-backup");
    expect(card.contains(screen.getByTestId("settings-data-location"))).toBe(true);
    expect(card.contains(screen.getByTestId("settings-backup-auto"))).toBe(true);
    expect(screen.getByRole("button", { name: "데이터 폴더 열기" })).toBeTruthy();

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("backup_auto_status", {}));
  });

  it("데이터 폴더 열기는 저장 위치 행에 한 번만 있고 카드 머리에는 없다", () => {
    render(<StorageBackupCard onRestored={onRestored} />);
    const row = screen.getByTestId("settings-data-location");
    expect(screen.getAllByTestId("settings-open-data-folder")).toHaveLength(1);
    expect(row.contains(screen.getByTestId("settings-open-data-folder"))).toBe(true);
    expect(row.contains(screen.getByTestId("settings-data-location-change"))).toBe(true);
  });

  it("마지막 백업 시각은 OS 로캘이 아니라 앱 UI 언어로 쓴다", async () => {
    useSettingsStore.setState({ uiLang: "en" } as any);
    render(<StorageBackupCard onRestored={onRestored} />);
    const expected = new Date("2026-07-20T10:00:00Z").toLocaleString("en");
    await waitFor(() => expect(screen.getByTestId("settings-backup-auto").textContent).toContain(expected));
    // 마지막 백업 표시는 이 행 하나뿐이다 — 실패가 없으면 실패 줄은 없다.
    expect(screen.queryByTestId("settings-data-last-backup")).toBeNull();
  });

  it("마지막 자동 백업이 실패했으면 사유와 함께 실패 줄이 선다", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "backup_auto_status"
        ? { last_backup_at: null, interval: "weekly", keep: 3, last_error: "disk full" }
        : {},
    );
    render(<StorageBackupCard onRestored={onRestored} />);
    const line = await screen.findByTestId("settings-data-last-backup");
    expect(line.textContent).toContain("disk full");
  });

  it("'지금 백업'은 backup_auto_run 을 부른다", async () => {
    render(<StorageBackupCard onRestored={onRestored} />);

    fireEvent.click(screen.getByRole("button", { name: "지금 백업" }));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("backup_auto_run", {}));
  });

  // 함정 9: 낙관적 갱신엔 롤백이 짝이다. select 는 고른 값을 즉시 보여주는데 settings_set 이
  // 거절되면 백엔드엔 옛 값이 남아 화면이 데이터에 대해 거짓말한다. call() 은 토스트를 띄운 뒤
  // 재throw 하므로, 잡지 않으면 미처리 rejection 으로도 샜다(함정 8).
  it("자동 백업 주기 저장이 거절되면 select 가 옛 값으로 되돌아간다", async () => {
    callMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "backup_auto_status") {
        return { last_backup_at: null, interval: "weekly", keep: 3, last_error: null };
      }
      if (cmd === "settings_set" && args?.entries?.backup_auto_interval) throw new Error("nope");
      return {};
    });
    render(<StorageBackupCard onRestored={onRestored} />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("backup_auto_status", {}));

    const trigger = screen.getByLabelText("자동 백업");
    expect(trigger.textContent).toContain("매주");

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByText("매일"));

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { backup_auto_interval: "daily" } }),
    );
    await waitFor(() => expect(screen.getByLabelText("자동 백업").textContent).toContain("매주"));
  });

  // ── 저장 위치(PLAN-2026-09-28-onboarding-rebuild.md §6) — "데이터 폴더 열기" 옆의 행 ──
  describe("저장 위치", () => {
    it("현재 위치를 보여준다", async () => {
      render(<StorageBackupCard onRestored={onRestored} />);
      await waitFor(() => expect(callSilentMock).toHaveBeenCalledWith("data_location_get"));
      expect(screen.getByTestId("settings-data-location").textContent).toContain("brise");
    });

    it("위치 변경 -> 폴더 선택 -> 점검 성공 시 확인창이 뜬다", async () => {
      mockOpenDialog.mockResolvedValue("D:/new-location");
      callMock.mockImplementation(async (cmd: string) => (cmd === "data_location_inspect" ? INSPECT_OK : {}));
      render(<StorageBackupCard onRestored={onRestored} />);

      fireEvent.click(screen.getByTestId("settings-data-location-change"));
      await waitFor(() =>
        expect(callMock).toHaveBeenCalledWith("data_location_inspect", { path: "D:/new-location" }),
      );
      expect(await screen.findByTestId("settings-data-location-space-bar")).toBeTruthy();
    });

    // 이 창(설정)은 별도 OS 창이라 apply 를 직접 부르지 않는다 — main 창에 이동을 요청만 한다
    // (같은 관문 lib/dataMove.ts::runDataMove, "onboarding-restart-requested" 와 같은 이중 채널).
    // 실제 이동/재시작은 App.tsx 쪽 테스트가 본다.
    it("확인창의 위치 변경을 누르면 main 창에 이동을 요청할 뿐, apply 를 직접 부르지 않는다", async () => {
      mockOpenDialog.mockResolvedValue("D:/new-location");
      callMock.mockImplementation(async (cmd: string) => (cmd === "data_location_inspect" ? INSPECT_OK : {}));
      const windowEvents: CustomEvent[] = [];
      const onMoveRequest = (e: Event) => windowEvents.push(e as CustomEvent);
      window.addEventListener("data-move-request", onMoveRequest);
      try {
        render(<StorageBackupCard onRestored={onRestored} />);

        fireEvent.click(screen.getByTestId("settings-data-location-change"));
        await screen.findByTestId("settings-data-location-space-bar");
        fireEvent.click(screen.getByTestId("settings-data-location-confirm"));

        await waitFor(() => expect(mockEmit).toHaveBeenCalledWith("data-move-request", { path: "D:/new-location" }));
        expect(windowEvents).toHaveLength(1);
        expect(windowEvents[0].detail).toEqual({ path: "D:/new-location" });
        expect(callMock).not.toHaveBeenCalledWith("data_location_apply", expect.anything());
        expect(mockRelaunch).not.toHaveBeenCalled();
        // 요청을 보내면 확인창은 바로 닫힌다 — 진행·실패는 main 창이 보여준다(실패 시 잠긴 채 남지 않게).
        await waitFor(() => expect(screen.queryByTestId("settings-data-location-confirm")).toBeNull());
      } finally {
        window.removeEventListener("data-move-request", onMoveRequest);
      }
    });

    it("점검이 쓰기 불가를 보고하면 확인창을 열지 않는다", async () => {
      mockOpenDialog.mockResolvedValue("D:/locked");
      callMock.mockImplementation(async (cmd: string) =>
        cmd === "data_location_inspect"
          ? { ...INSPECT_OK, path: "D:/locked", writable: false, free_bytes: null, total_bytes: null, current_data_bytes: 0 }
          : {},
      );
      render(<StorageBackupCard onRestored={onRestored} />);

      fireEvent.click(screen.getByTestId("settings-data-location-change"));
      await waitFor(() => expect(callMock).toHaveBeenCalledWith("data_location_inspect", { path: "D:/locked" }));
      expect(screen.queryByTestId("settings-data-location-space-bar")).toBeNull();
      expect(mockRelaunch).not.toHaveBeenCalled();
    });
  });

  describe("복구 목록 복원", () => {
    const entries = [
      { name: "auto-2", path: "C:/b/auto-2.zip", created_at: "2026-07-20T10:00:00Z", size_bytes: 3 * 1024 * 1024 },
      { name: "auto-1", path: "C:/b/auto-1.zip", created_at: "2026-07-13T10:00:00Z", size_bytes: 2 * 1024 * 1024 },
    ];
    const baseImpl = async (cmd: string, args?: unknown) => {
      if (cmd === "backup_auto_status") return { last_backup_at: "2026-07-20T10:00:00Z", interval: "weekly", keep: 3, last_error: null };
      if (cmd === "backup_auto_list") return args && (args as { limit: number }).limit === 3 ? entries : [];
      if (cmd === "data_location_get") return { root: "C:/x", attachments_dir: "", backups_dir: "", is_default: true, split: false };
      return {};
    };
    const restoreCalls = () => callMock.mock.calls.filter((c) => c[0] === "backup_restore");

    it("복구 목록은 보관 개수만큼 가져오고, 복구는 확인창을 거쳐 backup_restore 로 간다", async () => {
      callMock.mockImplementation(async (cmd: string, args?: unknown) =>
        cmd === "backup_restore" ? { backup_path: "C:/b/before-restore.zip" } : baseImpl(cmd, args),
      );
      callSilentMock.mockImplementation(baseImpl);
      render(<StorageBackupCard onRestored={onRestored} />);
      await waitFor(() => expect(screen.getAllByTestId("settings-backup-list-row")).toHaveLength(2));
      expect(callSilentMock).toHaveBeenCalledWith("backup_auto_list", { limit: 3 });

      fireEvent.click(screen.getAllByTestId("settings-backup-restore")[0]);
      expect(callMock).not.toHaveBeenCalledWith("backup_restore", expect.anything());
      fireEvent.click(screen.getByTestId("settings-backup-restore-confirm"));
      await waitFor(() =>
        expect(callMock).toHaveBeenCalledWith("backup_restore", { zip_path: "C:/b/auto-2.zip", confirm: "RESTORE" }),
      );
      // 안전 스냅샷 경로는 데이터 관리의 복원과 같은 안내(DataManagementSection 이 쥔 다이얼로그)로 넘어간다.
      await waitFor(() => expect(onRestored).toHaveBeenCalledWith("C:/b/before-restore.zip"));
      expect(screen.queryByTestId("settings-backup-restore-confirm")).toBeNull();
    });

    it("도는 동안 settingsBusy 가 restore 로 켜져 다른 단추를 막고, 끝나면 풀린다", async () => {
      let release!: (v: unknown) => void;
      callMock.mockImplementation((cmd: string, args?: unknown) =>
        cmd === "backup_restore" ? new Promise((r) => (release = r)) : baseImpl(cmd, args),
      );
      callSilentMock.mockImplementation(baseImpl);
      render(<StorageBackupCard onRestored={onRestored} />);
      await waitFor(() => expect(screen.getAllByTestId("settings-backup-list-row")).toHaveLength(2));
      fireEvent.click(screen.getAllByTestId("settings-backup-restore")[0]);
      fireEvent.click(screen.getByTestId("settings-backup-restore-confirm"));

      await waitFor(() => expect(useSettingsBusy.getState().busy).toBe("restore"));
      expect((screen.getByTestId("settings-backup-restore-confirm") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getAllByTestId("settings-backup-restore")[0] as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "지금 백업" }) as HTMLButtonElement).disabled).toBe(true);
      // 도는 중에 다시 눌러도 두 번 부르지 않는다.
      fireEvent.click(screen.getByTestId("settings-backup-restore-confirm"));
      expect(restoreCalls()).toHaveLength(1);

      release({ backup_path: "C:/b/before-restore.zip" });
      await waitFor(() => expect(useSettingsBusy.getState().busy).toBeNull());
      expect(onRestored).toHaveBeenCalledWith("C:/b/before-restore.zip");
    });

    it("복원이 실패하면 busy 가 풀리고, 확인창은 열려 있고, 안내로 넘어가지 않는다", async () => {
      callMock.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === "backup_restore") throw new Error("zip broken");
        return baseImpl(cmd, args);
      });
      callSilentMock.mockImplementation(baseImpl);
      render(<StorageBackupCard onRestored={onRestored} />);
      await waitFor(() => expect(screen.getAllByTestId("settings-backup-list-row")).toHaveLength(2));
      fireEvent.click(screen.getAllByTestId("settings-backup-restore")[0]);
      fireEvent.click(screen.getByTestId("settings-backup-restore-confirm"));

      await waitFor(() => expect(restoreCalls()).toHaveLength(1));
      await waitFor(() => expect(useSettingsBusy.getState().busy).toBeNull());
      expect(onRestored).not.toHaveBeenCalled();
      const confirm = screen.getByTestId("settings-backup-restore-confirm") as HTMLButtonElement;
      expect(confirm.disabled).toBe(false); // 재시도 가능
    });

    it("다른 되돌릴 수 없는 작업이 이미 돌고 있으면 복원 단추가 막혀 backup_restore 를 부르지 않는다", async () => {
      callMock.mockImplementation(baseImpl);
      callSilentMock.mockImplementation(baseImpl);
      render(<StorageBackupCard onRestored={onRestored} />);
      await waitFor(() => expect(screen.getAllByTestId("settings-backup-list-row")).toHaveLength(2));
      act(() => useSettingsBusy.getState().setBusy("import"));
      expect((screen.getAllByTestId("settings-backup-restore")[0] as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getAllByTestId("settings-backup-restore")[0]);
      expect(screen.queryByTestId("settings-backup-restore-confirm")).toBeNull();
      expect(restoreCalls()).toHaveLength(0);
      act(() => useSettingsBusy.getState().setBusy(null));
    });
  });

  it("용량 알림 한도를 고르면 settings_set 으로 저장되고, 게이지 분모가 한도로 바뀐다", async () => {
    useSettingsStore.setState({ storageAlertGb: 5 } as any);
    render(<StorageGaugeStrip />);
    await waitFor(() => expect(screen.getByTestId("storage-gauge-ratio").textContent).toContain("3 MB / 5.0 GB"));
  });
});
