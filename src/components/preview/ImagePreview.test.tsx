import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Attachment } from "../../lib/commands.gen";
import { ImagePreview } from "./ImagePreview";

const callMock = vi.fn();

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

const att: Attachment = {
  id: "img1",
  name: "photo.png",
  kind: "image",
  rel_path: "n1/photo.png",
  url: null,
  size_bytes: 100,
  position: 0,
};

const convert = (p: string) => `asset://${p}`;

function renderPreview() {
  const { container } = render(
    <ImagePreview att={att} baseDir="C:/attachments" convert={convert} />,
  );
  const img = screen.getByAltText("photo.png") as HTMLImageElement;
  const pane = img.parentElement as HTMLDivElement;
  const buttons = container.querySelectorAll(".overlay button");
  return {
    img,
    pane,
    fitButton: buttons[0] as HTMLButtonElement,
    zoomOutButton: buttons[1] as HTMLButtonElement,
    zoomInButton: buttons[2] as HTMLButtonElement,
  };
}

describe("ImagePreview mouse interaction", () => {
  beforeEach(() => {
    callMock.mockReset();
  });

  it("wheel is registered non-passive so preventDefault actually blocks page scroll", () => {
    // Root-cause regression: React's synthetic onWheel listener is passive at the delegation
    // root, so a plain onWheel prop's e.preventDefault() is silently ignored and an ancestor
    // scroll container (e.g. the note editor) scrolls underneath the zoom instead of zooming.
    // Mirrors WorldMap.wheel.test.tsx.
    const { pane } = renderPreview();
    const evt = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, cancelable: true, bubbles: true, clientX: 100, clientY: 100 });
    pane.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
  });

  it("wheel zoom changes the scale", () => {
    const { img, pane } = renderPreview();
    expect(img.style.transform).toBe(""); // starts at fit, no transform applied

    fireEvent.wheel(pane, { deltaY: -100, ctrlKey: true, clientX: 100, clientY: 100 });

    expect(img.style.transform).toContain("scale(1.15)");
  });

  it("a wheel zoom centred off-centre also changes the translate, unlike one at the origin", () => {
    const { img, pane } = renderPreview();
    // First notch only exits fit (the img box is letterboxed there, not anchorable yet).
    fireEvent.wheel(pane, { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 });
    expect(img.style.transform).toBe("translate(0px, 0px) scale(1.15)");

    // A second notch at the origin keeps the anchor at the origin: translate stays put.
    fireEvent.wheel(pane, { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 });
    expect(img.style.transform).toContain("translate(0px, 0px)");

    // The same notch off-centre must move the translate, since the anchor is the cursor.
    fireEvent.wheel(pane, { deltaY: -100, ctrlKey: true, clientX: 300, clientY: 200 });
    expect(img.style.transform).not.toContain("translate(0px, 0px)");
  });

  it("leaves a plain (unmodified) wheel to the note editor — zoom is Ctrl/Cmd+wheel", () => {
    // 2026-09-08: unified with the dashboard timeline and the map.
    const { img, pane } = renderPreview();
    const evt = new WheelEvent("wheel", { deltaY: -100, cancelable: true, bubbles: true, clientX: 100, clientY: 100 });
    pane.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(img.style.transform).toBe(""); // still at fit, untouched
  });

  it("horizontal wheel pans instead of zooming", () => {
    // deltaX with deltaY === 0 read as "not < 0" in the zoom path and shrank the image on every
    // notch of a tilt wheel. Pan only past fit — while fit the image is letterboxed.
    const { img, pane } = renderPreview();
    fireEvent.wheel(pane, { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 });
    expect(img.style.transform).toBe("translate(0px, 0px) scale(1.15)");

    fireEvent.wheel(pane, { deltaX: 40, deltaY: 0, clientX: 0, clientY: 0 });

    expect(img.style.transform).toBe("translate(-40px, 0px) scale(1.15)");
  });

  it("Fit resets both zoom and pan", async () => {
    const user = userEvent.setup();
    const { img, pane, fitButton } = renderPreview();

    fireEvent.wheel(pane, { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 });
    fireEvent.wheel(pane, { deltaY: -100, ctrlKey: true, clientX: 300, clientY: 200 });
    expect(img.style.transform).not.toBe("");

    await user.click(fitButton);

    expect(img.style.transform).toBe("");
    expect(screen.getByText("100%")).toBeTruthy();
  });

  // Wheel is a continuous React event: two notches can land before a re-render commits.
  // Reading zoom off the closure would make both compute from the same base and the
  // second notch would be lost — hence the view ref. Dispatching both inside one act()
  // reproduces exactly that batching.
  it("compounds two wheel notches that land before a re-render", () => {
    const { img, pane } = renderPreview();

    act(() => {
      pane.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true }));
      pane.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true }));
    });

    // 1.15 twice, not 1.15 once.
    expect(img.style.transform).toContain(`scale(${1.15 * 1.15})`);
  });

  it("transform transition is off during a wheel zoom and on after a button zoom", async () => {
    const user = userEvent.setup();
    const { img, pane, zoomInButton } = renderPreview();

    fireEvent.wheel(pane, { deltaY: -100, ctrlKey: true, clientX: 100, clientY: 100 });
    expect(img.style.transition).toBe("none");

    await user.click(zoomInButton);
    expect(img.style.transition).toBe("transform var(--dur-slow)");
  });
});
