import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// 오너 요청(2026-09-07 "관련 날짜도 지역처럼 하나로 묶자"): DateBadge/RelatedDatesBadge를 하나의
// 칩으로 합쳤다. 소스 스캔으로 다시 갈라지는 것을 막는다 — tabletPortraitBanner.contract.test.ts와
// 같은 관용구(파일을 텍스트로 읽고 패턴을 단언).
describe("date chip merge contract (2026-09-07)", () => {
  const titleBarTsx = fs.readFileSync(path.resolve(__dirname, "../TitleBar.tsx"), "utf-8");

  it("TitleBar mounts exactly one date-related chip (DateBadge), no separate related-dates chip", () => {
    const dateBadgeMounts = titleBarTsx.match(/<DateBadge\b/g) ?? [];
    expect(dateBadgeMounts.length).toBe(1);
    expect(titleBarTsx).not.toMatch(/<RelatedDatesBadge\b/);
    expect(titleBarTsx).not.toContain('from "./titlebar/RelatedDatesBadge"');
  });

  it("the old standalone RelatedDatesBadge component file is gone", () => {
    expect(fs.existsSync(path.resolve(__dirname, "RelatedDatesBadge.tsx"))).toBe(false);
  });

  // folderId 는 승격("이 날짜로 할 일 만들기")이 있던 시절의 잔재였고, 알림 토글로 대체되면서
  // (D3 철회) 쓰이지 않게 되어 제거했다 — 그래서 여기서 요구하지 않는다. noteId 는 여전히
  // 필수다: 그게 없으면 DateBadge 가 관련 날짜를 조회하지 못해 병합 자체가 성립하지 않는다.
  it("DateBadge is passed noteId so it can host the related-dates list itself", () => {
    const dateBadgeMountMatch = titleBarTsx.match(/<DateBadge[\s\S]*?\/>/);
    expect(dateBadgeMountMatch).toBeTruthy();
    const mount = dateBadgeMountMatch![0];
    expect(mount).toMatch(/noteId=/);
    expect(mount).not.toMatch(/folderId=/);
  });
});
