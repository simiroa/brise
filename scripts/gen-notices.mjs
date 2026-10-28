#!/usr/bin/env node
/**
 * THIRD-PARTY-NOTICES.html 생성기.
 *
 * 유료 판매 P0 — MIT/BSD/Apache/OFL/MPL 의존성 전부가 "저작권 고지 + 라이선스 전문 동봉"을
 * 요구한다. npm(license-checker) + Rust(cargo metadata)에서 프로덕션 의존성을 모두 모아
 * 라이선스 전문을 읽고, src-tauri/resources/THIRD-PARTY-NOTICES.html 로 번들에 동봉한다.
 *
 * 중복 제거: 라이선스 전문을 정규화(공백 트림)한 뒤 해시로 그룹핑한다 — 동일 MIT 사본이
 * 수백 개라 이걸 안 하면 수 MB가 된다. 저작권 줄이 다른 텍스트는 다른 해시가 되므로 자동으로
 * 따로 수록된다(이게 고지 보존의 핵심 — 저작권자별 사본을 뭉개지 않는다).
 *
 * 전문을 못 찾은 패키지(라이선스 파일이 아예 없는 경우)는 "name version — SPDX" 목록으로만
 * 모은다.
 *
 * 실행: node scripts/gen-notices.mjs (= npm run gen:notices). 산출물은 커밋 대상(빌드
 * 재현성) — 의존성을 추가/제거/업그레이드할 때마다 재실행한다(docs/RELEASING.md 참고).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_TAURI = join(ROOT, "src-tauri");
const OUT_FILE = join(SRC_TAURI, "resources", "THIRD-PARTY-NOTICES.html");
// 설정 > 라이선스 화면이 읽는 요약(2026-09-02 오너 지시). 전문 HTML 은 2.8MB 라 웹뷰에 물리지
// 않고 OS 로 열며, 화면에는 이 몇 줄만 앱 토큰으로 그린다 — 전문과 수치가 갈리지 않도록 같은
// 실행에서 함께 쓴다.
const SUMMARY_FILE = join(ROOT, "src", "lib", "noticesSummary.json");
const SPDX_TEXTS_DIR = join(ROOT, "scripts", "spdx-texts");
const SPDX_FALLBACK_PREFIX = "[표준 SPDX 전문 — 패키지에 라이선스 파일이 없어 대신 실음]";
const LICENSE_FILE_RE = /^(LICEN[CS]E|COPYING|NOTICE)/i;
const README_RE = /readme/i;

// ---------------------------------------------------------------------------
// Pure helpers (self-tested below before any real I/O happens).
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 공백 트림 + CRLF 정규화만 — 저작권 줄 등 실질 내용은 절대 건드리지 않는다(고지 보존). */
function normalizeText(text) {
  return text.replace(/\r\n/g, "\n").trim();
}

/**
 * 라이선스 표현식을 개별 SPDX ID 토큰으로 분리한다.
 * OR, AND, WITH (공백 구분), 괄호 (), 슬래시 / 를 구분자로 취급한다.
 * 'LGPL-2.1-or-later' 등 식별자 내부의 '-or-'는 하이픈 연결이므로 연산자로 오인하지 않는다.
 */
function parseSpdxExpression(expr) {
  if (!expr || expr === "UNKNOWN") return [];
  return expr
    .replace(/[()/]/g, " ")
    .replace(/\s+(?:OR|AND|WITH)\s+/gi, " ")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function getSpdxFallbackText(id) {
  const filePath = join(SPDX_TEXTS_DIR, `${id}.txt`);
  if (!existsSync(filePath)) return null;
  const raw = normalizeText(readFileSync(filePath, "utf8"));
  return `${SPDX_FALLBACK_PREFIX}\n\n${raw}`;
}

/**
 * 패키지 폴더에 라이선스 파일이 없는 패키지에 대해 선언된 SPDX 공식 표준 전문을 찾아 부착한다.
 * 식별자를 찾을 수 없는 경우(LicenseRef-*, UNKNOWN 등) texts는 빈 배열로 남아 noText로 분류된다.
 */
function attachSpdxFallbacks(packages) {
  for (const p of packages) {
    if (p.texts.length > 0) continue;
    const ids = [...new Set(parseSpdxExpression(p.spdx))];
    if (ids.length === 0) continue;
    const resolved = [];
    let hasUnresolved = false;
    for (const id of ids) {
      const fb = getSpdxFallbackText(id);
      if (fb) {
        resolved.push(fb);
      } else {
        hasUnresolved = true;
      }
    }
    if (!hasUnresolved && resolved.length > 0) {
      p.texts = resolved;
    }
  }
}

// dir 바로 아래에서 LICENSE / COPYING / NOTICE 류 파일을 전부 찾는다(README는 제외).
function scanLicenseFiles(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => LICENSE_FILE_RE.test(n) && !README_RE.test(n))
    .filter((n) => {
      try {
        return statSync(join(dir, n)).isFile();
      } catch {
        return false;
      }
    })
    .sort()
    .map((n) => join(dir, n));
}

/**
 * 패키지 목록을 라이선스 전문(파일 여러 개면 이어붙인 것) 해시로 그룹핑한다.
 * 텍스트가 하나도 없는 패키지는 별도로 반환(전문 미발견 목록용).
 */
function groupByLicenseText(packages) {
  const groups = new Map(); // hash -> { texts, packages }
  const noText = [];
  for (const p of packages) {
    if (p.texts.length === 0) {
      noText.push(p);
      continue;
    }
    const combined = p.texts.join("\n\n----------\n\n");
    const hash = createHash("sha256").update(combined).digest("hex");
    if (!groups.has(hash)) groups.set(hash, { texts: p.texts, packages: [] });
    groups.get(hash).packages.push(p);
  }
  const sortedGroups = [...groups.values()]
    .map((g) => ({ texts: g.texts, packages: g.packages.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.packages[0].name.localeCompare(b.packages[0].name));
  noText.sort((a, b) => a.name.localeCompare(b.name));
  return { groups: sortedGroups, noText };
}

function selfTest() {
  if (esc(`<a href="x">&y</a>`) !== "&lt;a href=&quot;x&quot;&gt;&amp;y&lt;/a&gt;") {
    throw new Error("selftest: esc() 이스케이프 실패");
  }
  if (normalizeText("  hi\r\nthere  \r\n") !== "hi\nthere") {
    throw new Error("selftest: normalizeText() 트림/CRLF 실패");
  }
  const pkgs = [
    { name: "a", version: "1.0.0", spdx: "MIT", texts: ["MIT text — copyright X"] },
    { name: "b", version: "2.0.0", spdx: "MIT", texts: ["MIT text — copyright X"] }, // same text as a
    { name: "c", version: "1.0.0", spdx: "MIT", texts: ["MIT text — copyright Y"] }, // different copyright
    { name: "d", version: "1.0.0", spdx: "ISC", texts: [] }, // no license file found
  ];
  const { groups, noText } = groupByLicenseText(pkgs);
  if (groups.length !== 2) throw new Error(`selftest: 동일 텍스트 그룹핑 실패 (got ${groups.length} groups)`);
  const abGroup = groups.find((g) => g.packages.some((p) => p.name === "a"));
  if (!abGroup || abGroup.packages.length !== 2) {
    throw new Error("selftest: 동일 저작권 텍스트를 가진 a/b가 한 그룹으로 안 묶임");
  }
  const cGroup = groups.find((g) => g.packages.some((p) => p.name === "c"));
  if (!cGroup || cGroup.packages.length !== 1) {
    throw new Error("selftest: 다른 저작권 텍스트(c)가 잘못 합쳐짐 — 고지 보존 위반");
  }
  if (noText.length !== 1 || noText[0].name !== "d") {
    throw new Error("selftest: 전문 미발견 패키지(d) 분류 실패");
  }

  // SPDX 표현식 분리 자체 테스트
  const parsed = parseSpdxExpression("(MIT OR Apache-2.0) AND ISC/Zlib WITH LLVM-exception");
  if (!parsed.includes("MIT") || !parsed.includes("Apache-2.0") || !parsed.includes("ISC") || !parsed.includes("Zlib") || !parsed.includes("LLVM-exception")) {
    throw new Error("selftest: parseSpdxExpression() 연산자 분리 실패");
  }
  const lgplParsed = parseSpdxExpression("MIT OR LGPL-2.1-or-later");
  if (lgplParsed.length !== 2 || lgplParsed[1] !== "LGPL-2.1-or-later") {
    throw new Error("selftest: parseSpdxExpression() LGPL-2.1-or-later 보존 실패");
  }

  // SPDX 표준 전문 폴백 및 미해결 패키지 자체 테스트
  const testFallbackPkgs = [
    { name: "e", version: "1.0.0", spdx: "MIT OR Apache-2.0", texts: [] },
    { name: "f", version: "1.0.0", spdx: "LicenseRef-foo", texts: [] },
  ];
  attachSpdxFallbacks(testFallbackPkgs);

  if (testFallbackPkgs[0].texts.length !== 2) {
    throw new Error(`selftest: MIT OR Apache-2.0 표준 전문 부착 실패 (got ${testFallbackPkgs[0].texts.length})`);
  }
  if (!testFallbackPkgs[0].texts[0].startsWith(SPDX_FALLBACK_PREFIX)) {
    throw new Error("selftest: 표준 전문 헤더 접두사 누락");
  }
  if (testFallbackPkgs[1].texts.length !== 0) {
    throw new Error("selftest: 미해결 식별자(LicenseRef-foo)에 텍스트가 잘못 부착됨");
  }

  const { groups: fbGroups, noText: fbNoText } = groupByLicenseText(testFallbackPkgs);
  const eInGroup = fbGroups.some((g) => g.packages.some((p) => p.name === "e"));
  if (!eInGroup) {
    throw new Error("selftest: 폴백 부착된 패키지 e가 그룹에 포함되지 않음");
  }
  if (fbNoText.length !== 1 || fbNoText[0].name !== "f") {
    throw new Error("selftest: 미해결 식별자 패키지 f가 noText에 남지 않음");
  }
}
selfTest();

// ---------------------------------------------------------------------------
// npm production dependencies via license-checker (already-installed devDependency).
// ---------------------------------------------------------------------------

function collectNpm() {
  const bin = join(ROOT, "node_modules", "license-checker", "bin", "license-checker");
  const result = spawnSync(process.execPath, [bin, "--production", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
  if (result.status !== 0) {
    throw new Error(`license-checker failed (exit ${result.status}): ${result.stderr}`);
  }
  const data = JSON.parse(result.stdout);
  const packages = [];
  for (const [key, info] of Object.entries(data)) {
    const at = key.lastIndexOf("@");
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    if (name === "brise") continue; // 루트 패키지 자신 제외
    const texts = scanLicenseFiles(info.path).map((f) => normalizeText(readFileSync(f, "utf8")));
    packages.push({ ecosystem: "npm", name, version, spdx: info.licenses || "UNKNOWN", texts });
  }
  return packages;
}

// ---------------------------------------------------------------------------
// Rust crates via `cargo metadata` (src-tauri).
// ---------------------------------------------------------------------------

function collectRust() {
  const cargoDir = join(process.env.USERPROFILE || process.env.HOME || "", ".cargo", "bin");
  const env = { ...process.env };
  if (cargoDir && existsSync(cargoDir)) {
    const sep = process.platform === "win32" ? ";" : ":";
    env.PATH = env.PATH ? `${cargoDir}${sep}${env.PATH}` : cargoDir;
  }
  const result = spawnSync("cargo", ["metadata", "--format-version", "1", "--locked"], {
    cwd: SRC_TAURI,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 256,
    env,
  });
  if (result.status !== 0) {
    throw new Error(`cargo metadata failed (exit ${result.status}): ${result.stderr}`);
  }
  const data = JSON.parse(result.stdout);
  const packages = [];
  for (const p of data.packages) {
    if (p.name === "brise") continue; // 루트 패키지 자신 제외
    const dir = dirname(p.manifest_path);
    const files = new Set(scanLicenseFiles(dir));
    if (p.license_file) {
      const lf = join(dir, p.license_file);
      if (existsSync(lf)) files.add(lf);
    }
    const texts = [...files].sort().map((f) => normalizeText(readFileSync(f, "utf8")));
    packages.push({ ecosystem: "rust", name: p.name, version: p.version, spdx: p.license || "UNKNOWN", texts });
  }
  return packages;
}

// ---------------------------------------------------------------------------
// Static entries — bundled assets / external services that no scanner sees.
// ---------------------------------------------------------------------------

function collectStatic() {
  const meteoconsLicense = normalizeText(
    readFileSync(join(ROOT, "src", "assets", "weather", "LICENSE.md"), "utf8"),
  );
  return [
    {
      name: "Meteocons",
      note: "날씨 아이콘(src/assets/weather) — Bas Milius, MIT",
      href: "https://github.com/basmilius/meteocons",
      text: meteoconsLicense,
    },
    {
      name: "calender-app-design",
      note: "일정 수정 모달의 구성·필드 순서·푸터 배치를 차용(src/components/home/calendar/ChipEventModal.tsx) — Kargul Studio, MIT",
      href: "https://github.com/kargulstudio/calender-app-design",
      text: normalizeText(
        readFileSync(join(ROOT, "src", "components", "home", "calendar", "CalenderAppDesign.LICENSE.txt"), "utf8"),
      ),
    },
    {
      name: "Microsoft Fluent UI Emoji",
      note: "이모지 아이콘 — MIT. 앱 실행 중 필요 시 원격에서 내려받아 캐시한다(번들에는 없음).",
      href: "https://github.com/microsoft/fluentui-emoji",
    },
    {
      name: "yt-dlp",
      note: "동영상/자막 수집용 사이드카 실행 파일 — Unlicense.",
      href: "https://github.com/yt-dlp/yt-dlp",
    },
    {
      name: "SQLite",
      note: "내장 데이터베이스 엔진 — Public Domain.",
      href: "https://www.sqlite.org/copyright.html",
    },
    {
      name: "OpenFreeMap / OpenMapTiles / OpenStreetMap",
      note: "지도 타일 — © OpenMapTiles, © OpenStreetMap contributors, ODbL 1.0.",
      href: "https://www.openstreetmap.org/copyright",
    },
    {
      name: "Nominatim",
      note: "지오코딩(주소 ↔ 좌표) — OpenStreetMap 데이터, ODbL 1.0.",
      href: "https://nominatim.openstreetmap.org",
    },
    {
      name: "MET Norway",
      note: "날씨 예보 데이터 — CC BY 4.0. (날씨 위젯 서체 5종은 npm OFL 스캔에 별도 수록)",
      href: "https://api.met.no",
    },
    ...collectFonts(),
  ];
}

/** 글꼴 중 npm 스캔 밖에 있는 것 — docs/PLAN-2026-10-27-fonts.md §5.5. */
function collectFonts() {
  const read = (...p) => normalizeText(readFileSync(join(ROOT, ...p), "utf8"));
  const catalog = JSON.parse(readFileSync(join(ROOT, "src", "lib", "fonts", "catalog.json"), "utf8"));
  const ofl = read("src-tauri", "resources", "fonts", "OFL-1.1.txt");
  return [
    {
      name: "Paper Mono",
      note: "번들 코드체 — SIL OFL 1.1 (Geist Mono 기반)",
      href: "https://github.com/paper-design/paper-mono",
      text: read("src", "assets", "fonts", "paper-mono", "LICENSE.txt"),
    },
    {
      name: `내려받기 글꼴 ${catalog.fonts.length}종`,
      note:
        "사용자가 설정에서 고를 때 내려받는다(설치본에는 없음) — 전부 SIL OFL 1.1. 받은 폴더에도 같은 LICENSE.txt 를 둔다. " +
        catalog.fonts.map((f) => f.family).join(", "),
      href: "https://fontsource.org",
      text: `${catalog.fonts.map((f) => `${f.family}: ${f.copyright}`).join("\n")}\n\n${ofl}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// HTML rendering.
// ---------------------------------------------------------------------------

function renderPkgGroup(g) {
  const list = g.packages.map((p) => `${esc(p.name)}@${esc(p.version)} <span class="spdx">(${esc(p.spdx)})</span>`).join(", ");
  const text = g.texts.join("\n\n----------\n\n");
  return `<div class="pkg-group">
  <p class="pkg-list">${list}</p>
  <pre class="license-text">${esc(text)}</pre>
</div>`;
}

function renderNoTextList(items) {
  if (items.length === 0) return "<p>(없음)</p>";
  return `<ul class="no-text-list">
${items.map((p) => `  <li>${esc(p.name)}@${esc(p.version)} — ${esc(p.spdx)} <span class="eco">[${p.ecosystem}]</span></li>`).join("\n")}
</ul>`;
}

function renderStatic(items) {
  return items
    .map(
      (it) => `<div class="pkg-group">
  <p class="pkg-list"><strong>${esc(it.name)}</strong> — ${esc(it.note)} — <a href="${esc(it.href)}">${esc(it.href)}</a></p>
${it.text ? `  <pre class="license-text">${esc(it.text)}</pre>` : ""}
</div>`,
    )
    .join("\n");
}

const STYLE = `
  body { font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; color: #1a1a1a; background: #fff; max-width: 980px; margin: 0 auto; padding: 32px 20px 80px; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 17px; margin-top: 40px; border-bottom: 1px solid #ddd; padding-bottom: 6px; }
  .meta { color: #666; font-size: 12px; margin-bottom: 24px; }
  .pkg-group { margin: 14px 0; padding: 10px 14px; border: 1px solid #e2e2e2; border-radius: 6px; }
  .pkg-list { font-size: 12.5px; margin: 0 0 6px; word-break: break-word; }
  .spdx { color: #666; }
  .license-text { white-space: pre-wrap; word-break: break-word; font: 11.5px/1.45 ui-monospace, "SFMono-Regular", Consolas, monospace; background: #f7f7f7; border-radius: 4px; padding: 10px 12px; max-height: 340px; overflow-y: auto; margin: 0; }
  .no-text-list { font-size: 12.5px; columns: 2; -webkit-columns: 2; }
  .no-text-list li { break-inside: avoid; }
  .eco { color: #888; }
  a { color: #0552b5; }
`;

function buildHtml({ npmGrouped, rustGrouped, staticItems, npmTotal, rustTotal, generatedAt }) {
  const noText = [...npmGrouped.noText, ...rustGrouped.noText];
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Brise — Third-Party Notices</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Brise — Third-Party Notices / 오픈소스 서드파티 고지</h1>
<p class="meta">생성일 ${esc(generatedAt)} · npm 프로덕션 의존성 ${npmTotal}개 · Rust 크레이트 ${rustTotal}개 ·
전문 미발견 ${noText.length}개 · 이 문서는 <code>npm run gen:notices</code> 로 자동 생성된다(직접 수정 금지).</p>

<section>
<h2>1. 번들 자산 · 외부 서비스</h2>
${renderStatic(staticItems)}
</section>

<section>
<h2>2. npm dependencies (JavaScript/TypeScript, production)</h2>
${npmGrouped.groups.map(renderPkgGroup).join("\n")}
</section>

<section>
<h2>3. Rust crates (Cargo)</h2>
${rustGrouped.groups.map(renderPkgGroup).join("\n")}
</section>

<section>
<h2>4. 라이선스 전문 미발견 (SPDX 표기만)</h2>
${renderNoTextList(noText)}
</section>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

function main() {
  console.log("gen-notices: collecting npm production dependencies (license-checker)…");
  const npmPkgs = collectNpm();
  console.log(`gen-notices: npm — ${npmPkgs.length} packages`);
  attachSpdxFallbacks(npmPkgs);

  console.log("gen-notices: collecting Rust crates (cargo metadata)…");
  const rustPkgs = collectRust();
  console.log(`gen-notices: rust — ${rustPkgs.length} crates`);
  attachSpdxFallbacks(rustPkgs);

  const npmGrouped = groupByLicenseText(npmPkgs);
  const rustGrouped = groupByLicenseText(rustPkgs);
  const staticItems = collectStatic();

  const html = buildHtml({
    npmGrouped,
    rustGrouped,
    staticItems,
    npmTotal: npmPkgs.length,
    rustTotal: rustPkgs.length,
    generatedAt: new Date().toISOString().slice(0, 10),
  });

  writeFileSync(OUT_FILE, html, "utf8");
  writeFileSync(
    SUMMARY_FILE,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString().slice(0, 10),
        npmTotal: npmPkgs.length,
        rustTotal: rustPkgs.length,
        noTextTotal: npmGrouped.noText.length + rustGrouped.noText.length,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  const sizeKb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
  console.log(
    `gen-notices: wrote ${OUT_FILE} (${sizeKb} KB) — npm ${npmGrouped.groups.length} text group(s), ` +
      `rust ${rustGrouped.groups.length} text group(s), ${npmGrouped.noText.length + rustGrouped.noText.length} package(s) with no license text found.`,
  );
}

main();
