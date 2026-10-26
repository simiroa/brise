import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  fileExt,
  EXTRACTABLE_EXTS,
  ATTACHMENT_IMAGE_EXTS,
  ATTACHMENT_AUDIO_EXTS,
  UNRENDERABLE_IMAGE_EXTS,
  SECTION_IMPORT_EXTS,
  SECTION_TEXT_IMPORT_EXTS,
  DOC_IMPORT_HTML_EXTS,
  canPromoteAttachment,
} from "./fileKinds";

// 에디터 본문 드롭(useEditorFileDrop.ts)의 3갈래(이미지/섹션 가져오기/첨부만) 판정이 여기
// 확장자 집합 하나로 결정된다 — 회귀가 나면 이미지가 노드로 안 꽂히거나 섹션 대신 첨부로
// 잘못 라우팅된다.
describe("fileKinds — 드롭 3갈래 확장자 분류", () => {
  it("resolves a filename's extension case-insensitively, both path separators", () => {
    expect(fileExt("C:\\Users\\me\\Report.PDF")).toBe("pdf");
    expect(fileExt("/home/me/notes.md")).toBe("md");
    // 점으로 시작하는 이름(".gitignore")도 마지막 세그먼트를 확장자로 본다 — 점 하나뿐이라
    // "확장자 없음"과 구분이 안 되는 기존 동작 그대로(변경 범위 밖).
    expect(fileExt(".gitignore")).toBe("gitignore");
    expect(fileExt("noextension")).toBe("");
  });

  it("classifies image extensions — must mirror repo/attachments/mod.rs::kind_from_ext", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tiff"]) {
      expect(ATTACHMENT_IMAGE_EXTS.has(ext)).toBe(true);
    }
    expect(ATTACHMENT_IMAGE_EXTS.has("csv")).toBe(false);
    expect(ATTACHMENT_IMAGE_EXTS.has("pdf")).toBe(false);
  });

  it("classifies section_import_file's supported extensions (text + sheet)", () => {
    for (const ext of ["md", "txt", "docx", "pdf", "hwpx", "pptx", "csv", "tsv", "xlsx"]) {
      expect(SECTION_IMPORT_EXTS.has(ext)).toBe(true);
    }
    expect(SECTION_IMPORT_EXTS.has("png")).toBe(false);
    expect(SECTION_IMPORT_EXTS.has("zip")).toBe(false);
  });

  it("서식형 가져오기(doc_import_html)는 hwpx·docx 이고, 실패 시 후퇴할 텍스트 가져오기의 부분집합이다", () => {
    expect([...DOC_IMPORT_HTML_EXTS].sort()).toEqual(["docx", "hwpx"]);
    for (const ext of DOC_IMPORT_HTML_EXTS) expect(SECTION_TEXT_IMPORT_EXTS.has(ext)).toBe(true);
  });

  it("image and section-import extension sets never overlap (drop routing must be exclusive)", () => {
    for (const ext of ATTACHMENT_IMAGE_EXTS) {
      expect(SECTION_IMPORT_EXTS.has(ext)).toBe(false);
    }
  });

  it("EXTRACTABLE_EXTS (attachment extraction policy) matches repo/extraction.rs::extract_markdown", () => {
    expect([...EXTRACTABLE_EXTS].sort()).toEqual(["docx", "md", "pdf", "pptx", "txt"]);
  });

  it("an unrecognized extension (e.g. .zip) falls into none of the classified sets — 'attach only' branch", () => {
    expect(ATTACHMENT_IMAGE_EXTS.has("zip")).toBe(false);
    expect(SECTION_IMPORT_EXTS.has("zip")).toBe(false);
  });
});

// AttachmentsBar "섹션으로 가져오기" 첨부 승격 메뉴 자격 — canPromoteAttachment는 이 판정을
// 데스크톱/브라우저 구분 없이 순수하게 한다(isBrowser() 는 호출자가 따로 건다).
describe("canPromoteAttachment", () => {
  it("promotable extensions (section_import_file support) with a rel_path", () => {
    expect(canPromoteAttachment("n1/notes.md")).toBe(true);
    expect(canPromoteAttachment("n1/table.csv")).toBe(true);
    expect(canPromoteAttachment("n1/book.xlsx")).toBe(true);
  });

  it("null rel_path (link/note/internal attachments — no file on disk)", () => {
    expect(canPromoteAttachment(null)).toBe(false);
  });

  it("unsupported extension (image, zip, ...) is not promotable", () => {
    expect(canPromoteAttachment("n1/scan.png")).toBe(false);
    expect(canPromoteAttachment("n1/bundle.zip")).toBe(false);
  });
});

// repo/attachments/mod.rs::kind_from_ext 와의 동기화를 **소스를 직접 읽어** 강제한다(선례:
// remoteSettingsPolicy.test.ts 가 handlers.rs 를 읽는다). 주석 문구가 아니라 match 팔을 파싱한다 —
// 한쪽만 고치면 에디터 드롭 3갈래/타일 분류가 서버 분류와 어긋난다.
describe("kind_from_ext 동기화 (Rust 소스 대조)", () => {
  const src = readFileSync("src-tauri/src/repo/attachments/mod.rs", "utf8");
  const body = src.slice(src.indexOf("pub fn kind_from_ext"));
  const arms = body.slice(0, body.indexOf("_ => \"doc\""));
  const extsOf = (kind: string): string[] => {
    const exts: string[] = [];
    for (const line of arms.split("\n")) {
      if (line.trim().startsWith("//")) continue;
      const m = line.match(/^(.*)=>\s*"([a-z]+)"/);
      if (m && m[2] === kind) exts.push(...[...m[1].matchAll(/"([a-z0-9]+)"/g)].map((x) => x[1]));
    }
    expect(exts.length, `kind_from_ext 에 ${kind} 팔이 있어야 한다`).toBeGreaterThan(0);
    return exts.sort();
  };

  it("image 팔 = ATTACHMENT_IMAGE_EXTS (heic/heif 포함)", () => {
    expect([...ATTACHMENT_IMAGE_EXTS].sort()).toEqual(extsOf("image"));
    expect(ATTACHMENT_IMAGE_EXTS.has("heic")).toBe(true);
    expect(ATTACHMENT_IMAGE_EXTS.has("heif")).toBe(true);
  });

  it("audio 팔 = ATTACHMENT_AUDIO_EXTS (폰 녹음기 webm/opus 포함)", () => {
    expect([...ATTACHMENT_AUDIO_EXTS].sort()).toEqual(extsOf("audio"));
    for (const ext of ["weba", "opus", "ogg"]) expect(ATTACHMENT_AUDIO_EXTS.has(ext)).toBe(true);
  });

  it("이미지와 오디오 집합은 겹치지 않고, 그릴 수 없는 이미지는 이미지 집합의 부분집합이다", () => {
    for (const ext of ATTACHMENT_IMAGE_EXTS) expect(ATTACHMENT_AUDIO_EXTS.has(ext)).toBe(false);
    for (const ext of UNRENDERABLE_IMAGE_EXTS) expect(ATTACHMENT_IMAGE_EXTS.has(ext)).toBe(true);
  });
});
