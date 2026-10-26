import { describe, it, expect } from "vitest";
import { resolveNotebookName } from "./onboardingFlow";

// 노트북 이름 칸 기본값 규칙의 특성화 테스트 — 사용자가 지은 이름은 shuffle 전까지 보존된다.
const ideas = ["Alpha", "Beta", "Gamma"];
const base = { ideas, ideaIdx: 0, live: "My notes", draft: null, shuffled: false };

describe("resolveNotebookName", () => {
  it("keeps the user's own name unless shuffled", () => {
    expect(resolveNotebookName(base)).toEqual({ notebookName: "My notes", hasOwnName: true });
    expect(resolveNotebookName({ ...base, shuffled: true, ideaIdx: 4 }).notebookName).toBe("Beta");
  });

  it("proposes an idea when the name is a seeded one", () => {
    expect(resolveNotebookName({ ...base, live: "Brise", ideaIdx: 1 })).toEqual({ notebookName: "Beta", hasOwnName: false });
    expect(resolveNotebookName({ ...base, live: "Histoire de Corée" }).hasOwnName).toBe(false);
  });

  it("lets the draft win over everything", () => {
    expect(resolveNotebookName({ ...base, draft: "Draft", shuffled: true }).notebookName).toBe("Draft");
    expect(resolveNotebookName({ ...base, live: "Brise", draft: "" }).notebookName).toBe("");
  });

  it("falls back to the live name when there are no ideas", () => {
    expect(resolveNotebookName({ ...base, ideas: [], live: "Brise" }).notebookName).toBe("Brise");
  });
});
