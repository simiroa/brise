/**
 * 글꼴 설정값 → CSS font-family 스택 — docs/PLAN-2026-10-27-fonts.md §5.
 *
 * 부팅 경로(lib/appearance.ts)가 쓰므로 **카탈로그 JSON 을 import 하지 않는다**(부팅 번들 래칫) —
 * 값의 모양만 보고 스택을 만들고, 실제 글꼴 등록은 지연 로더(./loader.ts)가 한다.
 *
 * 설정값(font_family · font_editor · font_mono 공통) 세 부류:
 * - 번들 id — `pretendard` · `serif` · `sans` · `source-code-pro` · `paper-mono`
 * - `catalog:<id>` — 내려받기 글꼴(catalog.json). 등록 이름은 `brise-<id>` 로 따로 둬서 같은 이름의
 *   시스템 글꼴과 섞이지 않게 한다.
 * - 그 밖 = 사용자 PC 에 설치된 글꼴 이름.
 * 어떤 경우든 스택 끝은 번들 글꼴이라 받지 않았거나 없는 글꼴이어도 글자는 그려진다.
 */

export type FontRole = "text" | "mono";

export const DEFAULT_FONT_MONO = "source-code-pro";
const CATALOG_PREFIX = "catalog:";

const TEXT_FALLBACK = '"Pretendard", system-ui, sans-serif';
// tokens.css :root 의 --font-mono 와 같은 값이어야 한다(기본값은 오늘 화면 그대로).
const MONO_DEFAULT_STACK = '"Source Code Pro", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
// 라틴 전용 코드체의 한글은 번들 Pretendard 로 넘어간다.
const MONO_FALLBACK = '"Source Code Pro", "Pretendard", ui-monospace, monospace';

const BUNDLED: Record<string, string> = {
  pretendard: '"Pretendard", "Source Sans 3", system-ui, sans-serif',
  serif: '"Source Serif 4", "Noto Serif KR", serif',
  sans: '"Source Sans 3", "Noto Sans KR", system-ui, sans-serif',
  "source-code-pro": MONO_DEFAULT_STACK,
  "paper-mono": `"Paper Mono", ${MONO_FALLBACK}`,
};

/** 지연 로드가 필요한 번들 글꼴(부팅 CSS 에 @font-face 가 없는 것). */
export const LAZY_BUNDLED = new Set(["paper-mono"]);

export function catalogValue(id: string): string {
  return CATALOG_PREFIX + id;
}

/** `catalog:<id>` 면 id, 아니면 null. */
export function catalogIdOf(value: string): string | null {
  return value.startsWith(CATALOG_PREFIX) ? value.slice(CATALOG_PREFIX.length) : null;
}

export function catalogFamily(id: string): string {
  return `brise-${id}`;
}

/** 미리보기 전용 패밀리 이름 — 실제 글꼴 패밀리(brise-<id>)와 섞이지 않는다. 이름 글자만 들어 있다(loader.ts loadPreviews). */
export function previewFamily(id: string): string {
  return `brise-preview-${id}`;
}

export function fontStack(value: string, role: FontRole): string {
  const fallback = role === "mono" ? MONO_FALLBACK : TEXT_FALLBACK;
  const bundled = BUNDLED[value];
  if (bundled) return bundled;
  const id = catalogIdOf(value);
  // 따옴표·역슬래시는 CSS 문자열을 깨므로 이름에서 걷어낸다(시스템 글꼴 이름은 직접 입력이다).
  const name = id !== null ? catalogFamily(id) : value.replace(/["\\]/g, "").trim();
  return name ? `"${name}", ${fallback}` : role === "mono" ? MONO_DEFAULT_STACK : BUNDLED.pretendard;
}

/** 이 값이 지연 로더를 불러야 하는가(내려받기 글꼴·지연 번들). */
export function needsLoader(value: string | undefined): boolean {
  return !!value && (LAZY_BUNDLED.has(value) || catalogIdOf(value) !== null);
}
