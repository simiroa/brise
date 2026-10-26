import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// 오너 결함 수정: 파일 드롭존은 섹션 종류(텍스트/시트/관계도)와 무관하게 항상 하나여야 한다.
// EditorDropOverlay 인스턴스가 두 개 이상 마운트되면 같은 드롭이 두 번 처리돼(각자 자기 rect만
// 히트테스트하는데 두 rect가 포개짐) 섹션이 두 벌 생기는 사고가 난다 — 소스 스캔으로 이 불변식을
// 고정한다(다른 계약 테스트와 같은 형태: canvasNoteFreeGuard.test.ts 등).
describe("EditorPanel — 파일 드롭존은 정확히 하나", () => {
  it("<EditorDropOverlay 는 EditorPanel.tsx 안에서 정확히 한 번만 쓰인다", () => {
    const file = path.resolve(__dirname, "../EditorPanel.tsx");
    const content = fs.readFileSync(file, "utf-8");
    const matches = content.match(/<EditorDropOverlay\b/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
