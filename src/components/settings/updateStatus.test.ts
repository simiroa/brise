import { describe, it, expect, vi, beforeEach } from "vitest";
import { useUpdateStatus } from "./updateStatus";

const mockProbe = vi.fn();
const mockInstall = vi.fn();
vi.mock("../../lib/updater", () => ({
  probeUpdate: () => mockProbe(),
  installUpdate: () => mockInstall(),
}));

let mockBrowser = false;
vi.mock("../../lib/env", () => ({ isBrowser: () => mockBrowser }));

const mockReportFallback = vi.fn();
vi.mock("../../lib/diag", () => ({
  reportFallback: (...a: unknown[]) => mockReportFallback(...a),
}));

describe("useUpdateStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowser = false;
    useUpdateStatus.setState({ phase: "idle", version: undefined, notes: null });
  });

  it("probe: checking 을 거쳐 available(버전·요약) 이 된다", async () => {
    let resolve!: (v: unknown) => void;
    mockProbe.mockReturnValue(new Promise((r) => (resolve = r)));
    const p = useUpdateStatus.getState().probe();
    expect(useUpdateStatus.getState().phase).toBe("checking");
    resolve({ status: "available", version: "1.2.3", notes: "메모" });
    await p;
    expect(useUpdateStatus.getState()).toMatchObject({ phase: "available", version: "1.2.3", notes: "메모" });
  });

  it("probe: latest · error · unavailable(→idle) 로 내려간다", async () => {
    mockProbe.mockResolvedValueOnce({ status: "latest" });
    await useUpdateStatus.getState().probe();
    expect(useUpdateStatus.getState().phase).toBe("latest");

    mockProbe.mockResolvedValueOnce({ status: "error" });
    await useUpdateStatus.getState().probe();
    expect(useUpdateStatus.getState().phase).toBe("error");

    mockProbe.mockResolvedValueOnce({ status: "unavailable" });
    await useUpdateStatus.getState().probe();
    expect(useUpdateStatus.getState().phase).toBe("idle");
  });

  it("probe 가 throw 하면 error 로 내리고 진단에 남긴다", async () => {
    mockProbe.mockRejectedValue(new Error("boom"));
    await useUpdateStatus.getState().probe();
    expect(useUpdateStatus.getState().phase).toBe("error");
    expect(mockReportFallback).toHaveBeenCalledWith("settings.update_check", "threw", "boom");
  });

  it("브라우저에서는 probe 가 아무것도 하지 않는다", async () => {
    mockBrowser = true;
    await useUpdateStatus.getState().probe();
    expect(mockProbe).not.toHaveBeenCalled();
    expect(useUpdateStatus.getState().phase).toBe("idle");
  });

  it("install: 성공하면 installing 에 머물고, error 면 error 로 간다", async () => {
    mockInstall.mockResolvedValueOnce("installed");
    await useUpdateStatus.getState().install();
    expect(useUpdateStatus.getState().phase).toBe("installing");

    mockInstall.mockResolvedValueOnce("error");
    await useUpdateStatus.getState().install();
    expect(useUpdateStatus.getState().phase).toBe("error");
  });
});
