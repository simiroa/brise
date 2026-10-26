import { describe, it, expect } from "vitest";
import {
  buildImportPlan,
  parseImportReply,
  sanitizeImportName,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_FILES,
  IMPORT_MAX_TEXT_CHARS,
  IMPORT_MAX_TOTAL_BYTES,
  type ShellImportBatch,
} from "./mobileImport";

const MB = 1024 * 1024;
const reply = (imp: unknown) => ({ ok: true, import: imp }) as never;
const batch = (over: Partial<ShellImportBatch> = {}): ShellImportBatch => ({
  importId: "abc123",
  text: "",
  subject: "",
  textError: false,
  items: [],
  omitted: 0,
  ...over,
});
const img = (idx: number, size = MB, extra: object = {}) => ({ idx, name: `p${idx}.jpg`, mime: "image/jpeg", size, ...extra });

describe("parseImportReply", () => {
  it("정상 응답 → 배치", () => {
    const b = parseImportReply(
      reply({ importId: "id_1-x", text: "hello", subject: "S", textError: false, omitted: 2, items: [img(0), img(3, 5, { error: "too_large" })] }),
    );
    expect(b).toMatchObject({ importId: "id_1-x", text: "hello", subject: "S", omitted: 2 });
    expect(b?.items.map((i) => [i.idx, i.error])).toEqual([[0, undefined], [3, "too_large"]]);
  });

  it("없음: import:null · ok:false(unknown_type 포함) → null", () => {
    expect(parseImportReply(reply(null))).toBeNull();
    expect(parseImportReply({ ok: false, error: "unknown_type" })).toBeNull();
    expect(parseImportReply({ ok: false })).toBeNull();
  });

  it("구형 셸이 위치로 답한 응답({ok,lat,lng}) 은 가져오기가 아니다", () => {
    expect(parseImportReply({ ok: true, lat: 37.5, lng: 127, accuracy: 20 })).toBeNull();
  });

  it("importId 가 없거나 경로에 쓸 수 없는 문자가 있으면 거절(URL 경로로 쓰인다)", () => {
    for (const id of ["", "a/b", "../x", "a b", "x".repeat(200), 5, undefined]) {
      expect(parseImportReply(reply({ importId: id, items: [] })), String(id)).toBeNull();
    }
  });

  it("알 수 없는 항목 오류는 unsupported, idx 가 이상한 항목은 버린다, 항목 수는 방어선까지", () => {
    const b = parseImportReply(
      reply({
        importId: "ok",
        items: [img(0, 1, { error: "weird" }), { idx: -1, name: "x" }, { idx: 1.5 }, null, "str", ...Array.from({ length: 300 }, (_, i) => img(10 + i))],
      }),
    );
    expect(b?.items[0]).toMatchObject({ idx: 0, error: "unsupported" });
    expect(b?.items.some((i) => i.idx === -1 || i.idx === 1.5)).toBe(false);
    expect(b!.items.length).toBeLessThanOrEqual(200);
    expect(b!.omitted).toBeGreaterThan(0); // 방어선 밖은 세어서 알린다
  });

  it("텍스트가 상한을 넘으면 textError(자르지 않는다)", () => {
    const b = parseImportReply(reply({ importId: "ok", text: "x".repeat(IMPORT_MAX_TEXT_CHARS + 1), items: [] }));
    expect(b?.textError).toBe(true);
  });
});

describe("buildImportPlan", () => {
  it("텍스트·제목·이미지 → 계획. URL 하나뿐인 텍스트는 본문으로 남는다(링크 칩이 가져오기를 제안할 수 있게)", () => {
    const p = buildImportPlan(batch({ text: "https://example.com/a", subject: "  재미있는\n기사  ", items: [img(0), img(1)] }));
    expect(p.title).toBe("재미있는 기사");
    expect(p.text).toBe("https://example.com/a");
    expect(p.files.map((f) => f.url)).toEqual(["/__shell/import/abc123/0", "/__shell/import/abc123/1"]);
    expect(p.skipped).toBe(0);
    expect(p.hasContent).toBe(true);
  });

  it("제목이 본문과 같으면 제목으로 쓰지 않는다 / 제목은 120자로 줄인다 / 제목만 있어도 내용", () => {
    expect(buildImportPlan(batch({ text: "같은 글", subject: "같은  글" })).title).toBeNull();
    expect(buildImportPlan(batch({ subject: "가".repeat(300) })).title).toHaveLength(120);
    const only = buildImportPlan(batch({ subject: "제목만" }));
    expect(only).toMatchObject({ title: "제목만", text: "", hasContent: true });
  });

  it("아무것도 없으면 hasContent=false", () => {
    expect(buildImportPlan(batch()).hasContent).toBe(false);
    expect(buildImportPlan(batch({ text: "  \n " })).hasContent).toBe(false);
  });

  it("상한: 개별 25MB 초과·이미지가 아님·셸 오류 항목은 건너뛰고 skipped 로 센다(조용히 버리지 않는다)", () => {
    const p = buildImportPlan(
      batch({
        items: [
          img(0, IMPORT_MAX_FILE_BYTES), // 정확히 25MB 는 허용
          img(1, IMPORT_MAX_FILE_BYTES + 1),
          { idx: 2, name: "a.pdf", mime: "application/pdf", size: 10 },
          img(3, 10, { error: "read_failed" }),
          img(4),
        ],
        omitted: 3,
      }),
    );
    expect(p.files.map((f) => f.idx)).toEqual([0, 4]);
    expect(p.skipped).toBe(3 + 3);
  });

  it("상한: 한 번에 20장·총 100MB 를 넘는 것도 skipped", () => {
    const many = buildImportPlan(batch({ items: Array.from({ length: IMPORT_MAX_FILES + 3 }, (_, i) => img(i, 1)) }));
    expect(many.files).toHaveLength(IMPORT_MAX_FILES);
    expect(many.skipped).toBe(3);

    const big = buildImportPlan(batch({ items: [0, 1, 2, 3, 4].map((i) => img(i, 24 * MB)) }));
    expect(big.files.length * 24 * MB).toBeLessThanOrEqual(IMPORT_MAX_TOTAL_BYTES);
    expect(big.files).toHaveLength(4);
    expect(big.skipped).toBe(1);
  });

  it("텍스트가 상한을 넘었다면 본문은 비우고 skipped 에 센다(잘린 본문을 저장하지 않는다)", () => {
    const p = buildImportPlan(batch({ text: "긴 글", textError: true, items: [img(0)] }));
    expect(p.text).toBe("");
    expect(p.skipped).toBe(1);
    expect(p.files).toHaveLength(1);
  });

  it("오류 항목만 있어도 skipped 가 있어 사용자에게 알릴 수 있다(내용은 없음)", () => {
    const p = buildImportPlan(batch({ items: [img(0, 1, { error: "too_large" })] }));
    expect(p.hasContent).toBe(false);
    expect(p.skipped).toBe(1);
  });
});

describe("sanitizeImportName", () => {
  it("경로 구분자·제어문자를 걷고 확장자는 지킨다", () => {
    expect(sanitizeImportName("a/b\\c:d.jpg", "image/jpeg", 0)).toBe("a_b_c_d.jpg");
    expect(sanitizeImportName("x\u0000y\n.png", "image/png", 0)).toBe("xy.png");
    expect(sanitizeImportName("../../etc/passwd.jpg", "image/jpeg", 0)).not.toContain("/");
  });

  it("확장자가 없으면 MIME 에서 붙인다(서버는 확장자로 종류를 정한다), 이름이 비면 imported-<idx>", () => {
    expect(sanitizeImportName("IMG_0001", "image/jpeg", 2)).toBe("IMG_0001.jpg");
    expect(sanitizeImportName("", "image/png", 7)).toBe("imported-7.png");
    expect(sanitizeImportName("noext", "application/x-unknown", 1)).toBe("noext");
    expect(sanitizeImportName("a.b c d", "image/webp", 1)).toBe("a.b c d.webp");
  });

  it("긴 이름은 줄이되 확장자를 남긴다", () => {
    const n = sanitizeImportName(`${"가".repeat(500)}.heic`, "image/heic", 0);
    expect(n.endsWith(".heic")).toBe(true);
    expect(n.length).toBeLessThanOrEqual(130);
  });
});
