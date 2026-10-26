import { describe, expect, it } from "vitest";
import { uniqueAttachedName } from "./AskAiModal";

describe("uniqueAttachedName", () => {
  it("충돌이 없으면 그대로, 있으면 stem (n).ext — 내보내기와 같은 규칙", () => {
    expect(uniqueAttachedName([], "main.py")).toBe("main.py");
    expect(uniqueAttachedName([{ name: "main.py" }], "main.py")).toBe("main (2).py");
    expect(uniqueAttachedName([{ name: "main.py" }, { name: "main (2).py" }], "main.py")).toBe("main (3).py");
    expect(uniqueAttachedName([{ name: "README" }], "README")).toBe("README (2)");
  });
});
