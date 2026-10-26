import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { PetSprite } from "./PetSprite";
import type { PetSnapshot } from "./petBehavior";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

// A(AUDIT-2026-09-26): package-load failure (→ legacy asset/SVG fallback) is now instrumented.
const reportFallbackMock = vi.fn();
vi.mock("../../lib/diag", () => ({
  reportFallback: (...args: unknown[]) => reportFallbackMock(...args),
}));

const listeners = new Map<string, () => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: () => void) => {
    listeners.set(event, cb);
    return Promise.resolve(() => listeners.delete(event));
  },
}));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const SNAPSHOT: PetSnapshot = { activity: "resting", animation: "idle" };

describe("PetSprite — usePetPackage 아틀라스 stale 가드", () => {
  beforeEach(() => {
    callMock.mockReset();
    reportFallbackMock.mockClear();
    listeners.clear();
  });

  it("먼저 보낸 요청의 아틀라스가 늦게 도착해도 나중에 선택된 프리셋을 덮지 않는다", async () => {
    const packageA = { id: "a", display_name: "Pet A", description: "", sprite_version_number: 2, selected: true, rows: 11, dialect: "codex-v2", has_preview: false, clips: [] };
    const packageB = { id: "b", display_name: "Pet B", description: "", sprite_version_number: 2, selected: true, rows: 11, dialect: "codex-v2", has_preview: false, clips: [] };
    const assetA = deferred<{ data_url: string }>();
    const assetB = deferred<{ data_url: string }>();
    let listCall = 0;
    let assetCall = 0;

    // usePetPackage는 id 없이 pet_package_asset을 부른다(백엔드가 선택된 패키지로 해석 —
    // list와 asset을 병렬로 쏘기 위해서다) — 여기선 호출 순서로 A/B를 구분한다.
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "pet_packages_list") {
        listCall += 1;
        return Promise.resolve({ items: [listCall === 1 ? packageA : packageB] });
      }
      if (cmd === "pet_package_asset") {
        assetCall += 1;
        return assetCall === 1 ? assetA.promise : assetB.promise;
      }
      return Promise.resolve({});
    });

    render(<PetSprite snapshot={SNAPSHOT} />);
    await act(async () => {
      await Promise.resolve();
    });

    // 선택이 바뀌었다(설정 화면에서 다른 프리셋을 골랐다고 가정) — A의 아틀라스는 아직 안 왔다.
    const rerun = listeners.get("pet-packages-changed")!;
    await act(async () => {
      rerun();
      await Promise.resolve();
    });

    // 나중 요청(B)의 아틀라스가 먼저 도착한다.
    await act(async () => {
      assetB.resolve({ data_url: "data:image/webp;base64,BBBB" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Pet B");

    // 먼저 보낸 요청(A)이 뒤늦게 도착해도 이미 반영된 B를 덮으면 안 된다.
    await act(async () => {
      assetA.resolve({ data_url: "data:image/webp;base64,AAAA" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Pet B");
  });

  it("무엇을 그릴지 확정되기 전엔 아무것도 그리지 않는다(교체 깜박임 방지)", () => {
    // 응답이 영원히 안 오는 상태를 흉내낸다 — pending인 동안 SVG를 먼저 그리면 "예전 아바타"
    // 깜박임이 재발한다.
    callMock.mockImplementation(() => new Promise(() => {}));
    render(<PetSprite snapshot={SNAPSHOT} />);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("선택된 패키지가 없으면 SVG 폴백을 그대로 쓴다", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "pet_packages_list") return Promise.resolve({ items: [] });
      if (cmd === "pet_assets_list") return Promise.resolve({ items: [] });
      return Promise.resolve({});
    });
    render(<PetSprite snapshot={SNAPSHOT} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("펫 (idle)");
  });

  it("패키지 meta.rows를 아틀라스에 넘긴다", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "pet_packages_list") {
        return Promise.resolve({
          items: [
            {
              id: "compact",
              display_name: "Compact",
              description: "",
              sprite_version_number: 2,
              selected: true,
              rows: 9,
              dialect: "codex-v2",
              has_preview: false,
              clips: [],
            },
          ],
        });
      }
      if (cmd === "pet_package_asset") {
        return Promise.resolve({ data_url: "data:image/webp;base64,AA==" });
      }
      return Promise.resolve({});
    });
    render(<PetSprite snapshot={SNAPSHOT} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("img").style.backgroundSize).toBe("800% 900%");
  });

  it("idle-image 방언은 아틀라스 대신 img를 그린다", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "pet_packages_list") {
        return Promise.resolve({
          items: [
            {
              id: "gif",
              display_name: "Gif Pet",
              description: "",
              sprite_version_number: 1,
              selected: true,
              dialect: "idle-image",
              rows: 1,
              has_preview: false,
              clips: [{ name: "idle", row: 0, frames: 1 }],
            },
          ],
        });
      }
      if (cmd === "pet_package_asset") {
        return Promise.resolve({ data_url: "data:image/gif;base64,R0lG" });
      }
      return Promise.resolve({});
    });
    render(<PetSprite snapshot={SNAPSHOT} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const img = screen.getByTestId("pet-idle-image");
    expect(img.tagName).toBe("IMG");
    expect(img.getAttribute("src")).toBe("data:image/gif;base64,R0lG");
    expect((img as HTMLImageElement).style.objectFit).toBe("contain");
    expect(document.querySelector(".codex-pet-atlas")).toBeNull();
  });

  // A(AUDIT-2026-09-26): pet_packages_list failing (not just "no package selected") falls back to
  // the legacy asset/SVG path exactly like the empty-list case — but must now leave a diag trace.
  it("reports a fallback when pet_packages_list fails, and still falls back to SVG", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "pet_packages_list") return Promise.reject(new Error("db locked"));
      if (cmd === "pet_assets_list") return Promise.resolve({ items: [] });
      return Promise.resolve({});
    });
    render(<PetSprite snapshot={SNAPSHOT} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("펫 (idle)");
    expect(reportFallbackMock).toHaveBeenCalledWith("pet", "sprite_package_failed", "db locked");
  });
});
