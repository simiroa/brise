/**
 * 성능 지표 레지스트리 — docs/PLAN-2026-10-23-perf-baselines.md §3.1(bundle) · §4.1(rust) · §5.1(app) 표를
 * 그대로 옮긴 것. **지표 id 는 측정기가 그대로 내는 이름이다 — 한 글자도 바꾸지 말 것.**
 * 지표를 추가할 때는 계획 문서 표에 먼저 적고(§6) 여기에 옮긴다.
 *
 * 필드:
 *   group            'bundle' | 'rust' | 'app' — 어느 단계의 측정기가 내나
 *   unit             'KB' | 'MB' | 'ms' | 'count'. **unit 이 'ms' 인 지표만 시간 지표**다 — NOISY(IQR/중앙값 > 0.25)
 *                    판정은 시간 지표에만 건다(compare.mjs isTimeMetric). 크기·개수는 잡음 판정 없음.
 *   direction        'lower'(작을수록 좋다, 전부) | 'higher'
 *   stat             'value'(결정적 단일 값) | 'median'(표본 중앙값)
 *   runs             기대 표본 수(기록용 — 비교에 강제하지 않는다. 표본 수는 --samples/--boots 로 바뀔 수 있다)
 *   tolerance        {rel, abs} — 허용폭 = max(rel × base, abs). 계획 표에서 '—' 인 지표는 null(판정 없이 값만 → 'INFO')
 *   gate             true 면 REGRESSED 가 종료 코드 1. false('정보')면 판정만 찍는다
 *   fingerprint_keys 기준선과 이 키들의 값이 같아야 비교한다(§2.4). 다르면 UNCOMPARABLE
 *
 * 레지스트리에 없는 id 를 측정기가 내면(예: §5.1 의 `scale.*` "등") 러너는 정보 지표로 다룬다
 * (compare.mjs defaultDef — tolerance null, gate false, fingerprint_keys ['machine','os']).
 *
 * 순수 데이터 모듈. 부작용 없음.
 */

const RUST_FP = Object.freeze(["machine", "os", "rust"]);
const APP_FP = Object.freeze(["machine", "os", "webview2"]);

/** @param {number} rel @param {number} abs */
const tol = (rel, abs) => ({ rel, abs });

/** §3.1 — 결정적(빌드 산출물 크기). 원본 바이트, KB = 1024 B. 기계 무관이라 지문 키 없음. */
function bundle(unit, tolerance, gate) {
  return { group: "bundle", unit, direction: "lower", stat: "value", tolerance, gate, fingerprint_keys: [] };
}

/** §4.1 — release 프로필, 합성 데이터, 워밍업 1회 뒤 표본 5회. */
function rust(unit, tolerance, gate, stat = "median") {
  return {
    group: "rust",
    unit,
    direction: "lower",
    stat,
    ...(stat === "median" ? { runs: 5 } : {}),
    tolerance,
    gate,
    fingerprint_keys: [...RUST_FP],
  };
}

/** §5.1 — perf 빌드, 합성 DB, CDP. 부팅은 8회(첫 회 버림), 상호작용은 워밍업 1 + 5회. */
function app(unit, tolerance, gate, runs) {
  return {
    group: "app",
    unit,
    direction: "lower",
    stat: "median",
    runs,
    tolerance,
    gate,
    fingerprint_keys: [...APP_FP],
  };
}

const BOOT_RUNS = 8; // 8회 부팅, 첫 회(새 WebView2 프로필)는 버린다 — 표본은 7개
const INTERACT_RUNS = 5;

export const METRICS = Object.freeze({
  // ── 1단계: 부팅 번들 크기 래칫(§3.1) ──────────────────────────────────────────
  // 부팅 집합 JS 는 rel 1% — 2% 였을 때 기준 1,615 KB 에서 허용폭이 32 KB 라 30 KB 부팅 누수가 조용히 통과했다
  // (2026-10-23 1단계 검증, 실제 App.tsx 30 KB 정적 import 로 확인). 결정적이라 잡음 여유가 필요 없다.
  "bundle.boot_main_js_kb": bundle("KB", tol(0.01, 10), true),
  "bundle.boot_main_css_kb": bundle("KB", tol(0.03, 4), true),
  "bundle.boot_mobile_js_kb": bundle("KB", tol(0.01, 10), true),
  "bundle.boot_mobile_js_gzip_kb": bundle("KB", tol(0.03, 4), false), // 정보(tailnet 전송량)
  "bundle.boot_settings_window_js_kb": bundle("KB", tol(0.01, 10), true),
  "bundle.locale_ko_kb": bundle("KB", tol(0.05, 8), false), // 정보(문구 증가는 자연스럽다)
  "bundle.total_js_kb": bundle("KB", tol(0.05, 100), false), // 정보
  "bundle.chunk_count": bundle("count", tol(0.1, 5), false), // 정보

  // ── 2단계: Rust 벤치(§4.1) ────────────────────────────────────────────────────
  "search.question_avg_ms": rust("ms", tol(0.2, 1), true),
  "search.question_worst_ms": rust("ms", tol(0.25, 2), true),
  "search.box_worst_ms": rust("ms", tol(0.2, 2), true),
  "write.fts_upsert_10k_ms": rust("ms", tol(0.25, 0.5), true),
  "write.fts_upsert_1k_ms": rust("ms", null, false), // 정보(fsync 잡음 — 2026-10-10 판정)
  // 크기라 시간 잡음은 없지만 노트 id 가 무작위라 실행마다 ±0.02 MB 흔들린다. abs 0.5 MB 였을 땐 값(~1.65 MB)의
  // 30% 가 늘어야 걸려 사실상 안 막았다 → abs 0.05 MB.
  "index.bigram_mb_10k": rust("MB", tol(0.03, 0.05), true, "value"),
  "index.db_mb_10k": rust("MB", tol(0.03, 1), false, "value"), // 정보
  "export.hwpx_ms_300img": rust("ms", tol(0.15, 40), true),
  "export.docx_ms_300img": rust("ms", tol(0.15, 40), true),
  "export.hwpx_peak_heap_mb": rust("MB", tol(0.05, 8), true),
  "export.docx_peak_heap_mb": rust("MB", tol(0.05, 8), true),

  // ── 3단계: 실앱 부팅·상호작용(§5.1) ──────────────────────────────────────────
  "boot.process_to_show_ms": app("ms", tol(0.1, 60), true, BOOT_RUNS),
  "boot.nav_to_show_ms": app("ms", tol(0.1, 40), true, BOOT_RUNS),
  "boot.rust_setup_ms": app("ms", tol(0.2, 20), true, BOOT_RUNS),
  "boot.webview_ready_ms": app("ms", null, false, BOOT_RUNS), // 정보(WebView2 생성, 고정 비용)
  // 정보 — 트리 로드까지라 부팅마다 ±130~210 ms 흔들리고, 실행 중앙값도 두 무리로 갈린다(첫 기준선 기록 5회:
  // 561·568·572 / 686·710 ms). 허용폭을 넓혀도 문턱에서 흔들려 거짓 경보가 난다. 부팅 게이트는 process_to_show·nav_to_show 가 맡는다.
  // 두 무리의 원인(유휴 미리 받기와 트리 로드 경합으로 추정)을 밝히면 게이트로 올린다.
  "boot.booted_ms": app("ms", tol(0.25, 150), false, BOOT_RUNS),
  // 정보 — 유휴 미리 받기(영어 사전·지연 모달)가 부팅 표식과 경주해 부팅마다 ±250 KB 로 갈린다(2026-10-23 3단계 검증).
  // 같은 회귀는 1단계 bundle.boot_main_js_kb 가 결정적으로 CI 에서 막는다. 옛 커밋(f81f626d^) 대조에선 +488 KB 로 드러났다.
  "boot.js_before_show_kb": app("KB", tol(0.02, 10), false, BOOT_RUNS),
  // 정보 — CDP 로 IPC 가 보이는 건 확인했지만(§5.4) DB 상태·타이밍에 따라 실행 안에서도 28~35 로 흔들린다.
  "boot.ipc_before_show": app("count", tol(0, 3), false, BOOT_RUNS),
  "interact.note_open_ms": app("ms", tol(0.2, 15), true, INTERACT_RUNS),
  // 탭 내용이 그려진 시각 — 지연 화면 첫 열기 비용(React 19 Suspense 300ms 빈칸 회귀)을 잡는 게이트.
  "interact.dashboard_tab_paint_ms": app("ms", tol(0.25, 15), true, INTERACT_RUNS),
  // 정보 — IPC 정착까지. 달력 N+1(노트마다 note_get, ~420회)은 note_get_many 로 없앴다(2026-10-23, IPC 422→6, 555→443 ms
  // 부하 아래 참고 측정). 남은 시간은 dashboard_calendar 명령 자체(~300 ms). 조용한 상태에서 재기준선한 뒤 게이트로 올린다.
  "interact.dashboard_tab_ms": app("ms", tol(0.25, 10), false, INTERACT_RUNS),
  "interact.settings_open_ms": app("ms", tol(0.2, 20), true, INTERACT_RUNS),
  "interact.search_box_ms": app("ms", tol(0.2, 15), true, INTERACT_RUNS),
  // `--scale` 일 때만. 표의 "등"(관계 탭 등)은 레지스트리 밖 id 로 내도 정보 지표로 받는다.
  "scale.tree_load_100k_ms": app("ms", null, false, INTERACT_RUNS),
});

/** @param {string} group */
export function metricsInGroup(group) {
  return Object.keys(METRICS).filter((id) => METRICS[id].group === group);
}
