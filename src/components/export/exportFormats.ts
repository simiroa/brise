/**
 * 내보내기 모달의 형식 표 — 형식마다 갈리는 것(칩 라벨 · 종이 위 안내 · 아래 안내 · 용지 · 미리보기 모양 · 버튼 동작 ·
 * 확장자 · 글꼴 줄 문구)을 **한 곳에** 둔다. (PLAN-2026-10-07-doc-import-export §4, W6)
 *
 * 이 모달은 웨이브마다 형식이 늘었고, 그때마다 ExportModal 안의 switch·삼항 여러 군데를 같이 고쳐야 했다 — 하나를
 * 빠뜨리면 "칩은 있는데 안내가 다른 형식 것"이 된다. 이제 형식을 더하는 일은 이 표에 한 줄을 더하는 일이다.
 *
 * i18n 키는 **리터럴 문자열**로 적는다 — check:i18n 의 미사용 키 검사가 소스의 리터럴만 센다. 키가 세 로케일에 다
 * 있는지는 exportFormats.test.ts 가 본다(동적 t(key) 호출은 check:i18n 의 미정의 검사가 못 본다).
 */
import { t } from "../../i18n/t";
import type { ExportDiff, ExportFormat } from "./exportDoc";

/** 오른쪽 아래 주 버튼이 하는 일 — 파일 저장 · 클립보드 복사. 인쇄는 모든 형식의 보조 버튼이라 여기 없다. */
export type ExportAction = "save" | "copy";

/**
 * 미리보기 모양 — paper = A4 종이(용지·여백·zoom), web = 브라우저로 연 HTML 파일(읽기 폭, 접기는 접힌 채),
 * pasted = 붙여넣은 모습(서식 복사 조각 — 접기는 펼친 내용, 할 일은 ☐/☑ 글자)을 같은 읽기 폭 문서에 담은 것.
 */
export type ExportPreview = "paper" | "web" | "pasted";

export interface ExportFormatSpec {
  id: ExportFormat;
  /** 칩 라벨 키. */
  label: string;
  /** 미리보기 위 안내 키 — 어디서 열면 이렇게 보이는지. */
  hint: string;
  /** 오른쪽 아래 안내 키(없으면 null). */
  note: string | null;
  /** 용지(크기·방향·여백)를 고르는가 — exportDoc.hasPaper 와 같아야 한다(테스트가 본다). */
  paper: boolean;
  preview: ExportPreview;
  action: ExportAction;
  /** 저장하는 파일의 확장자 — 파일을 쓰지 않는 형식(복사)은 null. */
  ext: string | null;
  /** 달라지는 점 "글꼴" 줄의 문구 키 — 글꼴을 지정하는 형식만(HWPX 함초롬바탕 · DOCX 맑은 고딕). */
  fontDiff: string | null;
  /**
   * 시트 칸을 무엇으로 쓰나 — values = 계산된 값 표(미리보기도 같은 표를 그린다), raw = 칸에 적힌 그대로(수식 `=SUM(…)` 포함 —
   * Markdown 은 Rust export_note 가 시트를 자기 표로 쓴다). raw 는 계산 값을 그리는 시트 표를 미리보기에서 빼고, 달라지는 점
   * "시트" 줄 문구가 갈린다(W6 검증 V3 — 미리보기는 3000, 파일은 =SUM(B2:B3) 이던 어긋남).
   */
  sheetCells: "values" | "raw";
}

/** 드롭다운 순서 그대로 — 두 범위(이 섹션 / 노트 전체) 모두 같은 다섯 형식이다. */
export const EXPORT_FORMATS: readonly ExportFormatSpec[] = [
  {
    id: "hwpx",
    label: "export.format_hwpx",
    hint: "export.hint_hwpx",
    note: "export.note_hwpx",
    paper: true,
    preview: "paper",
    action: "save",
    ext: "hwpx",
    fontDiff: "export.diff_font",
    sheetCells: "values",
  },
  {
    id: "docx",
    label: "export.format_docx",
    hint: "export.hint_docx",
    note: "export.note_docx",
    paper: true,
    preview: "paper",
    action: "save",
    ext: "docx",
    fontDiff: "export.diff_font_docx",
    sheetCells: "values",
  },
  {
    id: "html",
    label: "export.format_html",
    hint: "export.hint_html",
    note: "export.note_html",
    paper: false,
    preview: "web",
    action: "save",
    ext: "html",
    fontDiff: null,
    sheetCells: "values",
  },
  {
    id: "copy",
    label: "export.format_copy",
    hint: "export.hint_copy",
    note: "export.note_copy",
    paper: false,
    preview: "pasted",
    action: "copy",
    ext: null,
    fontDiff: null,
    sheetCells: "values",
  },
  {
    id: "md",
    label: "export.format_md",
    hint: "export.hint_text",
    note: null,
    paper: false,
    preview: "paper",
    action: "save",
    ext: "md",
    fontDiff: null,
    sheetCells: "raw",
  },
];

export function formatSpec(id: ExportFormat): ExportFormatSpec {
  const spec = EXPORT_FORMATS.find((f) => f.id === id);
  if (!spec) throw new Error(`unknown export format: ${id}`);
  return spec;
}

/**
 * 달라지는 점 한 줄의 문구. 키를 리터럴로 적는다(미사용 키 검사). 개수는 문서에서 센 것(exportDoc.exportDifferences) —
 * 이 함수는 id 를 문구로 바꿀 뿐이고, 형식마다 다른 건 글꼴 줄과 시트 줄뿐이라 그건 표(fontDiff · sheetCells)에서 고른다.
 */
export function diffLabel(d: ExportDiff, spec: ExportFormatSpec): string {
  switch (d.id) {
    case "tasks": return t("export.diff_tasks", { n: d.n });
    case "details": return t("export.diff_details", { n: d.n });
    case "dates": return t("export.diff_dates", { n: d.n });
    case "footnotes": return t("export.diff_footnotes", { n: d.n });
    case "font": return t(spec.fontDiff ?? "export.diff_font");
    case "table_style": return t("export.diff_table_style");
    case "remote_images": return t("export.diff_remote_images", { n: d.n });
    case "sheets":
      return spec.sheetCells === "raw" ? t("export.diff_sheets_md", { n: d.n }) : t("export.diff_sheets", { n: d.n });
    case "excluded": return t("export.diff_excluded", { n: d.n });
    case "rich_format": return t("export.diff_rich_format", { n: d.n });
  }
}
