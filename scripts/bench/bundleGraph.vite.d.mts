// bundleGraph.vite.mjs 의 타입 선언 — vite.config.ts 가 tsconfig.node.json 으로 타입 검사될 때 쓴다.
// (.mjs 를 그대로 두는 이유: check-bundle.test.mjs 가 buildGraph 를 직접 import 한다. tsconfig.node.json 은
//  composite 라 include 밖의 .ts 구현 파일을 끌어오면 TS6307 로 실패한다 — 선언 파일은 괜찮다.)
import type { Plugin } from "vite";

export declare const GRAPH_SCHEMA: number;
export declare const PLUGIN_NAME: string;
export declare const DEFAULT_GRAPH_PATH: string;
export declare const GRAPH_ENV: string;
export declare const GZIP_LEVEL: number;

export interface BundleGraphChunk {
  fileName: string;
  name: string;
  isEntry: boolean;
  isDynamicEntry: boolean;
  facadeModuleId: string | null;
  moduleIds: string[];
  imports: string[];
  dynamicImports: string[];
  css: string[];
  bytes: number;
  gzipBytes: number;
}

export interface BundleGraphAsset {
  fileName: string;
  bytes: number;
  gzipBytes?: number;
}

export interface BundleGraph {
  schema: number;
  generator: string;
  outDir: string | null;
  gzipLevel: number;
  toolchain: Record<string, string | null>;
  chunks: BundleGraphChunk[];
  assets: BundleGraphAsset[];
}

export declare function relModuleId(id: string | null | undefined, root: string): string | null;
export declare function buildGraph(
  bundle: Record<string, unknown>,
  opts: { root: string; outDir?: string | null; toolchain?: Record<string, string | null> },
): BundleGraph;
export declare function graphPath(root: string, env?: Record<string, string | undefined>): string;

export interface BundleGraphOptions {
  /** 그래프 파일 경로(Vite root 기준 상대 가능). 기본: BRISE_BUNDLE_GRAPH 또는 .eval/bundle/graph.json */
  path?: string;
}

export default function bundleGraph(options?: BundleGraphOptions): Plugin;
