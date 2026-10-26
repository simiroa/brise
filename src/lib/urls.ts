/**
 * URL 판별 헬퍼. 원래 EditorPanel.tsx 안에 있었지만(P2 3단계 링크 붙여넣기 제안) 펫 클립보드
 * 저장(docs/PLAN-2026-08-08-presets-schedule.md Q9)이 **같은 판별**을 써야 해서 여기로 옮겼다 —
 * 두 경로가 "무엇이 링크인가"에 대해 서로 다른 규칙을 갖게 두지 않는다.
 */
import {
  ATTACHMENT_IMAGE_EXTS,
  ATTACHMENT_VIDEO_EXTS,
  EXTRACTABLE_EXTS,
  RAW_IMAGE_EXTS,
  SECTION_SHEET_IMPORT_EXTS,
  fileExt,
} from "./fileKinds";

/** `text` 가 **오직** URL 하나일 때만 그 URL. 문장 속 링크·공백 포함 텍스트는 null이다.
 *  손으로 만든 정규식 대신 네이티브 URL 생성자로 검증한다(ponytail: 플랫폼 기능 우선) —
 *  서버가 가져올 수 있는 건 http(s) 뿐이라 스킴도 거기서 자른다(repo::web_reader 와 동일). */
export function soleUrlFromPasteText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    return u.protocol === "http:" || u.protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * 앱이 **본문을 읽어올 수 있을 가능성이 있는** 링크인가 — 붙여넣기 넛지/우클릭 메뉴가 "페이지
 * 내용 추출"을 제안할지 가르는 자체검토다. Rust 쪽 최종 판정(repo::web_reader::fetch_reader)은
 * http(s) 가 아니면 거부하고 **HTML 이 아닌 content-type 도 거부**한다 — 여기서는 그 두 규칙 중
 * 네트워크 없이 미리 알 수 있는 부분만 본다: 스킴과, 확장자로 이미 드러난 비-HTML 문서.
 *
 * ponytail: **정적 검사다.** 붙여넣는 순간 실제로 fetch 해 보면 더 정확하지만, 그건 사용자가
 * 요청하지 않은 원격 요청을 링크마다 한 번씩 보내는 것이고 이 저장소의 규칙(첨부 커맨드
 * attachment_fetch_reader 주석: "명시적 사용자 액션에서만 fetch, 백그라운드 프리페치 금지")과
 * 정면으로 어긋난다. 그래서 제안은 낙관적으로 띄우고, 실제 실패는 누른 뒤 정직하게 알린다
 * (lib/linkImport.ts). 프리페치를 허용하기로 결정하면 그때 여기서 fetch 를 한 번 돌리면 된다.
 */
export function linkBodyMaybeReadable(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return !NON_HTML_URL_EXTS.has(fileExt(u.pathname));
}

/** 확장자만으로 "이건 HTML 문서가 아니다"가 확정되는 것들 — lib/fileKinds.ts 의 기존 집합 합집합. */
const NON_HTML_URL_EXTS: ReadonlySet<string> = new Set([
  ...EXTRACTABLE_EXTS,
  ...ATTACHMENT_IMAGE_EXTS,
  ...ATTACHMENT_VIDEO_EXTS,
  ...RAW_IMAGE_EXTS,
  ...SECTION_SHEET_IMPORT_EXTS,
]);

/** 사용자의 링크를 **앱 밖에서** 연다 — 데스크톱은 OS 기본 브라우저(plugin-opener), 플러그인이
 *  없는 브라우저 모드면 새 탭. 앱 웹뷰 안에서 열지 않는다(돌아올 길이 없다). */
export async function openExternalUrl(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** 넛지·메뉴에 쓰는 사람이 읽는 출처 이름 — "www." 를 뗀 호스트. 파싱 실패면 URL 그대로. */
export function linkSiteLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
