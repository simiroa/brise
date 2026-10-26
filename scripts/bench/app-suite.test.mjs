// @vitest-environment node
// scripts/bench/suites/app.mjs 의 순수 부분 — 데이터 묶음 이름 바꾸기(실데이터 안전)·boot/timing 파싱·부팅 지표 계산.
// Node 환경에서 돈다: app.mjs 는 Node 스크립트라 `node:sqlite` 를 동적 import 한다. jsdom(브라우저 흉내)에서는 실행 중인
// Node 가 그 내장 모듈을 모르면(Node 20 — CI) Vite 가 번들하려다 "Cannot bundle built-in module" 로 파일째 실패했다
// (2026-10-23 첫 CI). Node 환경은 `node:` 모듈을 외부로 돌리고, 이 테스트는 sqlite 경로를 부르지 않는다.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { taggedName, moveDataset, parseBootTiming, bootMetrics, mergeSnapshots, perfBuildConfig } from "./suites/app.mjs";

describe("taggedName", () => {
  it("DB 파일은 brise.<tag>.db 접두를 유지해 SQLite 의 -wal/-shm 짝이 그대로 맞는다", () => {
    expect(taggedName("brise.db", "realdata")).toBe("brise.realdata.db");
    expect(taggedName("brise.db-wal", "realdata")).toBe("brise.realdata.db-wal");
    expect(taggedName("brise.db-shm", "realdata")).toBe("brise.realdata.db-shm");
    expect(taggedName("brise.db-benchseed", "scale100k")).toBe("brise.scale100k.db-benchseed");
  });
  it("폴더는 꼬리표를 뒤에 붙이고, tag 가 없으면 원래 이름", () => {
    expect(taggedName("backups", "realdata")).toBe("backups.realdata");
    expect(taggedName("backups", null)).toBe("backups");
  });
});

describe("moveDataset", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(os.tmpdir(), "brise-bench-ds-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("있는 항목만 옮기고 내용은 그대로", () => {
    writeFileSync(join(dir, "brise.db"), "DB");
    writeFileSync(join(dir, "brise.db-wal"), "WAL");
    mkdirSync(join(dir, "backups"));
    writeFileSync(join(dir, "backups", "b.db"), "B");
    writeFileSync(join(dir, "diag.jsonl"), "keep");
    expect(moveDataset(dir, null, "realdata")).toBe(3);
    expect(readFileSync(join(dir, "brise.realdata.db"), "utf8")).toBe("DB");
    expect(readFileSync(join(dir, "brise.realdata.db-wal"), "utf8")).toBe("WAL");
    expect(readFileSync(join(dir, "backups.realdata", "b.db"), "utf8")).toBe("B");
    expect(existsSync(join(dir, "brise.db"))).toBe(false);
    // 묶음 밖 파일은 건드리지 않는다
    expect(readFileSync(join(dir, "diag.jsonl"), "utf8")).toBe("keep");
  });

  it("대상 자리에 무엇이든 있으면 하나도 옮기지 않고 throw(덮지 않는다)", () => {
    writeFileSync(join(dir, "brise.db"), "NEW");
    mkdirSync(join(dir, "backups"));
    writeFileSync(join(dir, "backups.realdata"), "OLD");
    expect(() => moveDataset(dir, null, "realdata")).toThrow(/덮지 않는다/);
    expect(readFileSync(join(dir, "brise.db"), "utf8")).toBe("NEW");
    expect(readFileSync(join(dir, "backups.realdata"), "utf8")).toBe("OLD");
    expect(existsSync(join(dir, "brise.realdata.db"))).toBe(false);
  });

  it("왕복하면 원래 자리", () => {
    writeFileSync(join(dir, "brise.db"), "S");
    writeFileSync(join(dir, "brise.realdata.db"), "R");
    moveDataset(dir, null, "synthetic");
    moveDataset(dir, "realdata", null);
    expect(readFileSync(join(dir, "brise.db"), "utf8")).toBe("R");
    moveDataset(dir, null, "realdata");
    moveDataset(dir, "synthetic", null);
    expect(readFileSync(join(dir, "brise.db"), "utf8")).toBe("S");
    expect(readFileSync(join(dir, "brise.realdata.db"), "utf8")).toBe("R");
  });
});

describe("parseBootTiming", () => {
  it("diag boot/timing 메시지 → 숫자 맵", () => {
    expect(parseBootTiming("run=0 setup=797 diag_init=800 setup_end=911 epoch=1792696597428")).toEqual({
      run: 0,
      setup: 797,
      diag_init: 800,
      setup_end: 911,
      epoch: 1792696597428,
    });
  });
});

describe("bootMetrics", () => {
  const timing = { run: 0, setup: 100, setup_end: 150, epoch: 1_000_000 };
  const snap = (res) => ({
    timeOrigin: 1_000_400,
    marks: { boot: 50, show: 300, tree: 450, booted: 500 },
    res,
    href: "http://tauri.localhost/",
  });

  it("§5.1 정의: 프로세스→표시 = timeOrigin + show − epoch, 내비→표시 = show, setup = setup_end", () => {
    const m = bootMetrics(snap([]), timing);
    expect(m["boot.process_to_show_ms"]).toBe(700);
    expect(m["boot.nav_to_show_ms"]).toBe(300);
    expect(m["boot.webview_ready_ms"]).toBe(400);
    expect(m["boot.rust_setup_ms"]).toBe(150);
    expect(m["boot.booted_ms"]).toBe(500);
  });

  const resources = [
    { n: "http://tauri.localhost/assets/a.js", s: 10, e: 100, d: 2048, t: "script" },
    { n: "http://tauri.localhost/assets/b.js?v=1", s: 10, e: 300, d: 1024, t: "link" },
    // show 직전에 요청, show 뒤에 도착 — 계획 글자 그대로의 정의("show 전에 받은")에선 빠지고 갈린다
    { n: "http://tauri.localhost/assets/racy.js", s: 290, e: 310, d: 4096, t: "script" },
    // booted 뒤(idle 프리로드) — 빠진다
    { n: "http://tauri.localhost/assets/idle.js", s: 600, e: 650, d: 8192, t: "script" },
    { n: "http://tauri.localhost/assets/x.css", s: 10, e: 50, d: 9999, t: "link" },
    { n: "http://ipc.localhost/settings_get_all", s: 120, e: 140, d: 0, t: "fetch" },
    { n: "http://ipc.localhost/note_query", s: 299, e: 420, d: 0, t: "fetch" },
    { n: "http://ipc.localhost/late", s: 301, e: 320, d: 0, t: "fetch" },
  ];

  it("js_before_show_kb = booted 전에 요청한 .js(쿼리 무시) — show 경합·idle 프리로드에 흔들리지 않는다", () => {
    const m = bootMetrics(snap(resources), timing);
    expect(m["boot.js_before_show_kb"]).toBe(7);
    // 계획 §5.1 글자 그대로의 값은 세부로만 남긴다
    expect(m._detail.js_received_before_show_kb).toBe(3);
    expect(m._detail.js_requested_before_show_kb).toBe(7);
  });

  it("ipc_before_show 는 show 전에 시작한 IPC", () => {
    expect(bootMetrics(snap(resources), timing)["boot.ipc_before_show"]).toBe(2);
  });

  it("리소스 버퍼가 booted 시점에 이미 찼으면 숫자 대신 throw", () => {
    const res = Array.from({ length: 250 }, (_, i) => ({ n: `http://tauri.localhost/assets/${i}.js`, s: i, e: i + 1, d: 1, t: "script" }));
    expect(() => bootMetrics(snap(res), timing)).toThrow(/버퍼/);
    expect(() => bootMetrics({ ...snap([]), buffer: { atBooted: 250, afterQuiet: 250 } }, timing)).toThrow(/버퍼/);
    // 붙자마자 넓혔고 그때 아직 덜 찼으면, 나중에 250 을 넘어도 버려진 항목이 없다
    expect(() => bootMetrics({ ...snap([]), buffer: { atAttach: 120, atBooted: 300, afterQuiet: 420 } }, timing)).not.toThrow();
    expect(() => bootMetrics({ ...snap([]), buffer: { atAttach: 250, atBooted: 300, afterQuiet: 420 } }, timing)).toThrow(/버퍼/);
  });

  it("mergeSnapshots — booted 시점에 아직 안 끝난 요청을 조용해진 뒤 스냅숏에서 보탠다(중복 없이)", () => {
    const a = { ...snap(resources.slice(0, 2)) };
    const b = { ...snap(resources.slice(0, 3)) };
    const merged = mergeSnapshots(a, b);
    expect(merged.res.map((r) => r.n)).toEqual(resources.slice(0, 3).map((r) => r.n));
    expect(merged.buffer).toEqual({ atAttach: null, atBooted: 2, afterQuiet: 3 });
    expect(mergeSnapshots(a, b, 7).buffer.atAttach).toBe(7);
  });

  it("Rust 타이밍 줄이 없으면 throw(조용히 0 을 내지 않는다)", () => {
    expect(() => bootMetrics(snap([]), null)).toThrow(/boot\/timing/);
  });
});

describe("perfBuildConfig", () => {
  it("perf identifier + dist 밖 산출물(src-tauri 기준 상대 경로)", () => {
    const c = JSON.parse(perfBuildConfig());
    expect(c.identifier).toBe("com.brise.app.perf");
    expect(c.build.frontendDist).toBe("../.eval/bench/perf-dist");
    expect(c.build.beforeBuildCommand).toMatch(/--outDir \.eval\/bench\/perf-dist/);
    expect(c.build.beforeBuildCommand).not.toMatch(/(^|\s)dist(\s|$)/);
  });
});
