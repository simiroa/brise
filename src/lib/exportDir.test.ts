import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "../stores/settings";
import { withExportDir } from "./exportDir";

describe("withExportDir", () => {
  beforeEach(() => useSettingsStore.setState({ exportDefaultDir: "" } as never));

  it("폴더가 없으면 파일명만", () => {
    expect(withExportDir("a.md")).toBe("a.md");
  });

  it("폴더가 있으면 그 안의 경로 — 끝 구분자·구분자 종류를 따른다", () => {
    useSettingsStore.setState({ exportDefaultDir: "D:\\exports\\" } as never);
    expect(withExportDir("a.md")).toBe("D:\\exports\\a.md");
    useSettingsStore.setState({ exportDefaultDir: "/home/me/out/" } as never);
    expect(withExportDir("a.md")).toBe("/home/me/out/a.md");
  });
});
