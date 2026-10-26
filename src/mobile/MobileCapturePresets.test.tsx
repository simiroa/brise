import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MobileCapturePresets } from "./MobileCapturePresets";
import { usePresetsStore, TRAVEL_PRESET_BODY_MD, type CustomPreset } from "../stores/presets";
import { t } from "../i18n/t";

const CUSTOM: CustomPreset[] = [{ id: "p1", name: "My Preset", bodyMd: "<p>hi</p>" }];

describe("MobileCapturePresets", () => {
  it("shows builtin chips on the surface and keeps AI + custom presets behind 더보기", () => {
    render(
      <MobileCapturePresets
        customPresets={CUSTOM}
        todoBodyMd="<ul></ul>"
        aiReady
        onApply={vi.fn()}
        onGenerateAi={vi.fn()}
      />
    );
    expect(screen.getByText("To-do list")).toBeTruthy();
    expect(screen.getByTestId("mobile-preset-more")).toBeTruthy();
    expect(screen.queryByText("Start with AI")).toBeNull();
    expect(screen.queryByText("My Preset")).toBeNull();
    expect(screen.queryByText("Blank note")).toBeNull();
  });

  it("applies the checklist preset exactly once on tap", () => {
    const onApply = vi.fn();
    render(
      <MobileCapturePresets
        customPresets={[]}
        todoBodyMd='<ul data-type="taskList"></ul>'
        aiReady
        onApply={onApply}
        onGenerateAi={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText("To-do list"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({ title: null, bodyMd: '<ul data-type="taskList"></ul>' });
  });

  it("W8-f: shows the new 오늘 기록/여행 기록/회고 builtins and applies one on tap", () => {
    const onApply = vi.fn();
    render(
      <MobileCapturePresets
        customPresets={[]}
        todoBodyMd="<ul></ul>"
        aiReady
        onApply={onApply}
        onGenerateAi={vi.fn()}
      />
    );
    expect(screen.getByText(t("presets.daily_name"))).toBeTruthy();
    expect(screen.getByText(t("presets.travel_name"))).toBeTruthy();
    expect(screen.getByText(t("presets.retro_name"))).toBeTruthy();
    fireEvent.click(screen.getByText(t("presets.travel_name")));
    expect(onApply).toHaveBeenCalledWith({ title: null, bodyMd: TRAVEL_PRESET_BODY_MD });
  });

  it("applies a custom preset with its own title + body", () => {
    const onApply = vi.fn();
    render(
      <MobileCapturePresets
        customPresets={CUSTOM}
        todoBodyMd="<ul></ul>"
        aiReady
        onApply={onApply}
        onGenerateAi={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId("mobile-preset-more"));
    fireEvent.click(screen.getByText("My Preset"));
    expect(onApply).toHaveBeenCalledWith({ title: "My Preset", bodyMd: "<p>hi</p>" });
  });

  it("AI row is disabled when AI isn't ready and never opens the topic input", () => {
    render(
      <MobileCapturePresets
        customPresets={[]}
        todoBodyMd="<ul></ul>"
        aiReady={false}
        onApply={vi.fn()}
        onGenerateAi={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId("mobile-preset-more"));
    const aiRow = screen.getByText("Start with AI").closest("button")! as HTMLButtonElement;
    expect(aiRow.disabled).toBe(true);
    fireEvent.click(aiRow);
    expect(screen.queryByPlaceholderText("What's this note about?")).toBeNull();
  });

  it("AI-start: typing a topic, generating, and applying calls onGenerateAi then onApply with the generated body", async () => {
    const onApply = vi.fn();
    const onGenerateAi = vi.fn().mockResolvedValue("Generated body text");
    render(
      <MobileCapturePresets
        customPresets={[]}
        todoBodyMd="<ul></ul>"
        aiReady
        onApply={onApply}
        onGenerateAi={onGenerateAi}
      />
    );
    fireEvent.click(screen.getByTestId("mobile-preset-more"));
    fireEvent.click(screen.getByText("Start with AI"));
    const input = screen.getByPlaceholderText("What's this note about?");
    fireEvent.change(input, { target: { value: "My trip" } });
    fireEvent.click(screen.getByText("Generate"));

    await waitFor(() => expect(onGenerateAi).toHaveBeenCalledWith("My trip"));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith({ title: "My trip", bodyMd: "Generated body text" }));
  });

  it("AI-start: a null/empty generation result never calls onApply", async () => {
    const onApply = vi.fn();
    const onGenerateAi = vi.fn().mockResolvedValue(null);
    render(
      <MobileCapturePresets
        customPresets={[]}
        todoBodyMd="<ul></ul>"
        aiReady
        onApply={onApply}
        onGenerateAi={onGenerateAi}
      />
    );
    fireEvent.click(screen.getByTestId("mobile-preset-more"));
    fireEvent.click(screen.getByText("Start with AI"));
    fireEvent.change(screen.getByPlaceholderText("What's this note about?"), { target: { value: "x" } });
    fireEvent.click(screen.getByText("Generate"));

    await waitFor(() => expect(onGenerateAi).toHaveBeenCalledTimes(1));
    expect(onApply).not.toHaveBeenCalled();
  });

  it("opens custom preset options and allows renaming/deleting via store actions", async () => {
    const renameSpy = vi.spyOn(usePresetsStore.getState(), "rename").mockResolvedValue(undefined);
    const removeSpy = vi.spyOn(usePresetsStore.getState(), "remove").mockResolvedValue(undefined);

    render(
      <MobileCapturePresets
        customPresets={CUSTOM}
        todoBodyMd="<ul></ul>"
        aiReady
        onApply={vi.fn()}
        onGenerateAi={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId("mobile-preset-more"));
    fireEvent.click(screen.getByTitle("More options"));

    // Choice dialog options should be present
    expect(screen.getByText("Rename")).toBeTruthy();
    expect(screen.getByText("Remove")).toBeTruthy();

    // Click rename
    fireEvent.click(screen.getByText("Rename"));
    expect(screen.getByText("Rename preset")).toBeTruthy();

    // Submit new name
    const renameInput = screen.getByDisplayValue("My Preset");
    fireEvent.change(renameInput, { target: { value: "Renamed Preset" } });
    fireEvent.click(screen.getByText("Apply"));

    expect(renameSpy).toHaveBeenCalledWith("p1", "Renamed Preset");

    // Open options again and test delete
    fireEvent.click(screen.getByTitle("More options"));
    fireEvent.click(screen.getByText("Remove"));
    expect(screen.getByText("Delete preset?")).toBeTruthy();

    fireEvent.click(screen.getByText("Remove")); // Confirm button
    expect(removeSpy).toHaveBeenCalledWith("p1");
  });
});
