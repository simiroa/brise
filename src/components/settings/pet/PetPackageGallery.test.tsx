import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PetPackageGallery, baseName, installErrorText } from "./PetPackageGallery";
import { useSettingsStore } from "../../../stores/settings";

const callMock = vi.fn();
vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
}));

type DropPayload = { type: string; paths: string[]; position: { x: number; y: number } };
let dropHandler: ((e: { payload: DropPayload }) => void) | null = null;
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: (e: { payload: DropPayload }) => void) => {
      dropHandler = cb;
      return Promise.resolve(() => {
        dropHandler = null;
      });
    },
  }),
}));

const openMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

const pkg = (id: string, selected = false) => ({
  id,
  display_name: id.toUpperCase(),
  description: "",
  sprite_version_number: 2,
  rows: 11,
  selected,
  dialect: "codex-v2",
  has_preview: false,
  clips: [],
});

describe("PetPackageGallery (PLAN-2026-09-15 P3/P5)", () => {
  beforeEach(() => {
    dropHandler = null;
    openMock.mockReset();
    callMock.mockReset().mockResolvedValue({ data_url: "data:image/png;base64,AAA" });
    useSettingsStore.setState({ uiLang: "en" } as never);
  });

  it("아틀라스는 항목별로 따로 받는다(목록은 metadata만)", async () => {
    render(
      <PetPackageGallery packages={[pkg("a", true), pkg("b")]} onSelect={vi.fn()} onChanged={vi.fn()} />,
    );
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("pet_package_asset", { id: "a" });
      expect(callMock).toHaveBeenCalledWith("pet_package_asset", { id: "b" });
    });
  });

  it("기본 타일이 있고 누르면 default 를 고른다", async () => {
    const onSelect = vi.fn();
    render(<PetPackageGallery packages={[]} onSelect={onSelect} onChanged={vi.fn()} />);
    const tile = screen.getByTestId("settings-pet-package-default");
    expect(tile.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(tile);
    expect(onSelect).toHaveBeenCalledWith("default");
  });

  it("'캐릭터 추가' 메뉴 하나에 파일 · 폴더 · Codex · URL 이 모이고, 폴더는 디렉터리 대화상자로 설치한다", async () => {
    const onChanged = vi.fn();
    openMock.mockResolvedValue("C:/pets/fox");
    render(<PetPackageGallery packages={[]} onSelect={vi.fn()} onChanged={onChanged} />);
    await userEvent.click(screen.getByTestId("settings-pet-add"));
    for (const id of ["file", "folder", "codex", "url"]) {
      expect(screen.getByTestId(`settings-pet-add-${id}`)).toBeTruthy();
    }
    await userEvent.click(screen.getByTestId("settings-pet-add-folder"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_package_install", { path: "C:/pets/fox" }));
    expect(openMock).toHaveBeenCalledWith({ directory: true, multiple: false });
    expect(screen.queryByTestId("settings-pet-add-menu")).toBeNull();
    // 설치가 끝나야 추가 단추가 다시 열린다.
    await waitFor(() => expect(screen.queryByTestId("settings-pet-installing")).toBeNull());

    await userEvent.click(screen.getByTestId("settings-pet-add"));
    await userEvent.click(screen.getByTestId("settings-pet-add-codex"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_packages_import_codex", {}));
  });

  it("Codex 가져오기가 도는 동안 진행 줄이 뜨고 추가 단추가 잠긴다", async () => {
    let finish: (v: unknown) => void = () => {};
    callMock.mockImplementation((cmd: string) =>
      cmd === "pet_packages_import_codex" ? new Promise((r) => (finish = r)) : Promise.resolve({ data_url: "x" }),
    );
    render(<PetPackageGallery packages={[]} onSelect={vi.fn()} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByTestId("settings-pet-add"));
    await userEvent.click(screen.getByTestId("settings-pet-add-codex"));

    expect(await screen.findByTestId("settings-pet-installing")).toBeTruthy();
    expect((screen.getByTestId("settings-pet-add") as HTMLButtonElement).disabled).toBe(true);
    finish({ installed: [], failed: [] });
    await waitFor(() => expect(screen.queryByTestId("settings-pet-installing")).toBeNull());
    expect((screen.getByTestId("settings-pet-add") as HTMLButtonElement).disabled).toBe(false);
  });

  it("삭제 단추는 늘 DOM 에 있어 키보드로 닿고, 포커스가 오면 드러난다", async () => {
    render(<PetPackageGallery packages={[pkg("a")]} onSelect={vi.fn()} onChanged={vi.fn()} />);
    const remove = screen.getByTestId("settings-pet-package-remove-a");
    expect(remove.getAttribute("data-revealed")).toBe("false");
    act(() => screen.getByTestId("settings-pet-package-a").focus()); // 패키지 a 타일
    await userEvent.tab(); // 바로 다음이 그 타일의 삭제 단추
    expect(document.activeElement).toBe(remove);
    expect(remove.getAttribute("data-revealed")).toBe("true");
  });

  it("미리보기 슬롯은 갤러리와 같은 카드 안에 그려진다", () => {
    render(
      <PetPackageGallery packages={[]} onSelect={vi.fn()} onChanged={vi.fn()} preview={<div data-testid="pv" />} />,
    );
    expect(screen.getByTestId("pv").closest(".card")).toBe(screen.getByTestId("settings-pet-gallery"));
  });

  it("여러 개를 떨구면 전부 설치를 시도하고 실패한 것만 매핑된 사유로 보여준다", async () => {
    const onChanged = vi.fn();
    callMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === "pet_package_install") {
        return args.path === "C:/drop/bad.zip"
          ? Promise.reject({ code: "VALIDATION", message: "pet_install:no_manifest" })
          : Promise.resolve({ ok: true });
      }
      return Promise.resolve({ data_url: "data:image/png;base64,AAA" });
    });
    render(<PetPackageGallery packages={[]} onSelect={vi.fn()} onChanged={onChanged} />);
    await waitFor(() => expect(dropHandler).not.toBeNull());

    dropHandler!({
      payload: { type: "drop", paths: ["C:/drop/good.zip", "C:/drop/bad.zip"], position: { x: 0, y: 0 } },
    });

    const failures = await screen.findByTestId("settings-pet-install-failures");
    expect(failures.textContent).toContain("bad.zip");
    expect(failures.textContent).toContain("pet.json was not found.");
    expect(failures.textContent).not.toContain("good.zip");
    expect(failures.textContent).not.toContain("pet_install:");
    expect(callMock).toHaveBeenCalledWith("pet_package_install", { path: "C:/drop/good.zip" });
    expect(onChanged).toHaveBeenCalled();
  });

  it("serde missing field 원문은 숨기고, 닫으면 배너가 사라진다", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "pet_package_install") {
        return Promise.reject({ message: "missing field `id` at line 1 column 1" });
      }
      return Promise.resolve({ data_url: "data:image/png;base64,AAA" });
    });
    render(<PetPackageGallery packages={[]} onSelect={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => expect(dropHandler).not.toBeNull());

    dropHandler!({
      payload: { type: "drop", paths: ["C:/drop/bad.zip"], position: { x: 0, y: 0 } },
    });

    const failures = await screen.findByTestId("settings-pet-install-failures");
    expect(failures.textContent).not.toContain("missing field");
    expect(failures.textContent).toContain("This package could not be installed.");

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("settings-pet-install-failures")).toBeNull();
  });

  it("installErrorText 는 토큰을 로케일 문구로 바꾼다", () => {
    expect(installErrorText("pet_install:missing_id")).toBe("Package id is missing.");
    expect(installErrorText("pet_install:bad_atlas:1536x2000")).toContain("1536x2000");
    expect(installErrorText("missing field `id` at line 1 column 1")).not.toMatch(/missing field/i);
  });

  it("baseName 은 실패 목록에 전체 경로를 늘어놓지 않는다", () => {
    expect(baseName("C:\\downloads\\pets\\fox.zip")).toBe("fox.zip");
    expect(baseName("/home/u/fox")).toBe("fox");
  });
});
