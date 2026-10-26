import { describe, expect, it } from "vitest";
import ko from "../../i18n/ko/export.json";
import en from "../../i18n/en/export.json";
import fr from "../../i18n/fr/export.json";
import { EXPORT_FORMATS, diffLabel, formatSpec } from "./exportFormats";
import { hasPaper, isOfficeFormat } from "./exportDoc";
import { t } from "../../i18n/t";

const LOCALES: Record<string, Record<string, string>> = { ko, en, fr };

describe("export format table", () => {
  // "PDF·인쇄" 형식은 지웠다(2026-10-16) — 모든 형식에 [인쇄…] 버튼이 있다.
  it("dropdown order: HWPX · DOCX · HTML · copy · Markdown", () => {
    expect(EXPORT_FORMATS.map((f) => f.id)).toEqual(["hwpx", "docx", "html", "copy", "md"]);
  });

  it("every i18n key in the table exists in all three locales (t(key) here is dynamic — check:i18n can't see it)", () => {
    for (const f of EXPORT_FORMATS) {
      for (const key of [f.label, f.hint, f.note, f.fontDiff]) {
        if (!key) continue;
        const name = key.replace(/^export\./, "");
        for (const [loc, dict] of Object.entries(LOCALES)) {
          expect(dict[name], `${loc}: ${key}`).toBeTypeOf("string");
        }
      }
    }
  });

  it("agrees with exportDoc on paper, and each action has the right file shape", () => {
    for (const f of EXPORT_FORMATS) {
      expect(f.paper, f.id).toBe(hasPaper(f.id));
      // 파일을 쓰는 형식만 확장자가 있다 — 복사는 파일 이름 칸이 비어야 한다
      expect(f.ext !== null, f.id).toBe(f.action === "save");
      // 글꼴 줄은 글꼴을 지정하는 문서 편집기용 형식만
      expect(f.fontDiff !== null, f.id).toBe(isOfficeFormat(f.id));
    }
    expect(() => formatSpec("print" as never)).toThrow();
    expect(formatSpec("copy").action).toBe("copy");
    // HTML 은 브라우저로 연 파일, 서식 복사는 붙여넣은 모습으로 미리 본다 — 둘 다 종이가 아니다
    expect(formatSpec("html").preview).toBe("web");
    expect(formatSpec("copy").preview).toBe("pasted");
    expect(formatSpec("hwpx").preview).toBe("paper");
  });

  it("the font line follows the format (Hamchorom Batang for HWPX, Malgun Gothic for DOCX)", () => {
    expect(diffLabel({ id: "font", n: 0 }, formatSpec("hwpx"))).toBe(t("export.diff_font"));
    expect(diffLabel({ id: "font", n: 0 }, formatSpec("docx"))).toBe(t("export.diff_font_docx"));
    expect(diffLabel({ id: "footnotes", n: 2 }, formatSpec("hwpx"))).toBe(t("export.diff_footnotes", { n: 2 }));
    expect(diffLabel({ id: "sheets", n: 1 }, formatSpec("html"))).toBe(t("export.diff_sheets", { n: 1 }));
  });

  // 결함 재현(W6 검증 V3): Markdown 은 시트를 계산 값이 아니라 칸에 적힌 그대로(수식 포함) 쓴다 — "값만 든 표(수식 제외)" 문구는 반대 말이다.
  it("the sheets line follows how the format writes sheet cells (computed values vs. as typed for Markdown)", () => {
    for (const f of EXPORT_FORMATS) expect(f.sheetCells, f.id).toBe(f.id === "md" ? "raw" : "values");
    expect(diffLabel({ id: "sheets", n: 2 }, formatSpec("md"))).toBe(t("export.diff_sheets_md", { n: 2 }));
    expect(diffLabel({ id: "sheets", n: 2 }, formatSpec("md"))).not.toBe(t("export.diff_sheets", { n: 2 }));
    for (const [loc, dict] of Object.entries(LOCALES)) {
      expect(dict.diff_sheets_md, loc).toContain("{{n}}");
    }
  });
});
