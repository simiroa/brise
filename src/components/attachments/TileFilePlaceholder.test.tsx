import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { TileFilePlaceholder, fileShapeGroup, tileExtText } from "./TileFilePlaceholder";
import type { FileShapeGroup } from "./TileFilePlaceholder";

/* DOM 으로만 단언한다 — 이 자리표시에는 번역 문구가 없고(확장자는 번역 대상이 아니다),
   과거에 텍스트 매칭이 실제 번역문을 받아 실패한 전례가 있다. */
function box(group: FileShapeGroup, ext: string): HTMLElement {
  const { container } = render(<TileFilePlaceholder group={group} ext={ext} />);
  const el = container.querySelector<HTMLElement>("[data-file-group]");
  if (!el) throw new Error("no placeholder rendered");
  return el;
}

describe("fileShapeGroup", () => {
  it("문서 확장자는 doc — 기존 EXTRACTABLE/SECTION_TEXT 목록 그대로", () => {
    for (const name of ["treaty.pdf", "contract.docx", "notes.txt", "README.md", "deck.pptx", "report.hwpx"]) {
      expect(fileShapeGroup("doc", name)).toBe("doc");
    }
  });

  it("표 확장자는 sheet", () => {
    for (const name of ["rows.csv", "rows.tsv", "book.xlsx"]) {
      expect(fileShapeGroup("doc", name)).toBe("sheet");
    }
  });

  it("사진은 photo — kind=image 든, kind=doc 인 RAW 든", () => {
    expect(fileShapeGroup("image", "scan.png")).toBe("photo");
    expect(fileShapeGroup("image", "no-thumb-yet.unknown")).toBe("photo");
    // RAW 는 웹뷰가 못 그려서 kind 가 doc 이다(lib/fileKinds.ts) — 그래도 사용자에겐 사진이다.
    expect(fileShapeGroup("doc", "DSC_0001.cr2")).toBe("photo");
    expect(fileShapeGroup("doc", "DSC_0001.NEF")).toBe("photo");
  });

  it("동영상은 video, 오디오 kind 는 audio", () => {
    expect(fileShapeGroup("doc", "clip.mp4")).toBe("video");
    expect(fileShapeGroup("doc", "clip.webm")).toBe("video");
    expect(fileShapeGroup("audio", "voice.m4a")).toBe("audio");
  });

  it("모르는 확장자와 확장자 없는 파일은 other", () => {
    expect(fileShapeGroup("doc", "bundle.zip")).toBe("other");
    expect(fileShapeGroup("doc", "design.afdesign")).toBe("other");
    expect(fileShapeGroup("doc", "README")).toBe("other");
  });

  it("파일이 아닌 kind 는 null — 형식이 없는 것에 형식 상자를 씌우지 않는다", () => {
    expect(fileShapeGroup("link", "https://example.com")).toBeNull();
    expect(fileShapeGroup("note", "scratch.txt")).toBeNull();
    expect(fileShapeGroup("internal", "linked-note")).toBeNull();
    expect(fileShapeGroup("footnote", "fn.md")).toBeNull();
    expect(fileShapeGroup("chart", "매출")).toBeNull();
  });
});

describe("tileExtText", () => {
  it("확장자를 대문자로, 없으면 kind 로", () => {
    expect(tileExtText("doc", "treaty.pdf")).toBe("PDF");
    expect(tileExtText("doc", "TREATY.PDF")).toBe("PDF");
    expect(tileExtText("doc", "README")).toBe("DOC");
  });

  it("파일이 아닌 kind 는 고정 글자", () => {
    expect(tileExtText("link", "https://example.com")).toBe("URL");
    expect(tileExtText("note", "scratch.txt")).toBe("NOTE");
    expect(tileExtText("chart", "매출 v2.1")).toBe("CHART");
  });

  it("아주 긴 확장자도 그대로 돌려준다 — 자르기는 타일이 한다", () => {
    expect(tileExtText("doc", "design.afdesign")).toBe("AFDESIGN");
    expect(tileExtText("doc", "design.afdesign").substring(0, 4)).toBe("AFDE");
  });
});

describe("TileFilePlaceholder", () => {
  it("갈래와 확장자를 DOM 에 드러낸다", () => {
    const el = box("doc", "PDF");
    expect(el.dataset.fileGroup).toBe("doc");
    expect(el.dataset.fileExt).toBe("PDF");
    expect(el.textContent).toBe("PDF");
  });

  it("여섯 갈래가 서로 다른 비율의 상자를 그린다 — 변주 축은 비율 하나뿐", () => {
    const groups: FileShapeGroup[] = ["doc", "other", "sheet", "photo", "video", "audio"];
    const shapes = groups.map((g) => {
      const el = box(g, "X");
      return `${el.style.width}/${el.style.height}`;
    });
    expect(new Set(shapes).size).toBe(groups.length);

    // 나머지 축은 전부 같아야 한다(테두리·반경·틴트·굵기) — 갈래마다 다른 그림이 되면 안 된다.
    const skins = groups.map((g) => {
      const el = box(g, "X");
      return [el.style.border, el.style.borderRadius, el.style.background, el.style.fontWeight].join("|");
    });
    expect(new Set(skins).size).toBe(1);
  });

  it("확장자가 짧든(URL 없는 3자) 네 자든 상자가 글자를 밀어내지 않는다", () => {
    // min-width: min-content 가 좁은 doc 상자에서 네 글자를 자르지 않고 상자를 넓힌다.
    expect(box("doc", "PPTX").style.minWidth).toBe("min-content");
    expect(box("doc", "PPTX").textContent).toBe("PPTX");
    expect(box("audio", "MP3").textContent).toBe("MP3");
  });
});
