/**
 * 글꼴 지연 로더 — docs/PLAN-2026-10-27-fonts.md §5.2. lib/appearance.ts 가 동적 import 로만 부른다
 * (카탈로그 JSON·Paper Mono 파일이 부팅 번들에 실리지 않게).
 *
 * 등록은 FontFace API 로 한다 — `@font-face` 문자열을 주입하지 않으므로 CSS 이스케이프 문제가 없다.
 * 받은 글꼴 파일은 asset 프로토콜로 읽는다(tauri.conf.json 의 font-src·assetProtocol.scope).
 */
import catalogJson from "./catalog.json";
import paperMonoRegular from "../../assets/fonts/paper-mono/PaperMono-Regular.woff2?url";
import paperMonoSemiBold from "../../assets/fonts/paper-mono/PaperMono-SemiBold.woff2?url";
import { callSilent } from "../invoke";
import { reportFallback } from "../diag";
import { isBrowser } from "../env";
import previewsJson from "./previews.json";
import { catalogFamily, catalogIdOf, previewFamily } from "./stacks";

/**
 * 설치본에 통째로 들어 있는 카탈로그 글꼴(2026-10-28) — 받지 않아도 "받은 글꼴"이다.
 * scripts/gen-font-previews.py 의 BUNDLED 와 같은 목록(src/assets/fonts/bundled/<id>/ 에 모든 면이 있다).
 * 합계 약 0.8MB. 부팅 CSS 가 아니라 이 모듈(동적 import)에서만 참조되므로 부팅 번들은 늘지 않는다.
 */
export const BUNDLED_IDS: readonly string[] = ["hahmlet", "do-hyeon", "black-han-sans"];
export const isBundledFont = (id: string): boolean => BUNDLED_IDS.includes(id);

const bundledUrls = import.meta.glob("../../assets/fonts/bundled/*/*.woff2", { query: "?url", import: "default" }) as Record<
  string,
  () => Promise<string>
>;
const previewUrls = import.meta.glob("../../assets/fonts/previews/*.woff2", { query: "?url", import: "default" }) as Record<
  string,
  () => Promise<string>
>;

const previewRegistered = new Set<string>();
/**
 * 설정 글꼴 목록이 모든 카탈로그 글꼴(받은 것·받지 않은 것·설치본 내장)을 자기 글꼴로 미리 보이게, 이름 글자만 담은
 * 작은 파일(수 KB)을 등록한다. 이름에 없는 글자(크기·굵기 안내 등)는 패밀리 폴백으로 기본 글꼴이 그린다.
 * 실패는 기록하고 미리보기만 포기한다.
 * `.load()` 를 강제하지 않는다 — 등록만 해 두면 목록이 실제로 그려질 때 브라우저가 그 글꼴만 지연 로드한다.
 */
export async function loadPreviews(ids: string[]): Promise<void> {
  const index = previewsJson as Record<string, Array<{ file: string; unicode_range?: string }>>;
  await Promise.all(
    ids
      .filter((id) => !previewRegistered.has(id) && index[id])
      .map(async (id) => {
        previewRegistered.add(id);
        try {
          const faces = await Promise.all(
            index[id].map(async (e) => {
              const load = previewUrls[`../../assets/fonts/previews/${e.file}`];
              if (!load) throw new Error(`preview asset missing: ${e.file}`);
              return { src: await load(), weight: 400, unicodeRange: e.unicode_range };
            }),
          );
          await addFaces(previewFamily(id), faces, false);
        } catch (e) {
          previewRegistered.delete(id);
          reportFallback("fonts", "preview_register_failed", `${id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }),
  );
}

export interface CatalogFace {
  weight: 400 | 600;
  file: string;
  url: string;
  sha256: string;
  bytes: number;
  unicode_range?: string;
}

export interface CatalogFont {
  id: string;
  /** 표시 이름(고유명사라 i18n 하지 않는다). */
  name: string;
  family: string;
  /** body = 본문·화면 겸용 · display = 손글씨·장식(노트 본문 글꼴 목록에만, Q2) · mono = 코드체. */
  role: "body" | "display" | "mono";
  hangul: boolean;
  category: string;
  /** 1 = 한 단뿐(600 은 브라우저의 가짜 굵게, §5.3) · 2 = 400/600 이 진짜로 구분됨. */
  weights: 1 | 2;
  license: string;
  copyright: string;
  source: string;
  faces: CatalogFace[];
}

export const CATALOG: readonly CatalogFont[] = (catalogJson as { fonts: CatalogFont[] }).fonts;

/** 설정 목록용 — 노트 본문(text)은 body+display, 앱 화면은 body, 코드체는 mono. */
export function catalogFor(target: "editor" | "ui" | "mono"): CatalogFont[] {
  const roles = target === "editor" ? ["body", "display"] : target === "ui" ? ["body"] : ["mono"];
  return CATALOG.filter((f) => roles.includes(f.role));
}

/** 다운로드 크기(바이트) — 설정 목록에 "1.2MB" 로 보여줄 값. */
export function catalogBytes(font: CatalogFont): number {
  return font.faces.reduce((s, f) => s + f.bytes, 0);
}

const registered = new Map<string, Promise<void>>();

/** `eager` = 등록 전에 파일을 미리 받아 둔다(실제로 쓰는 글꼴). false 면 등록만 — 쓰일 때 브라우저가 받는다(목록 미리보기). */
async function addFaces(
  family: string,
  faces: Array<{ src: string; weight: number; unicodeRange?: string }>,
  eager = true,
) {
  const loaded = await Promise.all(
    faces.map((f) => {
      const face = new FontFace(family, `url("${f.src}") format("woff2")`, {
        weight: String(f.weight),
        display: "swap",
        ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}),
      });
      return eager ? face.load() : face;
    }),
  );
  // 순서가 뜻이 있다: 한국어 글꼴은 korean(범위 없음) 다음 latin(라틴 범위) — 나중 것이 겹치는 범위를 가져간다.
  for (const ff of loaded) document.fonts.add(ff);
}

let basePromise: Promise<{ base: string; convert: (p: string) => string }> | null = null;
function fontsBase() {
  basePromise ??= (async () => {
    const [{ convertFileSrc }, { base }] = await Promise.all([
      import("@tauri-apps/api/core"),
      callSilent<{ base: string }>("fonts_base_dir"),
    ]);
    return { base, convert: convertFileSrc };
  })().catch((e: unknown) => {
    basePromise = null; // 다음 호출이 다시 묻게
    throw e;
  });
  return basePromise;
}

/**
 * 받지 않은 글꼴 — `registered` 에 정상 완료로 남기면 나중에 설정에서 받아도 이 창이 재시작 전까지 대체 글꼴로 그린다.
 * 그래서 throw 해서 `loadFonts` 의 catch 가 기억을 지우게 한다. 장애가 아니므로 register_failed 로 세지 않는다.
 */
class NotInstalledError extends Error {
  constructor(readonly id: string) {
    super(`font not installed: ${id}`);
  }
}
/** id 당 한 번만 진단에 남긴다 — 매 시도마다 쌓이지 않게. */
const notInstalledReported = new Set<string>();
/**
 * 미설치 판정의 짧은 음성 캐시(id → 판정 시각). applyCssVars 가 슬라이더 틱마다 loadFonts 를 부르는데, 미설치는
 * 기억을 안 남기므로 이게 없으면 틱마다 font_status IPC 가 나간다. forgetFont(받기 완료)가 지운다.
 */
const NOT_INSTALLED_TTL_MS = 5000;
const notInstalledAt = new Map<string, number>();

async function registerCatalog(id: string): Promise<void> {
  // 동기화 브라우저 뷰어: fonts_* 는 http:false 라 부르면 NOT_FOUND 만 쌓인다(emojiBase.ts 의 skipStatus 와
  // 같은 이유). 이 기기는 받은 적이 없고 스택 끝 번들 글꼴로 그려진다.
  const bundled = isBundledFont(id);
  if (isBrowser() && !bundled) return;
  const font = CATALOG.find((f) => f.id === id);
  if (!font) {
    reportFallback("fonts", "unknown_catalog_id", id);
    return;
  }
  if (isBundledFont(id)) {
    const faces = await Promise.all(
      font.faces.map(async (f) => {
        const load = bundledUrls[`../../assets/fonts/bundled/${id}/${f.file}`];
        if (!load) throw new Error(`bundled asset missing: ${id}/${f.file}`);
        return { src: await load(), weight: f.weight, unicodeRange: f.unicode_range };
      }),
    );
    await addFaces(catalogFamily(id), faces);
    return;
  }
  const missAt = notInstalledAt.get(id);
  if (missAt !== undefined && Date.now() - missAt < NOT_INSTALLED_TTL_MS) throw new NotInstalledError(id);
  const status = await callSilent<{ installed: string[] }>("font_status");
  if (!status.installed.includes(id)) {
    // 받지 않은 글꼴(예: 다른 기기에서 고른 노트북 설정) — 스택 끝 번들 글꼴로 그려진다.
    // ponytail: 자동으로 받지 않는다. 받기는 설정 화면에서 사용자가 누른다(W5).
    notInstalledAt.set(id, Date.now());
    throw new NotInstalledError(id);
  }
  notInstalledAt.delete(id);
  const { base, convert } = await fontsBase();
  await addFaces(
    catalogFamily(id),
    font.faces.map((f) => ({ src: convert(`${base}/${id}/${f.file}`), weight: f.weight, unicodeRange: f.unicode_range })),
  );
}

function register(value: string): Promise<void> {
  const id = catalogIdOf(value);
  if (id !== null) return registerCatalog(id);
  if (value === "paper-mono") {
    return addFaces("Paper Mono", [
      { src: paperMonoRegular, weight: 400 },
      { src: paperMonoSemiBold, weight: 600 },
    ]);
  }
  return Promise.resolve();
}

/** 설정값들에 필요한 글꼴을 한 번씩만 등록한다. 실패는 기록하고 다음 기회에 다시 시도한다. */
export function loadFonts(values: Array<string | undefined>): Promise<void> {
  return Promise.all(
    values.map((v) => {
      if (!v) return undefined;
      let p = registered.get(v);
      if (!p) {
        p = register(v).catch((e: unknown) => {
          registered.delete(v);
          if (e instanceof NotInstalledError) {
            if (!notInstalledReported.has(e.id)) {
              notInstalledReported.add(e.id);
              reportFallback("fonts", "not_installed", e.id);
            }
            return;
          }
          reportFallback("fonts", "register_failed", `${v}: ${e instanceof Error ? e.message : String(e)}`);
        });
        registered.set(v, p);
      }
      return p;
    }),
  ).then(() => undefined);
}

/** 방금 받은 글꼴을 다시 등록할 수 있게 기억을 지운다(설정 화면이 받기 완료 뒤 부른다). 미설치 음성 캐시도 같이. */
export function forgetFont(value: string): void {
  registered.delete(value);
  const id = catalogIdOf(value);
  if (id !== null) notInstalledAt.delete(id);
}

/**
 * 사용자 PC 에 설치된 글꼴 패밀리 이름(§5.4). WebView2 의 Local Font Access(`queryLocalFonts`)를
 * 쓴다 — 없거나 거부되면 throw 하고, 호출자(설정 화면)는 직접 입력 칸으로 물러난다.
 * ponytail: API 가 막히는 환경이 실제로 나오면 Rust fontdb 열거로.
 */
export async function listSystemFonts(): Promise<string[]> {
  const q = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts;
  if (!q) throw new Error("queryLocalFonts unavailable");
  const fonts = await q();
  return [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
}
