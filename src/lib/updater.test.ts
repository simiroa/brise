import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCheck = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: () => mockCheck(),
}));

const mockRelaunch = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: () => mockRelaunch(),
}));

const mockAsk = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: (...args: unknown[]) => mockAsk(...args),
}));

const mockIsBrowser = vi.fn().mockReturnValue(false);
vi.mock("./env", () => ({
  isBrowser: () => mockIsBrowser(),
}));

// 설치 직전 저장(AUDIT-2026-10-23 R2) — 순서를 보려고 호출을 한 줄로 기록한다.
const order: string[] = [];
const mockFlushAll = vi.fn(async () => {
  order.push("flush");
});
vi.mock("./invoke", () => ({
  flushAll: () => mockFlushAll(),
  call: vi.fn(),
  callSilent: vi.fn(),
}));

function fakeUpdate() {
  return {
    version: "9.9.9",
    body: "고친 것\n새로 생긴 것" as string | undefined,
    download: vi.fn(async () => {
      order.push("download");
    }),
    install: vi.fn(async () => {
      order.push("install");
    }),
  };
}

// updater.ts keeps module-level state (session-once flag + in-flight guard) — vi.resetModules()
// + a fresh dynamic import per test gives every test its own instance of that state.
async function freshUpdater() {
  return import("./updater");
}

describe("checkForUpdates", () => {
  beforeEach(() => {
    vi.resetModules();
    mockCheck.mockReset();
    mockRelaunch.mockReset().mockResolvedValue(undefined);
    mockAsk.mockReset();
    mockIsBrowser.mockReset().mockReturnValue(false);
    mockFlushAll.mockClear();
    order.length = 0;
  });

  it("returns latest and never opens a dialog when no update is found", async () => {
    mockCheck.mockResolvedValue(null);
    const { checkForUpdates } = await freshUpdater();

    const result = await checkForUpdates({ silent: false });

    expect(result).toBe("latest");
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it("downloads, saves pending edits, then installs and relaunches when accepted", async () => {
    const update = fakeUpdate();
    mockCheck.mockResolvedValue(update);
    mockAsk.mockResolvedValue(true);
    const { checkForUpdates } = await freshUpdater();

    const result = await checkForUpdates({ silent: false });

    expect(result).toBe("installed");
    // 내려받는 동안 친 글이 설치(= 프로세스 종료) 전에 저장돼야 한다.
    expect(order).toEqual(["download", "flush", "install"]);
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
  });

  it("does not install when the download fails", async () => {
    const update = fakeUpdate();
    update.download.mockRejectedValue(new Error("network down"));
    mockCheck.mockResolvedValue(update);
    mockAsk.mockResolvedValue(true);
    const { checkForUpdates } = await freshUpdater();

    expect(await checkForUpdates({ silent: false })).toBe("error");
    expect(update.install).not.toHaveBeenCalled();
    expect(mockFlushAll).not.toHaveBeenCalled();
  });

  it("does not install when the user declines the confirm dialog", async () => {
    const update = fakeUpdate();
    mockCheck.mockResolvedValue(update);
    mockAsk.mockResolvedValue(false);
    const { checkForUpdates } = await freshUpdater();

    const result = await checkForUpdates({ silent: false });

    expect(result).toBe("declined");
    expect(update.download).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
    expect(mockRelaunch).not.toHaveBeenCalled();
  });

  it("swallows a check() failure and resolves to error even when silent", async () => {
    mockCheck.mockRejectedValue(new Error("network down"));
    const { checkForUpdates } = await freshUpdater();

    await expect(checkForUpdates({ silent: true })).resolves.toBe("error");
  });

  it("returns unavailable immediately in browser mode without calling check", async () => {
    mockIsBrowser.mockReturnValue(true);
    const { checkForUpdates } = await freshUpdater();

    const result = await checkForUpdates({ silent: false });

    expect(result).toBe("unavailable");
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("runs a silent check only once per session, but a manual check always runs", async () => {
    mockCheck.mockResolvedValue(null);
    const { checkForUpdates } = await freshUpdater();

    expect(await checkForUpdates({ silent: true })).toBe("latest");
    expect(mockCheck).toHaveBeenCalledTimes(1);

    // Second silent (auto) call this session is skipped entirely — no network call.
    expect(await checkForUpdates({ silent: true })).toBe("unavailable");
    expect(mockCheck).toHaveBeenCalledTimes(1);

    // A manual click is not gated by the session-once flag.
    expect(await checkForUpdates({ silent: false })).toBe("latest");
    expect(mockCheck).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent calls into a single in-flight check", async () => {
    let resolveCheck!: (value: null) => void;
    mockCheck.mockReturnValue(
      new Promise((resolve) => {
        resolveCheck = resolve;
      }),
    );
    const { checkForUpdates } = await freshUpdater();

    const p1 = checkForUpdates({ silent: false });
    const p2 = checkForUpdates({ silent: false });
    resolveCheck(null);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe("latest");
    expect(r2).toBe("latest");
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });
});

describe("probeUpdate / installUpdate", () => {
  beforeEach(() => {
    vi.resetModules();
    mockCheck.mockReset();
    mockRelaunch.mockReset().mockResolvedValue(undefined);
    mockAsk.mockReset();
    mockIsBrowser.mockReset().mockReturnValue(false);
    mockFlushAll.mockClear();
    order.length = 0;
  });

  it("probe 는 있음 + 버전 + 변경 요약을 돌려주고 대화상자·설치는 하지 않는다", async () => {
    const update = fakeUpdate();
    mockCheck.mockResolvedValue(update);
    const { probeUpdate } = await freshUpdater();

    expect(await probeUpdate()).toEqual({ status: "available", version: "9.9.9", notes: "고친 것\n새로 생긴 것" });
    expect(mockAsk).not.toHaveBeenCalled();
    expect(update.download).not.toHaveBeenCalled();
  });

  it("변경 요약이 비어 있으면 notes 는 null 이다", async () => {
    const update = fakeUpdate();
    update.body = "  ";
    mockCheck.mockResolvedValue(update);
    const { probeUpdate } = await freshUpdater();

    expect(await probeUpdate()).toEqual({ status: "available", version: "9.9.9", notes: null });
  });

  it("probe: 최신이면 latest, 확인이 실패하면 error, 브라우저면 unavailable(check 안 부름)", async () => {
    const { probeUpdate } = await freshUpdater();
    mockCheck.mockResolvedValueOnce(null);
    expect(await probeUpdate()).toEqual({ status: "latest" });

    mockCheck.mockRejectedValueOnce(new Error("offline"));
    expect(await probeUpdate()).toEqual({ status: "error" });

    mockCheck.mockClear();
    mockIsBrowser.mockReturnValue(true);
    expect(await probeUpdate()).toEqual({ status: "unavailable" });
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("동시 probe 는 한 번의 check 를 공유한다", async () => {
    let resolveCheck!: (v: null) => void;
    mockCheck.mockReturnValue(new Promise((r) => (resolveCheck = r)));
    const { probeUpdate } = await freshUpdater();

    const p1 = probeUpdate();
    const p2 = probeUpdate();
    resolveCheck(null);
    expect(await Promise.all([p1, p2])).toEqual([{ status: "latest" }, { status: "latest" }]);
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });

  it("install: probe 가 찾아 둔 업데이트를 내려받기 → 저장 → 설치 순으로 처리하고 재시작한다", async () => {
    const update = fakeUpdate();
    mockCheck.mockResolvedValue(update);
    const { probeUpdate, installUpdate } = await freshUpdater();
    await probeUpdate();

    expect(await installUpdate()).toBe("installed");
    expect(order).toEqual(["download", "flush", "install"]);
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
    expect(mockCheck).toHaveBeenCalledTimes(1); // 설치가 다시 check() 하지 않는다
  });

  it("install: 찾아 둔 업데이트가 없으면 error", async () => {
    const { installUpdate } = await freshUpdater();
    expect(await installUpdate()).toBe("error");
    expect(mockFlushAll).not.toHaveBeenCalled();
  });

  it("install: 내려받기가 실패하면 error 이고 설치하지 않는다", async () => {
    const update = fakeUpdate();
    update.download.mockRejectedValue(new Error("net"));
    mockCheck.mockResolvedValue(update);
    const { probeUpdate, installUpdate } = await freshUpdater();
    await probeUpdate();

    expect(await installUpdate()).toBe("error");
    expect(update.install).not.toHaveBeenCalled();
    expect(mockFlushAll).not.toHaveBeenCalled();
  });
});
