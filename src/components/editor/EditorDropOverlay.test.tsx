import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EditorDropOverlay } from "./EditorDropOverlay";
import * as dropHook from "./useEditorFileDrop";

describe("EditorDropOverlay", () => {
  it("renders null when dragOver is false", () => {
    vi.spyOn(dropHook, "useEditorFileDrop").mockReturnValue({ dragOver: false });
    const sectionRef = { current: { id: "sec-1" } };
    const { container } = render(
      <EditorDropOverlay editor={null} sectionRef={sectionRef} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders DropGhost when dragOver is true", () => {
    vi.spyOn(dropHook, "useEditorFileDrop").mockReturnValue({ dragOver: true });
    const sectionRef = { current: { id: "sec-1" } };
    render(
      <EditorDropOverlay editor={null} sectionRef={sectionRef} />
    );
    const dropOverlay = screen.getByTestId("editor-drop-overlay");
    expect(dropOverlay).toBeTruthy();
  });
});
