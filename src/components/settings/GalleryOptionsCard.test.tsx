import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettingsStore } from "../../stores/settings";
import { GalleryOptionsCard } from "./GalleryOptionsCard";
import { galleryColumnCount } from "../leftpanel/expanded/galleryLayout";

const callMock = vi.fn();
vi.mock("../../lib/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/invoke")>()),
  call: (...a: unknown[]) => callMock(...a),
  callSilent: (...a: unknown[]) => callMock(...a),
}));

describe("GalleryOptionsCard", () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ ok: true });
    useSettingsStore.setState({ uiLang: "en", galleryTileSize: "medium", gallerySort: "newest", galleryShowNames: false } as never);
  });

  it("세 옵션이 각자의 설정 키로 저장된다", async () => {
    render(<GalleryOptionsCard />);
    await userEvent.click(screen.getByRole("radio", { name: "Large" }));
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { gallery_tile_size: "large" } });
    await userEvent.click(screen.getByTestId("settings-gallery-show-names"));
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { gallery_show_names: true } });
  });

  it("타일 크기는 열 수를 ±1 한다(바닥 2열) — 보통은 폭 기반 값 그대로", () => {
    const base = galleryColumnCount(308, "medium");
    expect(galleryColumnCount(308, "small")).toBe(base + 1);
    expect(galleryColumnCount(308, "large")).toBe(Math.max(2, base - 1));
  });
});
