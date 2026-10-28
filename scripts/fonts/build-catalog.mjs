#!/usr/bin/env node
/**
 * 내려받기 글꼴 카탈로그 생성 — docs/PLAN-2026-10-27-fonts.md §5.1.
 *
 *   node scripts/fonts/build-catalog.mjs <빈 작업 폴더>
 *
 * FONTS 목록의 각 글꼴을 Fontsource API(라이선스·굵기·버전)로 조회하고, **버전을 고정한** jsDelivr
 * npm 경로의 woff2 를 작업 폴더로 받아 sha256·크기를 잰 뒤 `src/lib/fonts/catalog.json` 을 쓴다.
 * 받은 파일은 해시만 재고 실행하거나 파싱하지 않는다(신뢰하지 않는 데이터). 앱은 같은 URL 에서
 * 같은 바이트를 받아 이 해시로 검증한다(src-tauri/src/repo/fonts.rs) — 버전이 고정이라 URL 의
 * 내용이 바뀌지 않는다.
 *
 * 굵기 사다리(CLAUDE.md 함정 10): 앱이 쓰는 굵기는 400·600 두 단뿐이라 글꼴마다 "400 으로 쓸 파일"과
 * "600 으로 쓸 파일"을 고른다 — 600 이 없으면 700(그다음 800)을 600 으로 등록해 400 과 진짜로 구분되게
 * 하고, 한 단뿐이면 600 을 비워 브라우저의 가짜 굵게에 맡긴다(§5.3, 굵게가 안 보이는 것보다 낫다).
 *
 * 한국어 글꼴은 Fontsource 의 `korean`(분할 안 된 한 파일 — tokens.css 의 Noto KR 와 같은 방식,
 * KS X 1001 상용 음절 위주) + `latin` 두 파일, 라틴 글꼴은 `latin` 한 파일.
 * ponytail: 상용 밖 음절은 스택 다음 글꼴(Pretendard, 11,172 음절 전부)로 넘어간다. 완전 커버가 필요하면
 * 번호 슬라이스(0~119)를 팩으로 받는 쪽으로.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "..", "src", "lib", "fonts", "catalog.json");

// role: body = 본문·화면 겸용 / display = 손글씨·장식(노트 본문 글꼴에만, Q2) / mono = 코드체(Q3)
const FONTS = [
  // 한국어 — 고딕
  ["gothic-a1", "body", "Gothic A1"],
  ["ibm-plex-sans-kr", "body", "IBM Plex Sans KR"],
  ["nanum-gothic", "body", "나눔고딕"],
  ["gowun-dodum", "body", "고운돋움"],
  // 한국어 — 명조
  ["hahmlet", "body", "함렛"],
  ["nanum-myeongjo", "body", "나눔명조"],
  ["gowun-batang", "body", "고운바탕"],
  ["song-myung", "body", "송명"],
  // 한국어 — 손글씨·장식
  ["nanum-pen-script", "display", "나눔손글씨 펜"],
  ["nanum-brush-script", "display", "나눔손글씨 붓"],
  ["gaegu", "display", "개구"],
  ["hi-melody", "display", "하이멜로디"],
  ["gamja-flower", "display", "감자꽃"],
  ["poor-story", "display", "푸어스토리"],
  ["east-sea-dokdo", "display", "동해독도"],
  ["dokdo", "display", "독도"],
  ["jua", "display", "주아"],
  ["do-hyeon", "display", "도현"],
  ["black-han-sans", "display", "검은고딕"],
  ["dongle", "display", "동글"],
  ["sunflower", "display", "해바라기"],
  ["yeon-sung", "display", "연성"],
  ["gasoek-one", "display", "가석"],
  ["bagel-fat-one", "display", "베이글"],
  ["orbit", "display", "오르빗"],
  ["diphylleia", "display", "디필리아"],
  ["gugi", "display", "구기"],
  ["cute-font", "display", "귀여운"],
  ["stylish", "display", "스타일리시"],
  ["single-day", "display", "싱글데이"],
  ["kirang-haerang", "display", "기랑해랑"],
  ["black-and-white-picture", "display", "흑백사진"],
  ["moirai-one", "display", "모이라이"],
  ["grandiflora-one", "display", "그랜디플로라"],
  // 코드체
  ["nanum-gothic-coding", "mono", "나눔고딕코딩"],
  ["jetbrains-mono", "mono", "JetBrains Mono"],
  ["fira-code", "mono", "Fira Code"],
  ["ibm-plex-mono", "mono", "IBM Plex Mono"],
  ["cascadia-code", "mono", "Cascadia Code"],
  ["geist-mono", "mono", "Geist Mono"],
  ["victor-mono", "mono", "Victor Mono"],
  // 라틴 보조
  ["inter", "body", "Inter"],
  ["ibm-plex-sans", "body", "IBM Plex Sans"],
  ["ibm-plex-serif", "body", "IBM Plex Serif"],
  ["geist", "body", "Geist"],
  ["figtree", "body", "Figtree"],
  ["manrope", "body", "Manrope"],
  ["atkinson-hyperlegible", "body", "Atkinson Hyperlegible"],
  ["lora", "body", "Lora"],
  ["literata", "body", "Literata"],
  ["merriweather", "body", "Merriweather"],
  ["newsreader", "body", "Newsreader"],
  ["eb-garamond", "body", "EB Garamond"],
  ["crimson-pro", "body", "Crimson Pro"],
  ["fraunces", "body", "Fraunces"],
  ["caveat", "display", "Caveat"],
  ["kalam", "display", "Kalam"],
];

const pick = (ws, prefs) => prefs.find((w) => ws.includes(w));

async function main() {
  const work = process.argv[2];
  if (!work) throw new Error("사용법: node scripts/fonts/build-catalog.mjs <빈 작업 폴더>");
  mkdirSync(work, { recursive: true });
  if (readdirSync(work).length) throw new Error(`작업 폴더가 비어 있지 않다: ${work}`);

  const fonts = [];
  for (const [id, role, name] of FONTS) {
    const a = await (await fetch(`https://api.fontsource.org/v1/fonts/${id}`)).json();
    if (a.id !== id) throw new Error(`${id}: Fontsource 에 없음`);
    if (a.license !== "OFL-1.1") throw new Error(`${id}: 라이선스 ${a.license} — OFL 만 싣는다(§2)`);
    if (!a.styles.includes("normal")) throw new Error(`${id}: normal 스타일 없음`);
    // 저작권 줄 — 앱이 받은 폴더에 LICENSE.txt(저작권 줄 + OFL 전문)를 같이 쓰고 고지문도 이 줄을 싣는다(§5.5).
    const lic = await (await fetch(`https://cdn.jsdelivr.net/npm/@fontsource/${id}@${a.npmVersion}/LICENSE`)).text();
    const cut = lic.indexOf("This Font Software is licensed under the SIL Open Font License, Version 1.1");
    if (cut <= 0) throw new Error(`${id}: LICENSE 에서 OFL 1.1 문구를 못 찾음`);
    const copyright = lic.slice(0, cut).trim();
    const regular = pick(a.weights, [400, 500, 300]);
    const bold = pick(a.weights.filter((w) => w > regular), [600, 700, 800]);
    const hangul = a.subsets.includes("korean");
    const subsets = hangul ? ["korean", "latin"] : ["latin"];
    const faces = [];
    for (const [weight, src] of [[400, regular], [600, bold]]) {
      if (src === undefined) continue;
      for (const subset of subsets) {
        const file = `${id}-${subset}-${src}-normal.woff2`;
        const url = `https://cdn.jsdelivr.net/npm/@fontsource/${id}@${a.npmVersion}/files/${file}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        writeFileSync(join(work, file), bytes);
        faces.push({
          weight,
          file,
          url,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
          // korean 파일은 범위 없음(나머지 전부) — 뒤에 등록되는 latin 이 라틴 범위를 가져간다.
          ...(subset === "latin" && hangul ? { unicode_range: a.unicodeRange.latin } : {}),
        });
      }
    }
    fonts.push({
      id,
      name,
      family: a.family,
      role,
      hangul,
      category: a.category,
      weights: bold === undefined ? 1 : 2,
      license: a.license,
      copyright,
      source: `https://fontsource.org/fonts/${id}`,
      faces,
    });
    process.stdout.write(`${id} `);
  }
  writeFileSync(OUT, JSON.stringify({ version: 1, fonts }, null, 1) + "\n");
  const total = fonts.flatMap((f) => f.faces).reduce((s, f) => s + f.bytes, 0);
  console.log(`\n${fonts.length}종, 파일 합계 ${(total / 1048576).toFixed(1)}MB → ${OUT}`);
}

await main();
