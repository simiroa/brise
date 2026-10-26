import { describe, it, expect } from "vitest";
import { resolveAuxOpen } from "./App";

// Pure-function unit test — App itself pulls in the full Tauri/window/store dependency tree (see
// App.langRemount.test.tsx), so this branch is tested against the extracted resolveAuxOpen()
// rather than a full App render, same rationale as App.activityButton.test.tsx.
describe("resolveAuxOpen (settings/activity buttons + Ctrl+, routing)", () => {
  it("routes to the in-app overlay in browser mode (tablet, sync beta tab)", () => {
    expect(resolveAuxOpen(true)).toBe("overlay");
  });

  it("routes to the native OS-window command outside the browser (Tauri desktop) — unchanged", () => {
    expect(resolveAuxOpen(false)).toBe("window");
  });
});
