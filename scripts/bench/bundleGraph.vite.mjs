/**
 * 청크 그래프 수집 Vite 플러그인 — docs/PLAN-2026-10-23-perf-baselines.md §3.2 (1단계 부팅 번들 크기 래칫).
 *
 * 빌드가 끝날 때 청크마다 { fileName, facadeModuleId, moduleIds, imports, dynamicImports, css, bytes, gzipBytes } 와
 * 자산(CSS 포함) 크기를 **dist 밖** `.eval/bundle/graph.json`(환경 변수 BRISE_BUNDLE_GRAPH 로 덮음, 저장소 루트 기준
 * 상대 경로 가능)에 쓴다. `scripts/bench/check-bundle.mjs` 가 이걸 읽어 부팅 집합 크기를 잰다.
 *
 * 왜 Vite `build.manifest` 가 아닌가: 매니페스트는 outDir(`dist/`) 안에 쓰이고, `dist/` 는 바이너리에 임베드되며
 * 폰 `/app` 으로 서빙된다(src-tauri/src/sync_server/handlers/web_client.rs 의 include_dir!). 그래서 이 플러그인은
 * **번들에 아무것도 더하지 않는다** — emitFile 을 부르지 않고, 청크 객체를 고치지 않고, fs 로 dist 밖에만 쓴다.
 *
 * - `apply: "build"` — `vite`(개발 서버)·`tauri dev` 에는 붙지 않는다.
 * - `generateBundle` 을 `order: "post"` 로 돈다: Vite 자체 후처리(동적 import 의 preload 의존 배열 치환 등)가
 *   `chunk.code` 를 고친 **뒤**의 바이트를 잰다. check-bundle 이 graph 의 바이트를 outDir 의 실제 파일 크기와
 *   대조하므로(어긋나면 종료 코드 2) 이 가정이 깨지면 바로 드러난다.
 * - 바이트 안정: 청크·자산은 fileName 순, 배열은 정렬, 시각을 넣지 않는다 — 같은 입력이면 graph.json 도 같은 바이트다.
 * - 모듈 id 는 저장소(=Vite root) 상대 `/` 경로. 가상 모듈 표시 `\0` 와 `?query` 는 남기고 그 사이 경로만 상대화한다
 *   (`\0C:/…/react-dom/client.js?commonjs-module` → `\0node_modules/react-dom/client.js?commonjs-module`) — 기계마다
 *   다른 절대 경로가 그래프에 남지 않고, commonjs 프록시가 원래 모듈 id 와 섞이지도 않는다.
 * - SSR·라이브러리 빌드는 건너뛴다(워커 하위 빌드는 사용자 플러그인을 받지 않는다 — Vite `worker.plugins` 는 별개).
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";

export const GRAPH_SCHEMA = 1;
export const PLUGIN_NAME = "brise:bundle-graph";
/** 저장소 루트 기준. dist 밖, gitignore 된 `.eval/` 아래. */
export const DEFAULT_GRAPH_PATH = ".eval/bundle/graph.json";
export const GRAPH_ENV = "BRISE_BUNDLE_GRAPH";
/** gzip 크기(정보 지표 bundle.boot_mobile_js_gzip_kb)용 — HTTP 서버 흔한 기본값. 파일마다 따로 압축한 크기의 합. */
export const GZIP_LEVEL = 6;

/** @param {string} p */
function toPosix(p) {
  return p.split(sep).join("/").replace(/\\/g, "/");
}

/**
 * Rollup 모듈 id → 저장소 상대 `/` 경로.
 * @param {string|null|undefined} id
 * @param {string} root 저장소(=Vite root) 절대 경로
 * @returns {string|null}
 */
export function relModuleId(id, root) {
  if (id == null) return null;
  const virtual = id.startsWith("\0");
  const body = virtual ? id.slice(1) : id;
  const q = body.indexOf("?");
  const query = q >= 0 ? body.slice(q) : "";
  let s = toPosix(q >= 0 ? body.slice(0, q) : body);
  const r = toPosix(root).replace(/\/+$/, "");
  const win = /^[a-zA-Z]:\//.test(r);
  const norm = (x) => (win ? x.toLowerCase() : x); // Windows 드라이브 문자·경로 대소문자 무시
  if (norm(s).startsWith(norm(r) + "/")) s = s.slice(r.length + 1);
  else if (isAbsolute(s) || /^[a-zA-Z]:\//.test(s)) s = toPosix(relative(root, s)); // 루트 밖(링크된 패키지 등)
  // 경로가 아닌 가상 모듈(\0vite/preload-helper.js 등)은 위 두 갈래에 안 걸려 그대로 남는다.
  return (virtual ? "\0" : "") + s + query;
}

/** @param {string|Uint8Array} v */
function toBuffer(v) {
  return typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(v);
}

const byFileName = (a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0);
const sorted = (xs) => [...(xs ?? [])].sort();

/**
 * Rollup OutputBundle → 그래프(순수 함수 — 테스트가 가짜 번들로 부른다).
 * @param {Record<string, any>} bundle
 * @param {{root: string, outDir?: string|null, toolchain?: object}} opts
 */
export function buildGraph(bundle, { root, outDir = null, toolchain = {} }) {
  const chunks = [];
  const assets = [];
  for (const item of Object.values(bundle)) {
    if (item.type === "chunk") {
      const code = toBuffer(item.code);
      chunks.push({
        fileName: item.fileName,
        name: item.name,
        isEntry: !!item.isEntry,
        isDynamicEntry: !!item.isDynamicEntry,
        facadeModuleId: relModuleId(item.facadeModuleId, root),
        moduleIds: sorted((item.moduleIds ?? Object.keys(item.modules ?? {})).map((id) => relModuleId(id, root))),
        imports: sorted(item.imports),
        dynamicImports: sorted(item.dynamicImports),
        css: sorted(item.viteMetadata?.importedCss),
        bytes: code.length,
        gzipBytes: gzipSync(code, { level: GZIP_LEVEL }).length,
      });
    } else if (item.type === "asset") {
      if (item.fileName.endsWith(".map")) continue;
      const buf = toBuffer(item.source);
      const a = { fileName: item.fileName, bytes: buf.length };
      if (item.fileName.endsWith(".css")) a.gzipBytes = gzipSync(buf, { level: GZIP_LEVEL }).length;
      assets.push(a);
    }
  }
  chunks.sort(byFileName);
  assets.sort(byFileName);
  return {
    schema: GRAPH_SCHEMA,
    generator: PLUGIN_NAME,
    outDir: outDir == null ? null : relModuleId(outDir, root),
    gzipLevel: GZIP_LEVEL,
    toolchain,
    chunks,
    assets,
  };
}

/** 그래프 파일 경로: BRISE_BUNDLE_GRAPH(상대면 root 기준) 또는 기본값. */
export function graphPath(root, env = process.env) {
  const p = env[GRAPH_ENV];
  return p ? resolve(root, p) : resolve(root, DEFAULT_GRAPH_PATH);
}

/** 반쯤 쓴 파일을 check-bundle 이 읽지 않게 임시 파일 → rename. */
function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

/**
 * 빌드에 실제로 쓰인 vite·esbuild 버전(§3.4 기록용 — 비교 키 아님). esbuild 는 vite 가 resolve 하는 사본을 본다
 * (저장소 최상위 사본과 다를 수 있다). 'vite' 를 import 하지 않는 이유: check-bundle 이 이 모듈의 상수를 쓰는데
 * 그때 vite 전체를 불러올 까닭이 없다. 못 찾으면 null.
 */
function toolVersions(root) {
  const out = { vite: null, esbuild: null };
  try {
    const req = createRequire(resolve(root, "package.json"));
    const vitePkg = req.resolve("vite/package.json");
    out.vite = req(vitePkg).version ?? null;
    out.esbuild = createRequire(vitePkg)("esbuild/package.json").version ?? null;
  } catch {
    // silent-ok: 툴체인 기록용(§3.4) — 못 읽으면 graph.toolchain 에 null 로 남고 check-bundle 이 그대로 찍는다
  }
  return out;
}

/**
 * @param {{path?: string}} [options] path: 그래프 파일 경로(기본 BRISE_BUNDLE_GRAPH 또는 .eval/bundle/graph.json)
 * @returns {import('vite').Plugin}
 */
export default function bundleGraph(options = {}) {
  /** @type {import('vite').ResolvedConfig | null} */
  let config = null;
  return {
    name: PLUGIN_NAME,
    apply: "build",
    enforce: "post",
    configResolved(c) {
      config = c;
    },
    generateBundle: {
      order: "post",
      handler(_outputOptions, bundle) {
        if (!config || config.build.ssr || config.build.lib) return;
        const root = config.root;
        const out = options.path ? resolve(root, options.path) : graphPath(root);
        const graph = buildGraph(bundle, {
          root,
          outDir: resolve(root, config.build.outDir),
          toolchain: { node: process.version, rollup: this.meta?.rollupVersion ?? null, ...toolVersions(root) },
        });
        writeAtomic(out, JSON.stringify(graph, null, 2) + "\n");
        config.logger.info(`[${PLUGIN_NAME}] ${graph.chunks.length} chunks → ${toPosix(relative(root, out))}`);
      },
    },
  };
}
