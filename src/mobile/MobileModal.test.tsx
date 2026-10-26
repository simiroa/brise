import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MobileModal } from "./MobileModal";

/** The owner-blocking complaint this primitive exists for: the old `.mobile-sheet` was pinned to
 *  `bottom: 0`, i.e. exactly where the on-screen keyboard lands. These lock the structural contract
 *  that replaces it (centered backdrop = visible-viewport box, card = title/scrolling body/fixed
 *  footer). Pixel geometry lives in CSS and isn't asserted here — jsdom applies no stylesheet. */
describe("MobileModal", () => {
  it("renders centered inside a backdrop, not anchored to the bottom of the screen", () => {
    render(
      <MobileModal title="Edit" onClose={() => {}}>
        body
      </MobileModal>
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.classList.contains("mobile-modal")).toBe(true);
    // .overlay = the opaque floating surface role (SURFACE PRESET CONTRACT) — never the in-flow one.
    expect(dialog.classList.contains("overlay")).toBe(true);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("Edit");
    // The centering container is the backdrop, and the card is its child — NOT a sibling pinned
    // to the viewport edge the way `.mobile-sheet` + `.mobile-sheet-backdrop` were.
    const backdrop = screen.getByTestId("mobile-modal-backdrop");
    expect(backdrop.classList.contains("mobile-modal-backdrop")).toBe(true);
    expect(dialog.parentElement).toBe(backdrop);
    expect(dialog.classList.contains("mobile-sheet")).toBe(false);
  });

  it("keeps the footer inside the card, after the scrolling body", () => {
    render(
      <MobileModal title="Edit" onClose={() => {}} footer={<button>Save</button>}>
        <input placeholder="name" />
      </MobileModal>
    );
    const dialog = screen.getByRole("dialog");
    const footer = within(dialog).getByTestId("mobile-modal-footer");
    expect(footer.parentElement).toBe(dialog);
    expect(dialog.lastElementChild).toBe(footer);
    // The field scrolls, the footer does not — that's what survives the keyboard.
    const body = dialog.querySelector(".mobile-modal-body")!;
    expect(within(body as HTMLElement).getByPlaceholderText("name")).toBeTruthy();
  });

  it("omits the footer element entirely when no actions are given", () => {
    render(
      <MobileModal title="Pick" onClose={() => {}}>
        body
      </MobileModal>
    );
    expect(screen.queryByTestId("mobile-modal-footer")).toBeNull();
  });

  it("closes on backdrop click but not on a click inside the card", () => {
    const onClose = vi.fn();
    render(
      <MobileModal title="Edit" onClose={onClose}>
        <button>inside</button>
      </MobileModal>
    );
    fireEvent.click(screen.getByText("inside"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("mobile-modal-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <MobileModal title="Edit" onClose={onClose}>
        body
      </MobileModal>
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the dialog on open and restores it to the trigger on close", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(
      <MobileModal title="Edit" onClose={() => {}}>
        <button>first</button>
        <button>last</button>
      </MobileModal>
    );
    expect(document.activeElement).toBe(screen.getByText("first"));

    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("traps Tab inside the card — wrapping both ways", () => {
    render(
      <MobileModal title="Edit" onClose={() => {}} footer={<button>last</button>}>
        <button>first</button>
      </MobileModal>
    );
    const first = screen.getByText("first");
    const last = screen.getByText("last");

    first.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("the Android back gesture (popstate) closes it instead of falling through to the screen stack", () => {
    const onClose = vi.fn();
    render(
      <MobileModal title="Edit" onClose={onClose}>
        body
      </MobileModal>
    );
    fireEvent.popState(window);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("unmounting does NOT rewind history when something was pushed over its marker", () => {
    const { unmount } = render(
      <MobileModal title="Edit" onClose={() => {}}>
        body
      </MobileModal>
    );
    // e.g. the user taps a tab-bar item: MobileApp pushes a screen and unmounts this whole tree.
    history.pushState({ screen: "home" }, "");
    unmount();
    // The modal's cleanup must leave that navigation alone — popping it would dump the user back
    // on the screen they just left.
    expect((history.state as { screen?: string } | null)?.screen).toBe("home");
  });
});
