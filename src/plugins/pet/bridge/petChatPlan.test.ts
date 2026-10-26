import { describe, it, expect, vi, beforeEach } from "vitest";
import { generatePetChatPlan } from "./petChatPlan";

const generateAndInsertFillSection = vi.fn();
const generateFolderOrganizePlan = vi.fn();
const generateWorkspaceRefactorPlan = vi.fn();

vi.mock("./petChatSection", () => ({
  generateAndInsertFillSection: (...args: unknown[]) => generateAndInsertFillSection(...args),
}));

vi.mock("../../../stores/aiAgentActions", () => ({
  generateFolderOrganizePlan: (...args: unknown[]) => generateFolderOrganizePlan(...args),
  generateWorkspaceRefactorPlan: (...args: unknown[]) => generateWorkspaceRefactorPlan(...args),
}));

describe("generatePetChatPlan", () => {
  beforeEach(() => {
    generateAndInsertFillSection.mockReset();
    generateFolderOrganizePlan.mockReset();
    generateWorkspaceRefactorPlan.mockReset();
    generateAndInsertFillSection.mockResolvedValue(true);
  });

  it("fill_note inserts a section and does not return a review plan", async () => {
    const plan = await generatePetChatPlan({
      plan_kind: "fill_note",
      note_id: "n1",
      instruction: "100줄 템플릿",
    });
    expect(plan).toBeNull();
    expect(generateAndInsertFillSection).toHaveBeenCalledWith("n1", "100줄 템플릿");
    expect(generateWorkspaceRefactorPlan).not.toHaveBeenCalled();
  });
});
