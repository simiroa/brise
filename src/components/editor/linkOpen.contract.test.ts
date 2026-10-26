import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * 오너 지시(2026-09-10): **에디터의 링크는 Ctrl/Cmd+클릭으로만 열린다.** 맨클릭·더블클릭·
 * 세번클릭은 전부 편집 제스처로 남아야 한다(세번클릭 = 문단 전체 선택, 본문 편집에서 자주 쓴다).
 *
 * 이 불변식이 소스 스캔으로 고정될 값어치가 있는 이유는 이력이 있다: StarterKit 3.x 는 Link 마크를
 * **openOnClick 기본값 true 로** 묶어서 배포한다. 그래서 (ⓐ) 우리 Link 를 명시적으로
 * openOnClick:false 로 등록하거나 (ⓑ) StarterKit 쪽 Link 를 link:false 로 끄거나 — 둘 중 하나라도
 * 빠지면 붙여넣은 URL 이 window.open() 으로 새 창을 띄운다. 한 번 실제로 났고(815b5c5) 모바일
 * 에디터에서 다시 날 뻔했다(MobileNote.tsx 의 주석). 의존성 업그레이드가 조용히 되돌릴 수 있는
 * 종류의 결함이라 런타임 테스트보다 소스 계약이 맞다(같은 형태: EditorPanel.dropZone.contract.test.ts).
 *
 * "그럼 열기는 어디 있나": EditorPanel.tsx 의 본문 클릭 핸들러가 조합키가 눌린 http(s) 앵커만
 * lib/urls.ts 의 openExternalUrl 로 보낸다. 그 분기가 사라지면 링크를 열 방법이 아예 없어지므로
 * 아래 세 번째 케이스가 그것도 함께 잡는다.
 */
const SRC = path.resolve(__dirname, "../../");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("링크는 클릭으로 열리지 않는다 (Ctrl/Cmd+클릭만)", () => {
  it("Link.configure 는 어디서든 openOnClick:false 로 등록된다", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file === __filename) continue; // 이 파일의 정규식 리터럴이 자기 자신에 걸린다
      const content = fs.readFileSync(file, "utf-8");
      // Link.configure({ … }) 한 건씩 — 옵션 덩어리 안에 openOnClick: false 가 있어야 한다.
      for (const m of content.matchAll(/Link\.configure\(\{([^}]*)\}/g)) {
        if (!/openOnClick:\s*false/.test(m[1])) offenders.push(path.relative(SRC, file));
      }
      // 옵션 없는 맨 Link 등록도 금지 — 그게 곧 기본값 true 다.
      if (/extensions:[\s\S]{0,400}?[[,]\s*Link\s*[,\]]/.test(content)) {
        offenders.push(`${path.relative(SRC, file)} (옵션 없는 Link 등록)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("실제 에디터를 만드는 두 곳은 StarterKit 이 묶어 온 Link 를 끈다", () => {
    for (const rel of ["lib/mdSerialize.ts", "mobile/mobileEditorExtensions.ts"]) {
      const content = fs.readFileSync(path.join(SRC, rel), "utf-8");
      const m = content.match(/StarterKit\.configure\(\{([^}]*)\}/);
      expect(m, `${rel}: StarterKit.configure 를 찾지 못했다`).toBeTruthy();
      expect(m![1], rel).toMatch(/link:\s*false/);
    }
  });

  it("EditorPanel 은 조합키가 눌린 http(s) 앵커만 외부로 보낸다", () => {
    const content = fs.readFileSync(path.join(SRC, "components/EditorPanel.tsx"), "utf-8");
    // 열기 경로가 존재하고(= 기능이 살아 있다),
    expect(content).toMatch(/e\.ctrlKey \|\| e\.metaKey\) void openExternalUrl\(/);
    // 그 앞에서 맨클릭을 끊는다(웹뷰 기본 활성화로 앱이 페이지로 넘어가는 것 방지).
    const branch = content.slice(content.indexOf("const httpAnchor"));
    expect(branch.slice(0, 600)).toMatch(/e\.preventDefault\(\)/);
  });
});
