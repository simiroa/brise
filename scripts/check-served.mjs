#!/usr/bin/env node
/**
 * 개발 서버 서빙 검사 — vite 가 소스를 "빈 모듈"로 캐시해 앱이 백지가 되는 사고 탐지.
 * (실제 사례: src/briefing/view/style.ts 가 빈 채 서빙, 콘솔 "does not provide an export".
 *  파일을 touch 하면 풀린다.) 서버가 필요한 별도 검사라 `npm run check` 에는 넣지 않는다.
 *
 *   node scripts/check-served.mjs [--url http://localhost:5183] [--fix]
 * 서버 없음 → "건너뜀" + exit 0. 빈 모듈 발견 → 목록 + exit 1. --fix 는 touch 후 재검사.
 */
import { readdirSync, readFileSync, utimesSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 소스맵 주석·공백만 남으면 빈 모듈. */
export function isEmptyServed(body) {
  return body.replace(/\/\/# sourceMappingURL=.*$/gm, '').trim() === '';
}

/** 로컬 소스에 런타임 export / 부수효과 import 가 있나. 타입 전용(esbuild 가 비움)은 false. */
// ponytail: 정규식 휴리스틱 — 문자열/템플릿 안의 줄머리 `export` 는 못 거른다(오탐 시 --fix 가 touch 만 할 뿐).
export function hasRuntimeModuleSyntax(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return (
    /^\s*export\s+(?!type\b|interface\b|declare\b)/m.test(code) ||
    /^\s*export\s*\{/m.test(code) ||
    /^\s*import\s+['"]/m.test(code)
  );
}

function listSources(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listSources(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

async function pool(items, n, fn) {
  const res = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const item = items[i++];
        res.push(await fn(item));
      }
    }),
  );
  return res;
}

async function scan(base, files) {
  const bad = [];
  await pool(files, 8, async (f) => {
    if (!hasRuntimeModuleSyntax(readFileSync(f, 'utf8'))) return;
    const rel = relative(process.cwd(), f).split(sep).join('/');
    try {
      const r = await fetch(`${base}/${rel}`);
      if (isEmptyServed(await r.text())) bad.push(f);
    } catch {
      // silent-ok: 개별 요청 실패는 서빙 문제가 아니라 네트워크 문제 — 빈 모듈로 세지 않는다
    }
  });
  return bad.sort();
}

async function main() {
  const args = process.argv.slice(2);
  const u = args.indexOf('--url');
  const base = (u >= 0 ? args[u + 1] : 'http://localhost:5183').replace(/\/$/, '');
  try {
    await fetch(`${base}/@vite/client`, { signal: AbortSignal.timeout(3000) });
  } catch {
    console.log(`check:served — 서버 없음(${base}) — 건너뜀`);
    return 0;
  }
  const files = listSources('src');
  let bad = await scan(base, files);
  if (bad.length && args.includes('--fix')) {
    const now = new Date();
    for (const f of bad) utimesSync(f, now, now);
    await new Promise((r) => setTimeout(r, 1000));
    bad = await scan(base, bad);
  }
  if (!bad.length) {
    console.log(`check:served — OK (${files.length} 파일 검사)`);
    return 0;
  }
  console.error(`check:served — 빈 모듈로 서빙 중 ${bad.length}건 (--fix 로 touch 후 재검사):`);
  for (const f of bad) console.error('  ' + relative(process.cwd(), f));
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main());
}
