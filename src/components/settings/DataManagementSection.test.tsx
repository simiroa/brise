import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettingsStore } from "../../stores/settings";
import { useNotesStore } from "../../stores/notes";
import { useAiStore } from "../../stores/ai";
import { DataManagementSection } from "./DataManagementSection";
import { useSettingsBusy } from "./settingsBusy";

const callMock = vi.fn();
const emitNoticeMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

const openMock = vi.fn();
const saveMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
  save: (...args: unknown[]) => saveMock(...args),
}));

function baseProps() {
  return { onClose: vi.fn() };
}

// 설정 창 전체가 공유하는 busy 슬롯(모듈 수준 zustand) — 앞 테스트에서 돌던 작업이 새지 않게 비운다.
beforeEach(() => {
  useSettingsBusy.setState({ busy: null });
});

describe("DataManagementSection — §2.5 AI batch-organize offer", () => {
  beforeEach(() => {
    callMock.mockReset();
    openMock.mockReset();
    useNotesStore.setState({
      inboxId: "inbox1",
      loadTree: vi.fn().mockResolvedValue(undefined),
      noteIndex: new Map(),
    } as any);
    useAiStore.setState({ ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);

    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "migration_import_markdown") {
        return { imported: 3, skipped: 0, note_ids: ["n1", "n2", "n3"] };
      }
      if (cmd === "db_stats") {
        return { note_count: 3, source_count: 0, db_size_bytes: 1024 };
      }
      return {};
    });
  });

  // Import sources now live behind the "Import from another app" dropdown menu (Données tile
  // redesign) instead of three stacked buttons — open it first, then click the source item.
  // findByRole("button"), not findByText: W2-ⓓ 가 "더보기" 행에 붙인 힌트 문구가 HintBadge 의
  // 시각적 숨김 span 으로도 렌더되는데 그 문장이 "…as Markdown…" 을 품어 /markdown/i 에 함께
  // 걸렸다(그 자리에서 이 두 테스트가 "Found multiple elements" 로 죽어 있었다). 우리가 누르려는
  // 것은 언제나 메뉴 항목 **버튼**이다.
  const openImportMenuAndPick = async (sourceLabel: RegExp) => {
    await userEvent.click(screen.getByRole("button", { name: /more/i }));
    await userEvent.click(await screen.findByRole("button", { name: /import from another app$/i }));
    await userEvent.click(await screen.findByRole("button", { name: sourceLabel }));
  };

  it("stays inert (no offer banner) when AI is disabled, even after a successful import", async () => {
    useSettingsStore.setState({ aiEnabled: false } as any);
    useAiStore.setState({ aiReachable: true } as any);
    openMock.mockResolvedValue("/some/dir");

    render(<DataManagementSection {...baseProps()} />);
    await openImportMenuAndPick(/markdown/i);

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("migration_import_markdown", expect.anything()));
    // Give any (absent) state update a tick to land, then assert the offer never appears.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("button", { name: /organize with ai/i })).toBeNull();
  });

  it("offers AI batch-organize with the right count after a successful import when AI is enabled+reachable", async () => {
    useSettingsStore.setState({ aiEnabled: true } as any);
    useAiStore.setState({ aiReachable: true } as any);
    openMock.mockResolvedValue("/some/dir");

    render(<DataManagementSection {...baseProps()} />);
    await openImportMenuAndPick(/markdown/i);

    const offerBtn = await screen.findByRole("button", { name: "Organize with AI (3)" });
    await userEvent.click(offerBtn);

    // Pre-flight confirm: shows the note count / expected AI call count before running.
    expect(await screen.findByText(/3 AI calls/)).toBeTruthy();
  });
});

describe("DataManagementSection — 위험 작업 전용 페이지 (PLAN-2026-09-12 D7)", () => {
  beforeEach(() => {
    callMock.mockReset();
    openMock.mockReset();
    saveMock.mockReset();
    useNotesStore.setState({
      inboxId: "inbox1",
      loadTree: vi.fn().mockResolvedValue(undefined),
      noteIndex: new Map(),
    } as any);
    useAiStore.setState({ ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
    callMock.mockImplementation(async () => ({}));
  });

  // PLAN-2026-10-24 D6: 저장 공간 게이지와 "저장 및 백업" 카드가 일반에서 이 페이지로 이사 왔다.
  // (2026-09-12 D7 로 한 번 일반으로 갔던 통계 타일은 일반에 그대로 남는다 — 여기엔 타일이 없다.)
  it("저장 공간 게이지와 저장 및 백업 카드가 데이터 페이지에 있다", async () => {
    render(<DataManagementSection {...baseProps()} />);

    expect(screen.getByTestId("storage-gauge")).toBeTruthy();
    expect(screen.getByTestId("settings-storage-backup")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open data folder" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back up now" })).toBeTruthy();
    expect(screen.queryByText("Days active")).toBeNull();
    expect(screen.queryByText(/Original file handling/)).toBeNull();
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("db_stats"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("backup_auto_status", {}));
  });

  // 위에서 아래로: 게이지 → 저장 및 백업(첨부 저장은 2026-10-27 첨부파일 페이지로 이사) → 데이터 이동 → 위험 작업.
  it("카드 순서: 게이지가 맨 위, 저장 및 백업 다음, 위험 작업이 맨 아래", () => {
    const { container } = render(<DataManagementSection {...baseProps()} />);
    expect(container.firstElementChild).toBe(screen.getByTestId("storage-gauge"));
    const order = ["storage-gauge", "settings-storage-backup", "settings-danger-zone"].map(
      (id) => screen.getByTestId(id),
    );
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  // 중복 정리(D6): "마지막 백업" 표시는 저장 및 백업 카드의 자동 백업 행 하나뿐이다 —
  // 위험 작업 배너에 있던 같은 캡션은 뺐다. 실패 줄은 사유가 다른 사실이라 카드에 따로 선다.
  it("마지막 백업 시각은 저장 및 백업 카드 한 곳에만 나오고 위험 작업 배너에는 없다", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "backup_auto_status"
        ? { last_backup_at: "2026-09-14T10:00:00Z", interval: "weekly", keep: 3, last_error: null }
        : {},
    );
    render(<DataManagementSection {...baseProps()} />);

    await waitFor(() => expect(screen.getByTestId("settings-backup-auto").textContent).toMatch(/Last backup/));
    expect(screen.getAllByText(/Last backup/)).toHaveLength(1);
    expect(screen.getByTestId("settings-danger-zone").textContent).not.toMatch(/Last backup/);
    expect(screen.queryByTestId("settings-data-last-backup")).toBeNull();
  });

  it("backup_auto_status 조회가 실패해도 위험 작업 버튼 스트립은 그대로다", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "backup_auto_status") throw new Error("boom");
      return {};
    });
    render(<DataManagementSection {...baseProps()} />);

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("backup_auto_status", {}));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("settings-data-last-backup")).toBeNull();
    expect(screen.getByTestId("settings-reset-db")).toBeTruthy();
  });

  // 휴지통 행 제거(owner, 2026-07-29): 노트 트리 헤더의 휴지통 버튼이 같은 TrashModal 을 열므로
  // 설정의 행은 중복이었다. 트리 진입점의 회귀 커버리지는
  // leftpanel/notetree/TreeHeaderActions.test.tsx ("clicking the trash button flips the ui store's
  // trashOpen") 가 계속 들고 있다.
  // 설정 창은 별도 웹뷰라 노트북 스토어가 load 되지 않는다 — 활성 노트북은 설정 스토어에서 읽어야
  // 내보내기가 살아 있다(2026-10-21 실앱: 노트북 스토어를 읽어 영구 비활성이었다).
  it("노트북 내보내기는 설정 스토어의 활성 노트북으로 켜진다", () => {
    useSettingsStore.setState({ activeWorkspaceId: "ws1" } as any);
    const { unmount } = render(<DataManagementSection {...baseProps()} />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Export notebook…" }).disabled).toBe(false);
    unmount();

    useSettingsStore.setState({ activeWorkspaceId: null } as any);
    render(<DataManagementSection {...baseProps()} />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Export notebook…" }).disabled).toBe(true);
  });

  it("no longer offers a trash row (the tree header owns that entry point)", () => {
    render(<DataManagementSection {...baseProps()} />);

    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    expect(screen.queryByText("Trash")).toBeNull();
  });

  // D7: "고급" 팝오버가 사라지고 세 단추가 펼쳐진 스트립으로 선다 — 되돌릴 수 없는 동작이라
  // 아이콘만이 아니라 글자로 이름을 말한다.
  it("백업·복원·초기화가 '고급' 메뉴 없이 글자 단추로 펼쳐져 있다", () => {
    render(<DataManagementSection {...baseProps()} />);

    expect(screen.queryByText("Advanced")).toBeNull();
    expect(screen.getByTestId("settings-file-backup").textContent).toBe("File backup…");
    expect(screen.getByTestId("settings-restore").textContent).toBe("Restore (full)…");
    expect(screen.getByTestId("settings-reset-db").textContent).toBe("Reset database");
    // 되돌릴 수 없는 초기화만 danger 로 갈린다.
    expect(screen.getByTestId("settings-reset-db").className).toContain("btn-danger");
    expect(screen.getByTestId("settings-file-backup").className).not.toContain("btn-danger");
    expect(screen.getByTestId("settings-restore").className).not.toContain("btn-danger");
  });

  it("첨부 저장 카드는 첨부파일 페이지로 갔고, 위험 작업은 카드 안에 있다", () => {
    render(<DataManagementSection {...baseProps()} />);
    expect(screen.queryByTestId("settings-attachment-storage")).toBeNull();
    expect(screen.getByTestId("settings-danger-zone").closest(".card")).not.toBeNull();
  });

  it("백업이 도는 동안 두 번째 클릭은 무시되고 다른 위험 단추도 잠긴다", async () => {
    let resolveSave: (v: string) => void = () => {};
    saveMock.mockImplementation(() => new Promise<string>((r) => (resolveSave = r)));
    render(<DataManagementSection {...baseProps()} />);

    await userEvent.click(screen.getByTestId("settings-file-backup"));
    await waitFor(() => expect((screen.getByTestId("settings-file-backup") as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByTestId("settings-reset-db") as HTMLButtonElement).disabled).toBe(true);
    expect(useSettingsBusy.getState().busy).toBe("backup");
    screen.getByTestId("settings-file-backup").click();
    expect(saveMock).toHaveBeenCalledTimes(1);

    resolveSave("");
    await waitFor(() => expect(useSettingsBusy.getState().busy).toBeNull());
    expect((screen.getByTestId("settings-file-backup") as HTMLButtonElement).disabled).toBe(false);
  });

  it("백업은 추가 확인 없이 곧바로 OS 저장 다이얼로그로 간다", async () => {
    saveMock.mockResolvedValue("");
    render(<DataManagementSection {...baseProps()} />);

    await userEvent.click(screen.getByTestId("settings-file-backup"));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
  });

  it("초기화는 RESET 을 타이핑해야 열리는 확인 모달을 그대로 유지한다", async () => {
    render(<DataManagementSection {...baseProps()} />);

    await userEvent.click(screen.getByTestId("settings-reset-db"));
    const input = await screen.findByPlaceholderText("RESET");
    const resetButtons = screen.getAllByRole("button", { name: "Reset database" });
    const confirmBtn = resetButtons[resetButtons.length - 1];
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);

    await userEvent.type(input, "RESET");
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(false);
  });

  // 복원은 **초기화와 대칭**이다 — zip 을 고른 뒤 RESTORE 를 타이핑해야 확인 버튼이 열린다.
  // 한동안 `PromptDialog mode="confirm"` 한 번으로 내려가 있었는데, 그 다이얼로그는 window 레벨
  // Enter 리스너를 걸고 ModalShell 은 포커스를 Cancel 이 아니라 카드로 보낸다 — 즉 zip 을 고르는
  // 네이티브 파일 다이얼로그를 Enter 로 닫은 그 키의 후속 입력만으로 backup_restore(= DB 통째
  // 덮어쓰기 + reload)가 나갔다. 복원은 초기화보다 덜 위험하지 않다: 초기화는 비우지만 복원은
  // 지금 데이터를 남의 것으로 덮는다.
  it("복원은 참조 첨부 주의와 함께 RESTORE 타이핑 게이트를 세운다 — 맨 Enter 로는 실행되지 않는다", async () => {
    openMock.mockResolvedValue("/some/backup.zip");
    render(<DataManagementSection {...baseProps()} />);

    await userEvent.click(screen.getByTestId("settings-restore"));

    expect(await screen.findByText(/Originals of referenced attachments/)).toBeTruthy();
    const confirmBtn = (await screen.findByTestId("settings-restore-confirm")) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    // 포커스가 다이얼로그 카드에 있는 상태의 맨 Enter — 옛 confirm 모드는 여기서 실행됐다.
    await userEvent.keyboard("{Enter}");
    expect(callMock).not.toHaveBeenCalledWith("backup_restore", expect.anything());

    await userEvent.type(screen.getByPlaceholderText("RESTORE"), "RESTORE");
    expect(confirmBtn.disabled).toBe(false);
  });

  // F4(PLAN-2026-09-15): 자동 백업이 실패해 있으면 실패 사실을 사유와 함께 danger 색으로 말한다
  // (D6 이후 이 줄은 저장 및 백업 카드에 선다).
  it("자동 백업이 실패한 상태면 사유가 danger 문구로 선다", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "backup_auto_status"
        ? { last_backup_at: "2026-09-14T10:00:00Z", interval: "weekly", keep: 3, last_error: "disk full" }
        : {},
    );
    render(<DataManagementSection {...baseProps()} />);

    const caption = await screen.findByTestId("settings-data-last-backup");
    expect(caption.textContent).toContain("disk full");
    // 확신하는 "마지막 백업 <시각>" 이 아니라 실패 사실이 먼저다 — 시각은 나오지 않는다.
    expect(caption.textContent).toContain("failed");
    expect(caption.textContent).not.toContain(new Date("2026-09-14T10:00:00Z").toLocaleString());
    expect(caption.getAttribute("style")).toContain("var(--danger)");
  });

  // F3(PLAN-2026-09-15): 백엔드가 덮어쓰기/비우기 직전에 찍은 스냅샷 경로를 UI 가 버리고 있었다.
  // 토스트는 곧바로 오는 reload 에 쓸려 아무도 못 봤다 — 창 안 다이얼로그로 보여 주고 사용자가
  // 닫은 뒤에야 다시 불러온다.
  it("초기화 뒤 안전 스냅샷 경로를 다이얼로그로 보여 주고, 닫아야 reload 한다", async () => {
    const reload = vi.fn();
    const onClose = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "db_reset") return { backup_path: "C:/data/backups/pre-reset.db" };
      return {};
    });

    render(<DataManagementSection onClose={onClose} />);
    await userEvent.click(screen.getByTestId("settings-reset-db"));
    await userEvent.type(await screen.findByPlaceholderText("RESET"), "RESET");
    const resetButtons = screen.getAllByRole("button", { name: "Reset database" });
    await userEvent.click(resetButtons[resetButtons.length - 1]);

    const path = await screen.findByTestId("settings-safety-snapshot-path");
    expect(path.textContent).toBe("C:/data/backups/pre-reset.db");
    expect(reload).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("settings-safety-snapshot-ok"));
    expect(onClose).toHaveBeenCalled();
    expect(reload).toHaveBeenCalled();
  });

  it("복원 뒤에도 같은 스냅샷 다이얼로그 — Escape 로 닫아도 reload 한다", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });
    openMock.mockResolvedValue("/some/backup.zip");
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "backup_restore") return { backup_path: "C:/data/backups/pre-restore.db", note_count: 1 };
      return {};
    });

    render(<DataManagementSection {...baseProps()} />);
    await userEvent.click(screen.getByTestId("settings-restore"));
    await userEvent.type(await screen.findByPlaceholderText("RESTORE"), "RESTORE");
    await userEvent.click(screen.getByTestId("settings-restore-confirm"));

    expect((await screen.findByTestId("settings-safety-snapshot-path")).textContent).toBe(
      "C:/data/backups/pre-restore.db",
    );
    expect(reload).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it("저장 및 백업 카드의 복구 목록에서 복원해도 같은 스냅샷 안내를 거친다 — 닫아야 창을 닫고 reload 한다", async () => {
    const reload = vi.fn();
    const onClose = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });
    const entries = [{ name: "auto-1", path: "C:/b/auto-1.zip", created_at: "2026-07-20T10:00:00Z", size_bytes: 1024 }];
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "backup_auto_status") return { last_backup_at: null, interval: "weekly", keep: 3, last_error: null };
      if (cmd === "backup_auto_list") return entries;
      if (cmd === "backup_restore") return { backup_path: "C:/data/backups/pre-list-restore.db", note_count: 1 };
      return {};
    });

    render(<DataManagementSection onClose={onClose} />);
    await userEvent.click(await screen.findByTestId("settings-backup-restore"));
    await userEvent.click(await screen.findByTestId("settings-backup-restore-confirm"));

    expect((await screen.findByTestId("settings-safety-snapshot-path")).textContent).toBe(
      "C:/data/backups/pre-list-restore.db",
    );
    expect(reload).not.toHaveBeenCalled(); // 안내를 닫기 전엔 다시 불러오지 않는다(예전엔 곧바로 reload 했다)
    await userEvent.click(screen.getByTestId("settings-safety-snapshot-ok"));
    expect(onClose).toHaveBeenCalled();
    expect(reload).toHaveBeenCalled();
  });

  it("the single 'Import from another app' dropdown opens with all 3 sources and routes each to its handler", async () => {
    openMock.mockReset().mockResolvedValue("/some/path.enex");
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "migration_import_enex") return { imported: 1, skipped: 0, note_ids: ["n1"] };
      return {};
    });
    render(<DataManagementSection {...baseProps()} />);

    // Replaces the old three-stacked-buttons layout: exactly one trigger button in the transfer
    // tile, no three loose "Import from another app (...)" buttons directly in the card.
    await userEvent.click(screen.getByRole("button", { name: /more/i }));
    await userEvent.click(await screen.findByRole("button", { name: /import from another app/i }));

    expect(screen.getByText("Import from another app (Markdown folder)")).toBeTruthy();
    expect(screen.getByText("Import from another app (Notion zip)")).toBeTruthy();
    expect(screen.getByText("Import from another app (Evernote ENEX)")).toBeTruthy();

    await userEvent.click(screen.getByText("Import from another app (Evernote ENEX)"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("migration_import_enex", expect.anything()));
  });
});

describe("DataManagementSection — bundle import version rejection", () => {
  // 가져오기 다이얼로그는 이제 이 페이지가 쥔다 — UI 로 연다(노트북 가져오기 → 번들 파일 선택).
  const pickBundle = async () => {
    openMock.mockReset().mockResolvedValue("/some/bundle.json");
    await userEvent.click(screen.getByRole("button", { name: "Import notebook…" }));
  };

  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    useNotesStore.setState({
      inboxId: "inbox1",
      loadTree: vi.fn().mockResolvedValue(undefined),
      noteIndex: new Map(),
    } as any);
  });

  it("shows the localized settings.import_version_newer toast instead of the raw backend message", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "import_bundle") {
        throw {
          code: "VALIDATION",
          message:
            "This bundle requires a newer version of Brise (bundle schema 7, this app supports 5). Update Brise, then try importing again.",
        };
      }
      return {};
    });

    render(<DataManagementSection {...baseProps()} />);
    await pickBundle();
    await userEvent.click(await screen.findByText("Add as new notebook"));

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("import_bundle", expect.anything()));
    await waitFor(() =>
      expect(emitNoticeMock).toHaveBeenCalledWith(
        "This file was created by a newer version of Brise. Update the app, then try again.",
      ),
    );
  });

  it("still shows the raw message for other import errors", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "import_bundle") {
        throw { code: "VALIDATION", message: "bundle schema mismatch: boom" };
      }
      return {};
    });

    render(<DataManagementSection {...baseProps()} />);
    await pickBundle();
    await userEvent.click(await screen.findByText("Add as new notebook"));

    await waitFor(() =>
      expect(emitNoticeMock).toHaveBeenCalledWith("bundle schema mismatch: boom"),
    );
  });

  // 교체는 DB 를 통째로 지운다 — 복원·초기화와 같은 타이핑 게이트. 맨 Enter 로는 나가지 않는다.
  it("교체 가져오기는 REPLACE 타이핑 게이트를 지나야 실행된다", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "import_bundle") return { imported_notes: 2, skipped: 0 };
      return {};
    });
    render(<DataManagementSection {...baseProps()} />);
    await pickBundle();
    await userEvent.click(await screen.findByText("Replace all data"));

    const confirmBtn = (await screen.findByTestId("settings-import-replace-confirm")) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    await userEvent.keyboard("{Enter}");
    expect(callMock).not.toHaveBeenCalledWith("import_bundle", expect.anything());

    await userEvent.type(screen.getByPlaceholderText("REPLACE"), "REPLACE");
    await userEvent.click(confirmBtn);
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("import_bundle", expect.objectContaining({ mode: "replace" })),
    );
    // 스냅샷 경로가 없으면(구 백엔드) 안내도 없다.
    expect(screen.queryByTestId("settings-safety-snapshot-path")).toBeNull();
  });

  it("교체 가져오기 뒤에도 복원·초기화와 같은 스냅샷 다이얼로그 — 닫아야 reload 한다", async () => {
    const reload = vi.fn();
    const onClose = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "import_bundle") return { imported_notes: 2, skipped: 0, backup_path: "C:/data/backups/pre-import.db" };
      return {};
    });
    render(<DataManagementSection onClose={onClose} />);
    await pickBundle();
    await userEvent.click(await screen.findByText("Replace all data"));
    await userEvent.type(await screen.findByPlaceholderText("REPLACE"), "REPLACE");
    await userEvent.click(screen.getByTestId("settings-import-replace-confirm"));

    const path = await screen.findByTestId("settings-safety-snapshot-path");
    expect(path.textContent).toBe("C:/data/backups/pre-import.db");
    expect(reload).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("settings-safety-snapshot-ok"));
    expect(onClose).toHaveBeenCalled();
    expect(reload).toHaveBeenCalled();
  });

  it("offers ics export in the transfer menu", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_query") return { notes: [] };
      return {};
    });

    render(<DataManagementSection {...baseProps()} />);
    await userEvent.click(screen.getByRole("button", { name: /more/i }));
    const exportIcsBtn = await screen.findByRole("button", { name: /export calendar \(\.ics\)/i });
    expect(exportIcsBtn).toBeTruthy();

    await userEvent.click(exportIcsBtn);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("note_query", expect.anything());
    });
  });
});
