// 파일 확장자별 분류 — 첨부 추출 정책 · 에디터 본문 드롭 · 섹션 가져오기가 각자 사본을 두지
// 않도록 여기 하나로 모은다(.claude/CLAUDE.md 코드 방침: 두 번째 사용처가 있을 때만 추상화,
// 여기서는 이미 세 곳이 같은 확장자 판정을 필요로 했다).

/** 파일명/경로의 확장자(소문자, 점 제외). '/' 와 '\\' 구분자 모두 처리한다(Windows 드래그&드롭/
 *  파일 다이얼로그 경로는 '\\'). 확장자가 없으면 "" (예: ".gitignore"). */
export function fileExt(path: string): string {
  const m = path.match(/\.([^./\\]+)$/);
  return m ? m[1].toLowerCase() : "";
}

/** repo/extraction.rs::extract_markdown 이 지원하는 확장자 — source_add_file(검색 가능한 텍스트)로
 *  라우팅한다. 첨부 추출 정책(useAttachmentActions.ts)과 탭 아이콘 판정(tileIcon.tsx)이 공유. */
export const EXTRACTABLE_EXTS = new Set(["pdf", "docx", "txt", "md", "pptx"]);

/** repo/attachments/mod.rs::kind_from_ext 의 이미지 분기와 반드시 동일해야 한다 — 프런트가
 *  attachment_add_file 을 부르기 *전에* 이미지 여부를 확장자로 먼저 판정해야 하는 유일한 곳
 *  (에디터 본문 드롭의 3갈래 분기)이 이 목록을 쓴다. 어긋나면 회귀(이미지가 노드로 안 꽂히거나
 *  반대로 섹션 가져오기로 잘못 라우팅됨). */
export const ATTACHMENT_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tiff", "heic", "heif"]);

/** repo/attachments/mod.rs::kind_from_ext 의 오디오 분기와 같아야 한다. weba/opus 는 폰 녹음기
 *  (MediaRecorder audio/webm;codecs=opus)가 붙이는 이름이다 — .webm 은 동영상으로 남는다. */
export const ATTACHMENT_AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "weba", "opus"]);

/** 이미지로 분류되지만 웹뷰(Chromium)가 못 그리는 형식 — 썸네일/원본 `<img>` 모두 실패한다.
 *  repo/attachments/thumbs.rs::thumb_undecodable 에서 heic/heif 가 같은 이유로 빠진다(svg 는 벡터라 그려진다).
 *  ponytail: 변환은 하지 않는다(안드로이드 카메라·갤러리는 대개 JPEG) — 필요해지면 서버 변환. */
export const UNRENDERABLE_IMAGE_EXTS = new Set(["heic", "heif"]);

/** 웹뷰가 스스로 재생할 수 있는 동영상 — `<video>` 하나면 되는 것들만 담는다. WebView2 는
 *  Edge/Chromium 이라 H.264 mp4 · webm · ogv 를 재생하고, .mov 는 안이 H.264 면 재생된다(보통 그렇다).
 *  mkv/avi/wmv 는 빼둔다 — 목록에 넣어봐야 검은 화면이 뜨고 "외부에서 열기"가 더 정직하다.
 *
 *  **kind 를 새로 만들지 않는다.** 첨부 kind 는 DB 에 저장돼 있어(kind_from_ext) 새 kind 를 들이면
 *  기존 행 마이그레이션 · 갤러리 필터 탭 · 모바일 분류가 줄줄이 따라온다. pdf·html 도 kind 는
 *  "doc" 이고 확장자로 갈린다 — 동영상도 같은 자리에 둔다. */
export const ATTACHMENT_VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);

/** 카메라 RAW — **`ATTACHMENT_IMAGE_EXTS` 에 넣지 마라.** 넣는 순간 앱이 "그릴 수 있다" 고
 *  거짓말한다: 웹뷰(Chromium)가 RAW 를 디코드하지 못해 `<img>` 가 빈 화면이 되고, 썸네일용
 *  `image` 크레이트도 jpeg/png/gif/bmp/webp/tiff 만 켜져 있어 CR2 를 못 읽는다(CR2 가 TIFF
 *  구조여도 센서 데이터라 마찬가지다). 그래서 kind 는 "doc" 그대로 두고, 이 목록은 **왜 안
 *  보이는지 정직하게 말하기 위해서만** 쓴다 — 일반 파일이 아니라 사진이라는 것까지는 안다.
 *
 *  ponytail: 실제로 보여주려면 RAW 안에 카메라가 넣어둔 JPEG 프리뷰를 꺼내야 한다(카메라 LCD 가
 *  보여주는 그것). 벤더마다 위치가 달라 별도 파서가 필요해 이번 범위 밖이다. */
export const RAW_IMAGE_EXTS = new Set([
  "cr2", "cr3", "nef", "nrw", "arw", "srf", "sr2", "dng", "orf", "raf", "rw2", "pef", "srw", "raw",
]);

/** 코드 뷰어(preview/CodeBody.tsx)로 보여주는 소스·스크립트 확장자 — repo/attachments/mod.rs::read_text 의
 *  허용 목록과 **같아야** 한다(어긋나면 뷰어가 VALIDATION 으로 죽는다). json/yaml 은 그쪽에 원래 있던 것. */
export const CODE_PREVIEW_EXTS = new Set([
  "py", "pyw", "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "go", "java", "kt", "kts", "c", "h", "cc", "cpp", "hpp", "cs", "rb", "php", "swift", "lua", "r", "sh", "bash", "zsh", "ps1", "bat", "cmd", "sql", "css", "scss", "less", "xml", "toml", "ini", "cfg", "conf", "vue", "svelte", "dart", "gradle", "mk", "json", "yaml", "yml",
]);
/** 하이라이트 없이 고정폭으로만 보여주는 텍스트(read_text 가 허용하는 나머지). */
export const PLAIN_MONO_EXTS = new Set(["csv", "log", "vtt"]);

/** section_import_file 이 text 섹션으로 만드는 확장자 (specs/commands/sections.yaml). */
export const SECTION_TEXT_IMPORT_EXTS = new Set(["md", "txt", "docx", "pdf", "hwpx", "pptx"]);
/** section_import_file 이 sheet 섹션으로 만드는 확장자. xlsx는 워크시트 한 장당 섹션 하나가
 *  되므로(SectionImportFileOutput.sections가 배열인 이유) 여기 다른 확장자와 달리 결과가
 *  여러 개일 수 있다 — specs/commands/sections.yaml 참고. */
export const SECTION_SHEET_IMPORT_EXTS = new Set(["csv", "tsv", "xlsx"]);
/** section_import_file 이 지원하는 전체 확장자 — 에디터 본문 드롭의 "가져오기" 갈래 판정에 쓴다. */
export const SECTION_IMPORT_EXTS: ReadonlySet<string> = new Set([
  ...SECTION_TEXT_IMPORT_EXTS,
  ...SECTION_SHEET_IMPORT_EXTS,
]);

/** doc_import_html(서식 있는 HTML 로 가져오기, specs/commands/sections.yaml)이 받는 확장자 — hwpx · docx.
 *  SECTION_TEXT_IMPORT_EXTS 의 부분집합이어야 한다(서식형이 실패하면 section_import_file 로 물러나므로). */
export const DOC_IMPORT_HTML_EXTS: ReadonlySet<string> = new Set(["hwpx", "docx"]);

/** 첨부 타일 우클릭 "섹션으로 가져오기" 메뉴 표시 여부(AttachmentsTilesStrip.tsx). rel_path 가
 *  없는 첨부(link/note/internal — 디스크 파일이 없다)와 SECTION_IMPORT_EXTS 밖의 확장자(이미지
 *  등)는 대상이 아니다. 데스크톱 전용 판정(브라우저 모드에서는 baseDir 가 파일 경로가 아니라
 *  HTTP 접두사 — attachmentsBase.ts)은 호출자가 isBrowser() 로 따로 건다. */
export function canPromoteAttachment(relPath: string | null): boolean {
  return !!relPath && SECTION_IMPORT_EXTS.has(fileExt(relPath));
}
