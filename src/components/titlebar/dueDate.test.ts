import { describe, it, expect } from "vitest";
import { toIsoDateLocal } from "./dueDate";

// Dashboard Wave 3 (2026-08-01) retired the deadline/urgency helpers this file used to hold
// (deadlineIso/isDeadlineOverdue/isDeadlineSoon/formatDeadlineChipLabel/dueQuickPickIso — all
// unused after the board's pin dot moved to board/status.ts::isPinned). Only the local-calendar-
// day formatter survives; it's simple enough that this one case is really just a regression
// guard on the padStart formatting, not a real spec.
describe("dueDate helpers", () => {
  it("toIsoDateLocal formats local calendar day", () => {
    expect(toIsoDateLocal(new Date(2026, 6, 31, 12, 0, 0))).toBe("2026-07-31");
  });
});
