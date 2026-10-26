import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { t } from "../i18n/t";

vi.mock("./SettingsPanel", () => ({
  SettingsPanel: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="mock-settings-panel">
      <button type="button" onClick={onClose}>
        mock-settings-close
      </button>
    </div>
  ),
}));

import { BrowserAuxOverlay } from "./BrowserAuxOverlay";

describe("BrowserAuxOverlay — settings", () => {
  it("opens ModalShell titled settings.title, wrapping SettingsPanel with onClose passed through", async () => {
    const onClose = vi.fn();
    render(<BrowserAuxOverlay onClose={onClose} />);

    expect(screen.getByRole("dialog", { name: t("settings.title") })).toBeTruthy();
    expect(screen.getByTestId("mock-settings-panel")).toBeTruthy();

    (await screen.findByText("mock-settings-close")).click();
    expect(onClose).toHaveBeenCalled();
  });
});
