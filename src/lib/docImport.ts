import { call, callSilent, emitNotice } from "./invoke";
import { DOC_IMPORT_HTML_EXTS, fileExt } from "./fileKinds";
import { reportFallback } from "./diag";
import { yieldFrame } from "./yieldFrame";
import type {
  DocImportDropped,
  DocImportHtmlOutput,
  Section,
  SectionImportFileOutput,
} from "./commands.gen";
import { t } from "../i18n/t";

// 문서 가져오기(파일 하나 → 섹션들)의 갈래. 배치(스캔·진행 토스트·되돌리기)는 lib/noteActions.ts 의
// importFilesAsSections 가 맡고, 파일 하나를 어떻게 섹션으로 만드는지(서식형 → 텍스트 추출 후퇴)와
// "옮기지 못한 요소" 알림 문구 조립만 여기 있다. 이 모듈은 noteActions 를 import 하지 않는다(순환 금지).
// 서식형 대상은 hwpx · docx(fileKinds.ts DOC_IMPORT_HTML_EXTS). 새 서식형 포맷은 그 목록과 importRichHtml 한 곳에 붙는다.

/** 한 파일을 섹션으로 만든 결과 — importFilesAsSections 가 파일마다 합산한다. */
export interface ImportedFile {
  sections: Section[];
  truncated: boolean;
  /** 서식형(doc_import_html)으로만 채워진다 — 옮기지 못한 요소의 종류별 개수. */
  dropped: DocImportDropped[];
  /** 서식형 대상이었는데 글자만 가져왔다(U-1) — 배치 끝에 한 번 알린다. */
  fellBackToText?: boolean;
}

/** 거절 값에서 에러 **코드만** 꺼낸다 — 진단 기록에 경로·본문이 새면 안 되므로 message 는 쓰지 않는다.
 *  Tauri 는 인자 오류 같은 경우 AppError 가 아니라 맨 문자열로 거절하므로 객체가 아닐 수도 있다. */
function rejectionCode(e: unknown): string {
  if (e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string") {
    return (e as { code: string }).code;
  }
  return "unknown";
}

/** 암호화 HWPX 는 텍스트 추출로도 못 읽는다 — 폴백하지 않고 진짜 사유를 보여 준다(U-1).
 *  Rust 쪽 사유 문자열(`encrypted hwpx is not supported`)로 판별한다. */
function isEncryptedRejection(e: unknown): boolean {
  const m = e && typeof e === "object" && "message" in e ? (e as { message: unknown }).message : null;
  return typeof m === "string" && m.includes("encrypted");
}

/**
 * importRichHtml: 서식 있는 문서(hwpx · docx)를 doc_import_html → mdSerializeHtml → section_create_with_body
 * 로 섹션 하나로 만든다. 서식형으로 **못 만들었으면 null** — 호출자가 section_import_file(텍스트 추출)로
 * 물러난다. 물러나는 경계는 셋이다: doc_import_html 거절(VALIDATION·IO 등) · html→본문 직렬화 예외 ·
 * 직렬화 결과가 빈 문자열(빈 섹션을 만드느니 텍스트 추출이 낫다). 셋 다 reportFallback 으로 남긴다 —
 * 코드에 형식을 넣는다(`hwpx_rich_failed`·`docx_rich_failed` …). diag.rs 가 (feature, code) 로 60초 묶어서, 형식 없는
 * 코드면 같은 배치에서 hwpx 뒤에 난 docx 실패가 사라진다. ext 는 DOC_IMPORT_HTML_EXTS 안의 값뿐이다(경로·본문은 절대 담지 않는다).
 *
 * section_create_with_body 실패는 물러나지 **않는다** — call() 이 토스트를 이미 띄웠고 같은 노트로 가는
 * section_import_file 이 성공할 이유도 없다. 던져진 채로 runBatch 가 그 파일을 실패로 센다.
 *
 * mdSerialize 는 동적 import — noteActions 는 펫 브리지 등 25곳이 끌어 쓰는데 정적으로 걸면 TipTap
 * 스키마 전체가 같이 딸려 온다. 서식형 문서를 실제로 가져올 때만 읽는다(이미 에디터가 올려 둔 모듈이라 캐시 히트).
 *
 * 그림(BinData)은 doc_import_html 이 노트의 첨부로 저장한다 — 섹션을 되돌려도(undoImportedSections)
 * 첨부는 남는다. 섹션 삭제가 원래 첨부를 지우지 않는 관례와 같다.
 * ponytail: 되돌리기 뒤 그림 첨부가 노트에 남는다(첨부 바에서 사용자가 지울 수 있다). 업그레이드 경로는
 * doc_import_html 이 만든 rel_path 를 되돌리기 클로저에 실어 함께 지우는 것 — 지금은 하지 않는다.
 */
async function cleanupAttachments(attachmentIds: string[] | undefined): Promise<void> {
  if (!attachmentIds?.length) return;
  for (const id of attachmentIds) {
    try {
      await callSilent("attachment_remove", { id });
    } catch (e) {
      reportFallback("doc-import", "attachment_cleanup_failed", `id=${id} error=${e instanceof Error ? e.name : "error"}`);
    }
  }
}

async function importRichHtml(noteId: string, path: string, ext: string): Promise<ImportedFile | null> {
  let out: DocImportHtmlOutput;
  try {
    out = await callSilent<DocImportHtmlOutput>("doc_import_html", { note_id: noteId, file_path: path });
  } catch (e) {
    if (isEncryptedRejection(e)) {
      emitNotice(t("export.import_encrypted"));
      throw e;
    }
    reportFallback("doc-import", `${ext}_rich_failed`, `ext=${ext} code=${rejectionCode(e)}`);
    return null;
  }
  let bodyMd: string;
  try {
    const { mdSerializeHtml } = await import("./mdSerialize");
    await yieldFrame();
    bodyMd = mdSerializeHtml(out.html);
  } catch (e) {
    await cleanupAttachments(out.attachment_ids);
    // 직렬화 예외의 message 는 입력 조각을 품을 수 있다 — 이름만 남긴다(safeErrorDetail 과 같은 이유).
    reportFallback("doc-import", `${ext}_rich_serialize_failed`, `ext=${ext} error=${e instanceof Error ? e.name : "error"}`);
    return null;
  }
  if (!bodyMd.trim()) {
    await cleanupAttachments(out.attachment_ids);
    reportFallback("doc-import", `${ext}_rich_empty`, `ext=${ext} falling back to text extraction`);
    return null;
  }
  try {
    const section = await call<Section>("section_create_with_body", {
      note_id: noteId,
      name: out.name,
      body_md: bodyMd,
    });
    // `?? []` — 섹션은 이미 만들어졌다. dropped 가 빠진 응답 때문에 합산에서 던지면 만든 섹션을 실패로 세게 된다.
    return { sections: [section], truncated: false, dropped: out.dropped ?? [] };
  } catch (e) {
    await cleanupAttachments(out.attachment_ids);
    throw e;
  }
}

/**
 * importOneFile: "파일 하나 → 섹션들" 의 유일한 지점 — 확장자가 서식형 대상(DOC_IMPORT_HTML_EXTS)이면
 * importRichHtml 을 먼저 시도하고, 아니거나 못 만들었으면 기존 section_import_file. importFilesAsSections
 * 의 배치 워커만 이걸 부른다(TitleBar 다중 선택·에디터 드롭·첨부 타일 "섹션으로 가져오기"가 전부 그
 * 배치를 지나가므로 호출부가 따로 갈릴 일이 없다).
 */
export async function importOneFile(noteId: string, path: string): Promise<ImportedFile> {
  const ext = fileExt(path);
  if (DOC_IMPORT_HTML_EXTS.has(ext)) {
    const rich = await importRichHtml(noteId, path, ext);
    if (rich) return rich;
    const out = await call<SectionImportFileOutput>("section_import_file", {
      note_id: noteId,
      file_path: path,
    });
    return { sections: out.sections, truncated: out.truncated, dropped: [], fellBackToText: true };
  }
  const out = await call<SectionImportFileOutput>("section_import_file", {
    note_id: noteId,
    file_path: path,
  });
  return { sections: out.sections, truncated: out.truncated, dropped: [] };
}

// doc_import_html 이 보고하는 dropped.kind → 알림 라벨 키. 리터럴로 두는 이유: check-i18n 의 미사용 키
// 검사가 `"키"` 문자열 리터럴로 참조를 찾는다(템플릿 조립이면 동적 접두어 등록이 따로 필요하다).
// Map 인 이유: 모르는 kind("constructor" 같은)가 객체 프로토타입에 걸리지 않게.
const DROPPED_KIND_LABEL_KEYS = new Map<string, string>([
  ["header_footer", "editor.doc_import_kind_header_footer"],
  ["equation", "editor.doc_import_kind_equation"],
  ["shape", "editor.doc_import_kind_shape"],
  ["ole", "editor.doc_import_kind_ole"],
  ["chart", "editor.doc_import_kind_chart"],
  ["image_format", "editor.doc_import_kind_image_format"],
  ["field", "editor.doc_import_kind_field"],
  ["image_missing", "editor.doc_import_kind_image_missing"],
  ["image_limit", "editor.doc_import_kind_image_limit"],
  ["comment", "editor.doc_import_kind_comment"], // docx 메모
  ["symbol", "editor.doc_import_kind_symbol"], // docx w:sym 중 옮기지 못한 기호 글꼴 글자
]);
const DROPPED_KIND_OTHER_KEY = "editor.doc_import_kind_other";

/** 파일 하나의 dropped 를 배치 합계(라벨 키별)에 더한다. 모르는 kind 는 전부 "기타" 한 줄로 모은다. */
export function addDropped(acc: Map<string, number>, dropped: DocImportDropped[]): void {
  for (const d of dropped) {
    if (!(d.count > 0)) continue;
    const key = DROPPED_KIND_LABEL_KEYS.get(d.kind) ?? DROPPED_KIND_OTHER_KEY;
    acc.set(key, (acc.get(key) ?? 0) + d.count);
  }
}

/** 배치 합계 → "그대로 못 가져온 것 3개 — 머리말·꼬리말 1, 수식 2". 없으면 null. "기타" 는 맨 뒤. */
export function droppedNotice(acc: Map<string, number>): string | null {
  let total = 0;
  const entries = [...acc].sort(
    ([a], [b]) => Number(a === DROPPED_KIND_OTHER_KEY) - Number(b === DROPPED_KIND_OTHER_KEY),
  );
  const parts: string[] = [];
  for (const [labelKey, n] of entries) {
    total += n;
    parts.push(`${t(labelKey)} ${n}`);
  }
  return total > 0 ? t("editor.doc_import_dropped", { n: total, detail: parts.join(", ") }) : null;
}
