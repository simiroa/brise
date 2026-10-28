import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { catalogIdOf, catalogValue, fontStack, needsLoader } from "./stacks";
import catalog from "./catalog.json";

describe("fontStack", () => {
  it("번들 id 는 기존 스택 그대로", () => {
    expect(fontStack("pretendard", "text")).toBe('"Pretendard", "Source Sans 3", system-ui, sans-serif');
    expect(fontStack("serif", "text")).toBe('"Source Serif 4", "Noto Serif KR", serif');
  });

  it("코드체 기본값은 tokens.css 의 --font-mono 와 같다(기본 화면 불변)", () => {
    const tokens = readFileSync("src/styles/tokens.css", "utf8");
    const m = tokens.match(/--font-mono:([^;]+);/);
    expect(m?.[1].trim()).toBe(fontStack("source-code-pro", "mono"));
  });

  it("카탈로그 값은 brise-<id> 로 등록 이름을 갈라 쓴다", () => {
    expect(catalogIdOf(catalogValue("gaegu"))).toBe("gaegu");
    expect(fontStack("catalog:gaegu", "text")).toBe('"brise-gaegu", "Pretendard", system-ui, sans-serif');
    expect(fontStack("catalog:jetbrains-mono", "mono").startsWith('"brise-jetbrains-mono", "Source Code Pro"')).toBe(true);
  });

  it("시스템 글꼴 이름의 따옴표·역슬래시는 걷어낸다", () => {
    expect(fontStack('Evil", red; x\\', "text")).toBe('"Evil, red; x", "Pretendard", system-ui, sans-serif');
    expect(fontStack('""', "text")).toBe(fontStack("pretendard", "text"));
  });

  it("지연 로더가 필요한 값만 고른다", () => {
    expect(needsLoader("paper-mono")).toBe(true);
    expect(needsLoader("catalog:jua")).toBe(true);
    expect(needsLoader("pretendard")).toBe(false);
    expect(needsLoader("Malgun Gothic")).toBe(false);
    expect(needsLoader("")).toBe(false);
  });

  it("카탈로그: 역할이 셋 중 하나이고 600 은 진짜 굵기일 때만 있다", () => {
    for (const f of catalog.fonts) {
      expect(["body", "display", "mono"]).toContain(f.role);
      const has600 = f.faces.some((x) => x.weight === 600);
      expect(has600).toBe(f.weights === 2);
    }
  });
});

describe("previewFamily", () => {
  it("실제 카탈로그 패밀리와 겹치지 않는 미리보기 전용 이름", async () => {
    const { previewFamily, catalogFamily } = await import("./stacks");
    expect(previewFamily("gaegu")).toBe("brise-preview-gaegu");
    expect(previewFamily("gaegu")).not.toBe(catalogFamily("gaegu"));
  });
});
