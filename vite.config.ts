import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// 부팅 번들 크기 래칫(docs/PLAN-2026-10-23-perf-baselines.md §3) — 청크 그래프를 dist 밖 .eval/bundle/graph.json 에 쓴다.
import bundleGraph from "./scripts/bench/bundleGraph.vite.mjs";

const host = process.env.TAURI_DEV_HOST;

// docs/PLAN-2026-10-27-fonts.md W0 — @fontsource CSS 는 woff2 뒤에 woff 폴백을 적어 두고, Vite 는 둘 다 내보낸다.
// WebView2·모바일 브라우저(동기화 뷰어)는 전부 woff2 를 받으므로 woff 는 설치본에만 실리는 짐(≈12MB)이다.
// 산출 CSS 에서 폴백 줄을 지우고 woff 파일을 뺀다. bundleGraph 보다 **앞**에 둬야 그래프가 줄어든 CSS 크기를 잰다.
const dropWoffFallback = {
  name: "drop-woff-fallback",
  generateBundle(_: unknown, bundle: Record<string, { type: string; fileName: string; source?: string | Uint8Array }>) {
    for (const [key, out] of Object.entries(bundle)) {
      if (out.type === "asset" && out.fileName.endsWith(".woff")) delete bundle[key];
      else if (out.type === "asset" && out.fileName.endsWith(".css") && typeof out.source === "string") {
        out.source = out.source.replace(/,\s*url\([^)]*\.woff\)\s*format\(["']?woff["']?\)/g, "");
      }
    }
  },
};

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), dropWoffFallback, bundleGraph()],

  // Browser mode: the sync server serves this same build under /app/ instead of the origin
  // root. Relative asset URLs work under any sub-path (/app/assets/... or /assets/... both
  // resolve fine relative to wherever index.html itself was fetched from), whereas the Vite
  // default (absolute "/assets/...") would 404 under /app/. Confirmed safe for the Tauri
  // webview too — it serves index.html from its own root, and "./assets/..." still resolves
  // there the same way. Cross-agent contract: the sync server must serve this build at a path
  // ending in "/" (e.g. "/app/", not "/app") — relative URLs resolve against the request path,
  // so a trailing-slash-less "/app" would resolve "./assets/x.js" to "/x.js" and 404.
  base: "./",

  // maplibre-gl은 자체 워커 청크(maplibre-gl-worker.mjs)를 쓰는데 vite 사전번들러가 이를
  // 깨뜨린다("The file does not exist at .../.vite/deps/maplibre-gl-worker.mjs" → 워커 실패
  // → 지도가 흰 캔버스). 사전번들에서 제외가 공식 우회.
  optimizeDeps: {
    exclude: ["maplibre-gl"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    // 1420/1421 은 Windows WinNAT 동적 예약 범위(1350-1449 등)에 걸려 EACCES 가 나는 날이
    // 있다 — 예약 범위 밖의 포트로 고정 (tauri.conf.json devUrl 과 반드시 일치).
    port: 5183,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 5184,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
