import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { useBackClosable } from "./useBackClosable";

function Layer({ active = true, onClose }: { active?: boolean; onClose: () => void }) {
  useBackClosable(active, onClose);
  return null;
}

const flush = () => act(async () => { await Promise.resolve(); });
/** A real hardware back: jsdom's history.back() pops the entry and fires popstate with the LANDED state. */
// Resolve on the popstate itself (jsdom delivers it on a later task), not after a fixed sleep —
// a fixed 15ms flaked under full-suite load.
const hwBack = () =>
  act(async () => {
    const landed = new Promise((r) => window.addEventListener("popstate", r, { once: true }));
    history.back();
    await landed;
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useBackClosable", () => {
  it("pushes one marker entry while active, none while inactive", () => {
    const push = vi.spyOn(history, "pushState");
    const { rerender, unmount } = render(<Layer active={false} onClose={() => {}} />);
    expect(push).not.toHaveBeenCalled();
    rerender(<Layer active onClose={() => {}} />);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toMatchObject({ mobileModal: true });
    unmount();
  });

  it("popstate (hardware back) closes it", () => {
    const onClose = vi.fn();
    const { unmount } = render(<Layer onClose={onClose} />);
    fireEvent.popState(window);
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("programmatic close pops its own entry, but not one pushed over it", async () => {
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    const a = render(<Layer onClose={() => {}} />);
    a.rerender(<Layer active={false} onClose={() => {}} />);
    await flush();
    expect(back).toHaveBeenCalledTimes(1);

    back.mockClear();
    const b = render(<Layer onClose={() => {}} />);
    history.pushState({ screen: "home" }, ""); // navigation pushed over the marker
    b.unmount();
    await flush();
    expect(back).not.toHaveBeenCalled();
    expect((history.state as { screen?: string }).screen).toBe("home");
  });

  it("does not pop again after a popstate already consumed its entry", async () => {
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    const { unmount } = render(<Layer onClose={() => {}} />);
    fireEvent.popState(window);
    unmount();
    await flush();
    expect(back).not.toHaveBeenCalled();
  });

  it("nested layers close top-first: one back closes only the topmost", async () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const { unmount: uo } = render(<Layer onClose={outer} />);
    const { unmount: ui } = render(<Layer onClose={inner} />);
    await hwBack();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    ui(); // the host removes the top layer in response
    await hwBack();
    expect(outer).toHaveBeenCalledTimes(1);
    uo();
  });

  it("closing A and opening B in the same tick re-uses the entry instead of letting the late back() eat it", async () => {
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    const push = vi.spyOn(history, "pushState");
    const a = render(<Layer onClose={() => {}} />);
    push.mockClear();
    a.unmount();
    const b = render(<Layer onClose={() => {}} />);
    await flush();
    expect(push).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    b.unmount();
    await flush();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("a layer closed by hand does not take the layer under it down with it (its own back() pop is not a hardware back)", async () => {
    // Real (jsdom) history.back(): the hook's own pop lands on the outer layer's marker.
    const outerClose = vi.fn();
    function Pair({ inner }: { inner: boolean }) {
      return (
        <>
          <Layer onClose={outerClose} />
          <Layer active={inner} onClose={() => {}} />
        </>
      );
    }
    const r = render(<Pair inner />);
    const landed = new Promise((res) => window.addEventListener("popstate", res, { once: true }));
    r.rerender(<Pair inner={false} />); // e.g. 취소 on a confirm dialog stacked over the action sheet
    await act(async () => { await landed; }); // the hook's own pop has been delivered
    expect(outerClose).not.toHaveBeenCalled();
    r.unmount();
  });
});
