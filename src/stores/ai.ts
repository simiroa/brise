import { create } from "zustand";
import { call, callSilent, emitNotice } from "../lib/invoke";
import { reportFallback } from "../lib/diag";
import { t } from "../i18n/t";
import type {
  AiOrganizeNoteOutput,
  AiApplyOrganizeOutput,
  AiTestConnectionOutput,
  AiTranslateTextOutput,
  AiCleanupTextOutput,
  AiGenerateFromPromptOutput,
  AiGetHistoryOutput,
  AiHistoryItem,
  NoteDetail,
} from "../lib/commands.gen";
import { useNotesStore, isNoteContentLocked, displayTitle } from "./notes";
import { isLoopbackEndpoint } from "../lib/aiLoopback";
import { beginAiRequest } from "../lib/aiRequestState";
import { showUndoToast } from "../lib/undo";
import {
  computeFieldDiffs,
  buildRevertPayload,
  appliedValuesStillMatch,
  FIELD_LABEL_KEYS,
  type AiApplySelectionPayload,
  type CurrentNoteFields,
} from "../lib/aiProposalDiff";

// WF F2: metadata-apply's undo window is longer than the module default (5s) — the user is more
// likely to notice a wrong title/tags after actually reading the note than after a quick delete.
// Module-level DELAY_MS in lib/undo.ts stays untouched; every other showUndoToast/scheduleUndoableDelete
// caller is unaffected.
const METADATA_UNDO_DELAY_MS = 15000;

export interface AiOrganizeResult extends AiOrganizeNoteOutput {}
export type { AiHistoryItem };
export type AiProposalOrigin = "manual" | "background";

export type TranslateLang = "fr" | "en" | "ko";

export const AI_GLOW_KEYS = {
  note: (id: string) => `note:${id}`,
  tags: (id: string) => `tags:${id}`,
  editor: (id: string) => `editor:${id}`,
  section: (id: string) => `section:${id}`,
  diagram: (id: string) => `diagram:${id}`,
  translate: "translate",
  folder: (id: string) => `folder:${id}`,
  workspace: (id: string) => `workspace:${id}`,
  action: (id: string) => `action:${id}`,
} as const;

// 에디터 테두리 발광 억제(오너 2026-09-28) — AskAiModal 은 자기 안(결과 상자)에서 이미 빛줄기를
// 보여준다(useGenerationBeam). 그 동안 generateFromPrompt·runAiAction 이 같은 신호로 에디터 테두리까지
// 또 켜면 포커스(모달)와 눈길(에디터)이 어긋난다. 카운터라 겹쳐 불려도 안전하고, dispatchAskAi 한
// 곳에서만 감싸면 그 안의 모든 생성 경로(텍스트·선택 교체·관계도·시트)에 함께 적용된다 — 모달 밖의
// 직접 호출(SectionTabBar 등)은 그대로 에디터가 켜진다.
let editorGlowSuppressDepth = 0;
export function suppressEditorGlow<T>(fn: () => Promise<T>): Promise<T> {
  editorGlowSuppressDepth++;
  return fn().finally(() => {
    editorGlowSuppressDepth--;
  });
}
export function isEditorGlowSuppressed(): boolean {
  return editorGlowSuppressDepth > 0;
}

// Field-diff / tag-soft-cap logic used by the apply-confirmation UIs (AiConfirmModal,
// AiBatchOrganizeModal) moved to lib/aiProposalDiff.ts (W1, PLAN-2026-09-05 §1) — re-exported here
// so existing importers of `TAG_APPLY_SOFT_CAP` from this module keep working.
export { TAG_APPLY_SOFT_CAP } from "../lib/aiProposalDiff";

/** Glow lifecycle phases for `data-ai-glow`. */
export type AiGlowPhase = "active" | "fading";

/** Min time a glow stays `'active'` after `addGlow` before fade can start. */
export const AI_GLOW_MIN_VISIBLE_MS = 600;
/** Time spent in `'fading'` before the key is deleted from the map. */
export const AI_GLOW_FADE_MS = 300;

// Module-scoped timers/add-times — not in Zustand (no re-render on tick bookkeeping).
const glowTimers = new Map<string, ReturnType<typeof setTimeout>>();
const glowAddedAt = new Map<string, number>();

function clearGlowTimer(key: string) {
  const t = glowTimers.get(key);
  if (t !== undefined) {
    clearTimeout(t);
    glowTimers.delete(key);
  }
}

/** Clear all glow timers/maps — vitest only. */
export function _resetAiGlowForTests() {
  for (const t of glowTimers.values()) clearTimeout(t);
  glowTimers.clear();
  glowAddedAt.clear();
}

// Reachability cache lives at module scope so the fingerprint (which includes the
// api_key) is never part of Zustand state that components subscribe to or log.
let reachableFingerprint: string | null = null;
let reachableInFlight: Promise<void> | null = null;
let reachableInFlightFp: string | null = null;

// D3(AUDIT-2026-09-26): 실패한 probe 는 예전엔 fingerprint 매치인 한 세션 내내 캐시됐다 —
// 부팅 때 Ollama 가 늦게 뜨면 그 세션 동안 메인 창 AI 진입점이 전부 숨었다(사용자는 이유도
// 모른다). 실패 결과에만 TTL+백오프를 준다: 30s → 배로 증가 → 5min 캡. 같은 크리덴셜에
// 연속 실패할 때만 배가되고, 성공하거나 크리덴셜(fp)이 바뀌면 base 로 되돌아간다. 성공 결과는
// 오늘처럼 fp 매치인 한 영구 캐시(TTL 없음).
const REACHABLE_FAILED_TTL_BASE_MS = 30_000;
const REACHABLE_FAILED_TTL_MAX_MS = 5 * 60_000;
let reachableFailedAt: number | null = null; // 마지막 실패 완료 시각(epoch ms). null = 실패 캐시 없음.
let reachableFailedTtlMs = REACHABLE_FAILED_TTL_BASE_MS;
// 포커스/가시성 재검증 리스너는 한 세션에 한 번만 붙인다(여러 컴포넌트가 ensureAiReachable 을
// 마운트마다 부르므로, 리스너 등록은 그 첫 호출 시점에 지연 등록하고 플래그로 중복을 막는다).
let reachabilityListenerRegistered = false;

/** 같은 크리덴셜(fp)에 대한 연속 실패면 TTL을 두 배로(캡), 아니면(첫 실패/크리덴셜 변경) base 로. */
function recordReachableFailure(fp: string) {
  reachableFailedTtlMs =
    reachableFingerprint === fp && reachableFailedAt !== null
      ? Math.min(reachableFailedTtlMs * 2, REACHABLE_FAILED_TTL_MAX_MS)
      : REACHABLE_FAILED_TTL_BASE_MS;
  reachableFingerprint = fp;
  reachableFailedAt = Date.now();
}

/** 성공은 실패 백오프를 완전히 리셋하고 TTL 없이(오늘과 동일하게) 영구 캐시한다. */
function recordReachableSuccess(fp: string) {
  reachableFingerprint = fp;
  reachableFailedAt = null;
  reachableFailedTtlMs = REACHABLE_FAILED_TTL_BASE_MS;
}

/** 실패 캐시의 TTL 이 지났는가. 타임스탬프가 없으면(예: 이 필드가 없던 구 캐시) "영구 유효"가
 *  아니라 만료된 것으로 본다 — 안전한 쪽으로 기운다(재검증을 더 자주 하는 쪽). */
function isReachableFailureExpired(): boolean {
  if (reachableFailedAt === null) return true;
  return Date.now() - reachableFailedAt >= reachableFailedTtlMs;
}

/** 포커스/가시성 리스너가 재검증을 걸어도 되는가 — FAILED 캐시가 있고 TTL 이 지났을 때만.
 *  이 체크 자체는 어떤 IPC 도 안 하므로(module 상태만 봄), 만료 전이면 포커스가 잦아도
 *  probe storm 이 되지 않는다. */
function shouldRevalidateReachabilityNow(): boolean {
  if (reachableFingerprint === null) return false;
  if (useAiStore.getState().aiReachable !== false) return false;
  return isReachableFailureExpired();
}

/** 포커스 복귀/탭 가시화 시 만료된 FAILED 캐시만 재검증한다 — 한 세션에 리스너 한 쌍만 붙인다. */
function registerReachabilityRevalidation() {
  if (reachabilityListenerRegistered) return;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  reachabilityListenerRegistered = true;
  const revalidate = () => {
    if (shouldRevalidateReachabilityNow()) void useAiStore.getState().ensureAiReachable();
  };
  window.addEventListener("focus", revalidate);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") revalidate();
  });
}

/** Reset module-level reachability cache — vitest only. */
export function _resetAiReachableCacheForTests() {
  reachableFingerprint = null;
  reachableInFlight = null;
  reachableInFlightFp = null;
  reachableFailedAt = null;
  reachableFailedTtlMs = REACHABLE_FAILED_TTL_BASE_MS;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(AI_LAST_SUCCESS_KEY);
    }
  } catch {
    // silent-ok: localStorage unavailable or restricted in test environment
  }
  // reachabilityListenerRegistered 는 일부러 리셋하지 않는다 — window/document 리스너는 모듈이
  // 살아있는 한 유효하고, 중복 등록만 막으면 된다(리스너 자체를 뗄 이유가 없다).
}

export const AI_LAST_SUCCESS_KEY = "brise:ai_last_success";

export function loadAiLastSuccess(): { fingerprint: string; at: number } | null {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(AI_LAST_SUCCESS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.fingerprint === "string") {
          return parsed;
        }
      }
    }
  } catch {
    // silent-ok: private browsing or storage disabled
  }
  return null;
}

export function saveAiLastSuccess(fingerprint: string) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(AI_LAST_SUCCESS_KEY, JSON.stringify({ fingerprint, at: Date.now() }));
    }
  } catch {
    // silent-ok: storage quota exceeded or disabled
  }
}

// 표준 SHA-256(FIPS 180-4) — 동기식이 필요한 지문 비교용. Web Crypto(subtle.digest)는 비동기라 이 경로에 맞지 않는다.
// 2026-10-19: 앞선 구현(소수 체로 상수를 만드는 스니펫)은 표준과 다른 값을 내고 결과도 흔들려 교체했다 —
// ai.test.ts 가 node:crypto 와 여러 길이·UTF-8 입력으로 대조한다.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Sync(str: string): string {
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  const bytes = new TextEncoder().encode(str);
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLen = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let t = 0; t < 64; t++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[t] + w[t]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return Array.from(h, (v) => v.toString(16).padStart(8, "0")).join("");
}

export function computeAiCredsFingerprint(creds: {
  provider: string;
  endpoint?: string;
  api_key?: string;
  model?: string;
}): string {
  const raw = [creds.provider, creds.endpoint ?? "", creds.api_key ?? "", creds.model ?? ""].join("\0");
  return sha256Sync(raw);
}

export type AiAvailability = "off" | "checking" | "unreachable" | "ready";

/**
 * Single source of truth for whether AI features are available across the UI.
 * - off: AI disabled in settings
 * - checking: probe in-flight without remembered success (dimmed entry, "AI 연결 확인 중…")
 * - unreachable: probe failed (dimmed entry, "AI 에 연결할 수 없음 — 설정에서 확인")
 * - ready: enabled and reachable (or remembered success while re-probing)
 */
export function selectAiAvailability(
  settings: { aiEnabled?: boolean } | null | undefined,
  ai: { aiReachable?: boolean | null; aiReachableChecking?: boolean } | null | undefined,
): AiAvailability {
  if (!settings?.aiEnabled) {
    return "off";
  }
  if (ai?.aiReachable === true) {
    return "ready";
  }
  if (ai?.aiReachable === false) {
    return "unreachable";
  }
  return "checking";
}

export function getAiDisabledHint(
  availability: AiAvailability,
  namespace: "editor" | "mobile" | "presets" = "editor",
): string {
  if (namespace === "presets") {
    if (availability === "checking") return t("presets.ai_checking");
    if (availability === "unreachable") return t("presets.ai_unreachable");
    return t("presets.ai_disabled_hint");
  }
  if (namespace === "mobile") {
    if (availability === "checking") return t("mobile.ai_checking");
    if (availability === "unreachable") return t("mobile.ai_unreachable");
    return t("mobile.ai_disabled_hint");
  }
  if (availability === "checking") return t("editor.ai_checking");
  if (availability === "unreachable") return t("editor.ai_unreachable");
  return t("editor.ai_disabled_hint");
}

/** Strip accidental key material from error strings before they enter UI state. */
export function safeConnError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object") {
    if ("message" in err && typeof (err as { message: unknown }).message === "string") {
      return (err as { message: string }).message;
    }
    if ("code" in err && typeof (err as { code: unknown }).code === "string") {
      return (err as { code: string }).code;
    }
  }
  return "";
}

interface AiState {
  aiGlowTargets: Map<string, AiGlowPhase>;
  addGlow: (key: string) => void;
  removeGlow: (key: string) => void;
  organizePending: boolean;
  lastProposal: AiOrganizeResult | null;
  /** Origin is tracked so background post-processing cannot replace a manual review. */
  lastProposalOrigin: AiProposalOrigin | null;
  /** Which note lastProposal was generated FOR — may differ from the active note (Ask-AI modal
   *  can target a tree/tab row that isn't open). null = "whatever's active" (legacy callers that
   *  never pass a noteId to organizeCurrentNote). applyProposal must apply to THIS id, not
   *  whatever happens to be active at Apply-click time — see that function's comment. */
  lastProposalNoteId: string | null;
  /** Background proposals wait here until their target is relevant and no manual review is open. */
  backgroundProposals: Map<string, AiOrganizeResult>;
  /** Explicit user requests are retained per target so a second note cannot replace a review. */
  manualProposals: Map<string, AiOrganizeResult>;
  restoreBackgroundProposal: (noteId: string) => boolean;
  availableModels: string[];
  historyItems: AiHistoryItem[];
  loadHistory: () => Promise<void>;
  /** null = unknown (never tested, or a check is in flight after invalidate). */
  aiReachable: boolean | null;
  aiReachableError: string | null;
  aiReachableChecking: boolean;
  /**
   * Cached connection probe. No-ops when the provider/endpoint/key/model fingerprint
   * matches the last completed result. Clears when AI is off. Re-runs after toggle-on
   * (fingerprint cleared while off) and when creds change.
   */
  ensureAiReachable: () => Promise<void>;
  /** Always re-tests (Settings "Test connection"). Updates reachability flags. */
  testConnection: () => Promise<{ latencyMs: number, models: string[] }>;
  /** noteId omitted = active note (legacy call sites: the AI dropdown's metadata preset always
   *  targets the open note). Ask-AI modal chips pass an explicit noteId so a tree/tab right-click
   *  can organize a note that isn't the one currently open in the editor.
   *  `silent` = never toast on failure (callSilent) — for the background post-process
   *  (lib/aiPostProcess.ts), which the user never asked for and must not nag about.
   *  `opts.model` overrides the settings-derived model (e.g. a collect source's
   *  post_process_model); `opts.origin` is passed through to ai_organize_note as-is (e.g.
   *  "collect_post_process" — see plugins/pet/bridge/petCollectBridge.ts). */
  organizeCurrentNote: (
    noteId?: string,
    fields?: string[],
    customPrompt?: string,
    silent?: boolean,
    opts?: { model?: string; origin?: string },
  ) => Promise<void>;
  clearProposal: () => void;
  /**
   * Apply lastProposal. `selection` (built by lib/aiProposalDiff.ts's buildApplyPayload from the
   * confirm UI's per-field checkboxes) replaces the proposal's fields wholesale — omitted keys are
   * sent as `undefined`, which ai_apply_organize treats as "don't touch" (Option::None, Rust side
   * unchanged). No `selection` = apply the full proposal unfiltered (legacy/non-UI callers).
   */
  applyProposal: (selection?: AiApplySelectionPayload) => Promise<void>;

  // ── 번역 (에디터 툴바, 마이크 아이콘 옆 토글) ──────────────────────────────────────────
  translateEnabled: boolean;
  translateTargetLang: TranslateLang;
  translatedText: string;
  translatePending: boolean;
  // null = 아직 게이트를 확인 안 함. false = 클라우드 프로바이더인데 ai_enabled 꺼짐(차단).
  translateGateOk: boolean | null;
  loadTranslatePrefs: () => Promise<void>;
  setTranslateEnabled: (v: boolean) => Promise<boolean>; // false 반환 = 게이트에 막혀 켜지지 않음
  setTranslateTargetLang: (v: TranslateLang) => Promise<void>;
  refreshTranslateGate: () => Promise<boolean>;
  translateNow: (text: string, opts?: { requestId?: string }) => Promise<void>;
  // 선택 텍스트 번역(에디터 컨텍스트 메뉴 "선택 번역") — 툴바 토글(translateEnabled)과는 별도
  // 플래그다. 토글을 억지로 켜면 그 순간부터 전체 문서가 계속 재번역되기 시작해(TranslateControl의
  // transaction 리스너가 translateEnabled 에 물려 있음) 사용자가 요청한 적 없는 "항상 켜짐"으로
  // 변한다. translateSelectionActive 는 그와 무관하게 TranslatePanel만 열어 보여주는 표시용
  // 플래그 — 최소 침습.
  translateSelectionActive: boolean;
  translateSelection: (text: string) => Promise<void>;

  // ── AI 드롭다운: 에디터 내용 정리 / 프롬프트 박스 (TitleBar의 AI 버튼) ─────────────────────
  cleanupPending: boolean;
  promptPending: boolean;
  // WB(2026-09-05) B1: opts.requestId는 결과 프리뷰 게이트(stores/aiResultGate.ts)가 이번 생성
  // 시도용으로 만든 취소 키다 — 옵션 인자라 기존 호출자는 그대로 두 인자만 넘겨도 된다.
  cleanupText: (text: string, opts?: { requestId?: string }) => Promise<string | null>;
  generateFromPrompt: (
    prompt: string,
    contextText: string | null,
    opts?: { requestId?: string; presetId?: string; purpose?: "transform" | "generate" | "json" },
  ) => Promise<string | null>;
}

// AI 커맨드 공통 인자(provider/endpoint/api_key/model)를 settings 에서 한 번에 뽑는다.
// D1(AUDIT-2026-09-26): export 는 이 한 줄뿐 — chatMemoryExtractor.ts/diagramAi.ts 가
// ai_generate_from_prompt 를 부르며 이 크리덴셜을 중복 구현하지 않고 재사용하려고 밖에 연다
// (당시엔 chatSearchTool.ts 도 썼다 — 2026-10-09 Wave S 에서 유사어 확장과 함께 삭제).
// 그 파일들이 이미 저지른 버그: provider 누락 + api_key/model 에 "omit" 리터럴 —
// Rust 쪽 provider: String 은 필수라 인자 역직렬화에서 조용히 거부됐다. 로직은 그대로다.
export async function aiCreds() {
  const s = await call<{ settings: Record<string, unknown> }>("settings_get_all");
  return {
    provider: ((s.settings.ai_provider as string) || "ollama").toLowerCase() as any,
    endpoint: (s.settings.ai_endpoint as string) || undefined,
    api_key: (s.settings.ai_api_key as string) || undefined,
    model: (s.settings.ai_model as string) || undefined,
  };
}

// Exported (not just used by organizeCurrentNote) so the §2.5 batch-organize flow
// (DataManagementSection → AiBatchOrganizeModal) can build the same provider/endpoint/
// api_key/model args for *other* notes' ids without duplicating the settings lookup.
export async function buildAiArgs(noteId: string) {
  return { id: noteId, ...(await aiCreds()) };
}

export const useAiStore = create<AiState>((set, get) => ({
  aiGlowTargets: new Map<string, AiGlowPhase>(),

  addGlow: (key: string) => {
    if (!key) return;
    // Re-add cancels any pending min-visible/fade timers and returns to active.
    clearGlowTimer(key);
    glowAddedAt.set(key, Date.now());
    set((state) => {
      if (state.aiGlowTargets.get(key) === "active") return state;
      const next = new Map(state.aiGlowTargets);
      next.set(key, "active");
      return { aiGlowTargets: next };
    });
  },

  removeGlow: (key: string) => {
    if (!key) return;
    const phase = get().aiGlowTargets.get(key);
    if (!phase) return;
    // Already fading — leave the existing delete timer alone.
    if (phase === "fading") return;

    clearGlowTimer(key);

    const addedAt = glowAddedAt.get(key) ?? Date.now();
    const remainingActive = Math.max(0, AI_GLOW_MIN_VISIBLE_MS - (Date.now() - addedAt));

    const startFade = () => {
      // Bail if re-added or already gone while we waited.
      if (get().aiGlowTargets.get(key) !== "active") return;
      set((state) => {
        if (state.aiGlowTargets.get(key) !== "active") return state;
        const next = new Map(state.aiGlowTargets);
        next.set(key, "fading");
        return { aiGlowTargets: next };
      });
      clearGlowTimer(key);
      const t = setTimeout(() => {
        glowTimers.delete(key);
        glowAddedAt.delete(key);
        set((state) => {
          if (!state.aiGlowTargets.has(key)) return state;
          const next = new Map(state.aiGlowTargets);
          next.delete(key);
          return { aiGlowTargets: next };
        });
      }, AI_GLOW_FADE_MS);
      glowTimers.set(key, t);
    };

    if (remainingActive > 0) {
      glowTimers.set(key, setTimeout(startFade, remainingActive));
    } else {
      startFade();
    }
  },

  organizePending: false,
  lastProposal: null,
  lastProposalOrigin: null,
  lastProposalNoteId: null,
  backgroundProposals: new Map<string, AiOrganizeResult>(),
  manualProposals: new Map<string, AiOrganizeResult>(),
  restoreBackgroundProposal: (noteId) => {
    const proposal = get().backgroundProposals.get(noteId);
    if (!proposal || get().lastProposalOrigin === "manual" || get().manualProposals.size > 0) return false;
    set({ lastProposal: proposal, lastProposalNoteId: noteId, lastProposalOrigin: "background" });
    return true;
  },
  availableModels: [],
  historyItems: [],
  aiReachable: null,
  aiReachableError: null,
  aiReachableChecking: false,

  loadHistory: async () => {
    try {
      const s = await call<{ settings: Record<string, unknown> }>("settings_get_all");
      const activeWsId = (s.settings.active_workspace_id as string) || "";
      if (!activeWsId) return;
      const res = await call<AiGetHistoryOutput>("ai_get_history", { workspace_id: activeWsId });
      set({ historyItems: res.items || [] });
    } catch {
      /* call() handled */
    }
  },

  ensureAiReachable: async () => {
    // D3: 포커스/가시성 복귀 시 만료된 FAILED 캐시를 재검증하는 리스너 — 한 세션에 한 번만.
    registerReachabilityRevalidation();

    // 백그라운드 자동 probe(TitleBar 등 마운트 시마다 조용히 재확인) — 사용자가 누른 액션이
    // 아니므로 call() 대신 callSilent() 를 쓴다(lib/invoke.ts 의 call/callSilent 구분 규약).
    // 수동 "연결 테스트" 버튼(testConnection, 아래)은 사용자 액션이라 call() 그대로 유지.
    let settings: Record<string, unknown>;
    try {
      const s = await callSilent<{ settings: Record<string, unknown> }>("settings_get_all");
      settings = s.settings;
    } catch {
      set({ aiReachable: false, aiReachableError: "", aiReachableChecking: false });
      return;
    }

    if (!Boolean(settings.ai_enabled)) {
      // Clear fingerprint so the next toggle-on always re-probes (rule: re-test on enable).
      reachableFingerprint = null;
      reachableInFlight = null;
      reachableInFlightFp = null;
      reachableFailedAt = null;
      reachableFailedTtlMs = REACHABLE_FAILED_TTL_BASE_MS;
      set({ aiReachable: null, aiReachableError: null, aiReachableChecking: false });
      return;
    }

    const creds = {
      provider: ((settings.ai_provider as string) || "ollama").toLowerCase(),
      endpoint: (settings.ai_endpoint as string) || undefined,
      api_key: (settings.ai_api_key as string) || undefined,
      model: (settings.ai_model as string) || undefined,
    };
    const fp = computeAiCredsFingerprint(creds);
    const sameCreds = reachableFingerprint === fp;

    // Cache hit: same creds, already have a definitive result, nothing in flight, and — if that
    // result was a FAILURE — its TTL hasn't expired yet (D3). A success stays cached forever
    // (today's behavior, unchanged) as long as the fingerprint still matches.
    if (
      sameCreds &&
      get().aiReachable !== null &&
      !get().aiReachableChecking &&
      !reachableInFlight &&
      (get().aiReachable === true || !isReachableFailureExpired())
    ) {
      return;
    }

    // Join an in-flight probe for the same fingerprint.
    if (reachableInFlight && reachableInFlightFp === fp) {
      await reachableInFlight;
      return;
    }

    const remembered = loadAiLastSuccess();
    const hasRememberedSuccess = Boolean(remembered && remembered.fingerprint === fp);

    if (sameCreds) {
      // 같은 크리덴셜의 재검증(FAILED 캐시 TTL 만료) — 이미 false 였던 걸 null 로 바꾸면
      // "숨겨졌다가 다시 나타나는" 깜빡임이 생긴다. checking 만 켜고 값은 그대로 둔다.
      set({ aiReachableChecking: true });
    } else if (hasRememberedSuccess) {
      // Remembered success: immediately show ready while re-checking in the background!
      set({ aiReachable: true, aiReachableError: null, aiReachableChecking: true });
    } else {
      // Creds changed (or first run): hide the entry until we know — no flash of a stale button.
      set({ aiReachable: null, aiReachableError: null, aiReachableChecking: true });
    }

    const run = (async () => {
      try {
        const res = await callSilent<AiTestConnectionOutput>("ai_test_connection", {
          provider: creds.provider as any,
          endpoint: creds.endpoint,
          api_key: creds.api_key,
        });
        const parsedModels = Array.isArray(res.models) ? res.models : [];
        if (res.ok) {
          recordReachableSuccess(fp);
          saveAiLastSuccess(fp);
          set({
            aiReachable: true,
            aiReachableError: null,
            aiReachableChecking: false,
            availableModels: parsedModels,
          });
        } else {
          recordReachableFailure(fp);
          set({
            aiReachable: false,
            aiReachableError: "",
            aiReachableChecking: false,
            availableModels: parsedModels,
          });
        }
      } catch (e) {
        recordReachableFailure(fp);
        const scrubbed = safeConnError(e);
        // A(AUDIT-2026-09-26): this background probe (ensureAiReachable, unlike the manual
        // testConnection button) had no trace anywhere on failure — D3's whole point was that it
        // then hides the AI entry point for the rest of the TTL with no way to tell why.
        reportFallback("ai", "probe_failed", scrubbed);
        set({
          aiReachable: false,
          aiReachableError: scrubbed,
          aiReachableChecking: false,
        });
      } finally {
        if (reachableInFlightFp === fp) {
          reachableInFlight = null;
          reachableInFlightFp = null;
        }
      }
    })();

    reachableInFlight = run;
    reachableInFlightFp = fp;
    await run;
  },

  testConnection: async () => {
    // Manual "Test connection" always re-probes and refreshes the cache.
    const args = await buildAiArgs("");
    const fp = computeAiCredsFingerprint(args);
    set({ aiReachableChecking: true });
    try {
      const res = await call<AiTestConnectionOutput>("ai_test_connection", {
        provider: args.provider,
        endpoint: args.endpoint,
        api_key: args.api_key,
      });
      const parsedModels = Array.isArray(res.models) ? res.models : [];
      if (!res.ok) {
        // D3: 수동 테스트도 자동 probe 와 같은 실패 북키핑을 남긴다 — 안 그러면 다음
        // ensureAiReachable 이 이 실패를 "타임스탬프 없는 캐시"로 보고 즉시 만료 취급해
        // 버튼을 누르자마자 또 재검증하게 된다(무해하지만 불필요한 IPC).
        recordReachableFailure(fp);
        set({
          aiReachable: false,
          aiReachableError: "",
          aiReachableChecking: false,
          availableModels: parsedModels,
        });
        const err = new Error("connection_failed");
        throw err;
      }
      recordReachableSuccess(fp);
      saveAiLastSuccess(fp);
      set({
        aiReachable: true,
        aiReachableError: null,
        aiReachableChecking: false,
        availableModels: parsedModels,
      });
      return { latencyMs: res.latency_ms, models: parsedModels };
    } catch (e) {
      // Only overwrite reachable flags when this wasn't already handled as !res.ok above.
      if (get().aiReachableChecking) {
        recordReachableFailure(fp);
        set({
          aiReachable: false,
          aiReachableError: safeConnError(e) === "connection_failed" ? "" : safeConnError(e),
          aiReachableChecking: false,
        });
      }
      throw e;
    }
  },

  organizeCurrentNote: async (noteId, fields, customPrompt, silent, opts) => {
    const targetId = noteId ?? useNotesStore.getState().activeNote?.note.id;
    if (!targetId) return;

    const glowKey =
      fields && fields.length === 1 && fields[0] === "tags"
        ? AI_GLOW_KEYS.tags(targetId)
        : AI_GLOW_KEYS.note(targetId);

    const request = beginAiRequest("organize", targetId);
    get().addGlow(glowKey);
    // A manual request only clears its own visible proposal. A background request must never
    // dismiss an in-progress manual review for another note.
    if (!silent) {
      set((state) => {
        const manualProposals = new Map(state.manualProposals);
        // A retry invalidates only its own previous result. Other manual reviews remain queued.
        manualProposals.delete(targetId);
        if (state.lastProposalOrigin === "manual" && state.lastProposalNoteId === targetId) {
          return {
            organizePending: true,
            lastProposal: null,
            lastProposalNoteId: null,
            lastProposalOrigin: null,
            manualProposals,
          };
        }
        return { organizePending: true, manualProposals };
      });
    } else {
      set({ organizePending: true });
    }
    try {
      const args = await buildAiArgs(targetId);
      const res = await (silent ? callSilent : call)<AiOrganizeNoteOutput>("ai_organize_note", {
        ...args,
        model: opts?.model ?? args.model,
        ...(opts?.origin ? { origin: opts.origin } : {}),
        fields,
        custom_prompt: customPrompt?.trim() || undefined,
      });

      // The response can arrive after a newer request for this note. Never let it replace the
      // newer proposal; this is especially important when a user retries from Ask AI.
      if (request.isLatest()) {
        if (silent) {
          set((state) => {
            // A manual proposal for the same note reflects an explicit user action and wins over
            // the background result as well as over any older background result.
            if (state.lastProposalOrigin === "manual" && state.lastProposalNoteId === targetId) return state;
            const backgroundProposals = new Map(state.backgroundProposals);
            backgroundProposals.set(targetId, res);
            return { backgroundProposals };
          });
        } else {
          set((state) => {
            const manualProposals = new Map(state.manualProposals);
            manualProposals.set(targetId, res);
            // Never replace a visible review for another explicitly requested note. The pending
            // result will be promoted by clearProposal/applyProposal in insertion order.
            if (state.lastProposalOrigin === "manual" && state.lastProposalNoteId !== targetId) {
              return { manualProposals };
            }
            return {
              manualProposals,
              lastProposal: res,
              lastProposalNoteId: targetId,
              lastProposalOrigin: "manual",
            };
          });
        }
      }
    } catch {
      /* call() 이 이미 토스트를 띄웠다 */
    } finally {
      const pending = request.finish();
      set({ organizePending: pending.kindPending });
      if (!pending.keyPending) get().removeGlow(glowKey);
    }
  },

  clearProposal: () => {
    const { lastProposalOrigin, lastProposalNoteId } = get();
    let promotedManual = false;
    set((state) => {
      const manualProposals = new Map(state.manualProposals);
      if (lastProposalOrigin === "manual" && lastProposalNoteId) manualProposals.delete(lastProposalNoteId);
      const nextManual = manualProposals.entries().next().value as [string, AiOrganizeResult] | undefined;
      if (nextManual) {
        promotedManual = true;
        return {
          manualProposals,
          lastProposal: nextManual[1],
          lastProposalNoteId: nextManual[0],
          lastProposalOrigin: "manual",
        };
      }
      return { manualProposals, lastProposal: null, lastProposalNoteId: null, lastProposalOrigin: null };
    });
    if (promotedManual) return;
    // Cancelling a manual review should not discard a background proposal for the note the user
    // is currently examining. It becomes available immediately instead of being lost.
    if (lastProposalOrigin === "manual") {
      const activeId = useNotesStore.getState().activeNote?.note.id;
      if (activeId) get().restoreBackgroundProposal(activeId);
    } else if (lastProposalOrigin === "background" && lastProposalNoteId) {
      set((state) => {
        const backgroundProposals = new Map(state.backgroundProposals);
        backgroundProposals.delete(lastProposalNoteId);
        return { backgroundProposals };
      });
    }
  },

  applyProposal: async (selection) => {
    const proposal = get().lastProposal;
    // Bug fix: this used to always read the ACTIVE note, even though organizeCurrentNote can now
    // target a different note (Ask-AI modal on a tree/tab row that isn't open) — Apply would then
    // write the proposal onto whatever note happens to be open at click time, not the one it was
    // generated for. lastProposalNoteId is set alongside lastProposal for exactly this; the
    // `?? activeNote` fallback keeps every pre-existing call site (organizeCurrentNote() with no
    // noteId, e.g. the AI dropdown's metadata preset) working unchanged.
    const noteId = get().lastProposalNoteId ?? useNotesStore.getState().activeNote?.note.id;
    if (!proposal || !noteId) return;

    // 내용잠금: organizeCurrentNote는 "제안을 만드는" 단계라 답하는 것과 같아 막지 않는다 — 여기
    // applyProposal이 실제로 title/tags/region/... 을 ai_apply_organize로 써넣는 지점이라
    // insertAiSection과 같은 원칙으로 여기서 막는다. 대상이 지금 열린 노트가 아닐 수도 있으므로
    // (백그라운드/트리 행 대상 organize) id-keyed 헬퍼를 쓴다.
    if (isNoteContentLocked(noteId)) {
      emitNotice(t("editor.content_locked_tooltip"));
      return;
    }

    // No selection = legacy "apply everything" (non-UI callers / tests). The confirm UI always
    // passes a selection built by lib/aiProposalDiff.ts's buildApplyPayload, where an unchecked
    // field is simply absent (→ undefined here → Option::None on the Rust side, "don't touch").
    const fields: AiApplySelectionPayload = selection ?? {
      title: proposal.title,
      year: proposal.year,
      tag_names: proposal.tag_names,
      region: proposal.region,
      lat: proposal.lat,
      lng: proposal.lng,
      source_urls: proposal.source_urls,
      folder_id: proposal.folder_id,
    };

    // W6 (§1.5) + A2 (PLAN-2026-09-05 §1 A-2 revert): captured BEFORE the apply call — the undo
    // toast below needs "what the note looked like before this apply", and noteIndex is about to
    // go stale the moment loadTree() re-fetches. currentBeforeApply undefined (note not resident
    // in noteIndex) means "we don't actually know the old values" — revert is skipped below rather
    // than guessing with an all-empty fallback (a bogus folder_id: "" would fail
    // ai_apply_organize's own folder lookup).
    // 토스트 문구용 — 저장 센티널 "Untitled Note" 도 "제목 없음"으로(displayTitle).
    const noteTitle = displayTitle(useNotesStore.getState().noteIndex.get(noteId)?.title ?? "");
    const currentBeforeApply: CurrentNoteFields | undefined = useNotesStore.getState().noteIndex.get(noteId);

    try {
      await call<AiApplyOrganizeOutput>("ai_apply_organize", {
        id: noteId,
        ...fields,
      });
    } catch {
      return;
    }

    // ai_apply_organize writes title/year/tags/region/lat/lng straight in the backend — same
    // fields the tree row and every expanded filter view read, so this needs the same
    // loadTree() chokepoint as every other note mutation (see ContextMenu.tsx, noteActions.ts).
    // reloadActive() alone only refreshed the open editor; the sidebar tree and any active
    // filtered view (Tags/Status/Region/Timeline/Calendar) kept showing pre-organize data.
    await useNotesStore.getState().loadTree();
    const activeId = useNotesStore.getState().activeNote?.note.id;
    // TitleBar's savedState badge is for the OPEN editor only. A background-note organize
    // (tree/tab Ask-AI while another note is open) must not paint "ai_organized" on the wrong note.
    if (noteId === activeId) {
      await useNotesStore.getState().reloadActive();
      useNotesStore.getState().setSavedState("ai_organized");
    }

    // W6 (§1.5 진짜 갭) + A2 (PLAN-2026-09-05 §1 A-2 revert): the note can change in ways that are
    // hard to notice or hard to walk back by hand (moved out of view, title/tags/region rewritten)
    // — one undo toast for the WHOLE apply, folding the old folder-only toast into a general
    // revert built from the same (current, proposal) diff the confirm modal showed the user.
    // buildRevertPayload leaves out what it has no way to restore (see its own doc comment) —
    // never revert at all when the note's pre-apply values weren't resident in noteIndex, rather
    // than guess with an empty fallback (applies to A-2's "we don't know the old folder" case too).
    if (currentBeforeApply) {
      const diffs = computeFieldDiffs(currentBeforeApply, proposal);
      const { payload: revertPayload, unrevertableKeys } = buildRevertPayload(diffs, fields, currentBeforeApply.tag_names);
      if (Object.keys(revertPayload).length > 0) {
        const label =
          unrevertableKeys.length > 0
            ? t("undo.metadata_applied_partial", {
                note: noteTitle,
                fields: unrevertableKeys.map((k) => t(FIELD_LABEL_KEYS[k])).join(", "),
              })
            : t("undo.metadata_applied", { note: noteTitle });
        // WF F2: Toast.tsx's own undo-toast row still auto-hides at its hardcoded 5s fallback
        // (onUndoToast subscriber, ../components/Toast.tsx) — out of this wave's edit scope, so
        // the visible button window isn't actually 15s yet. Ctrl+Z (undoLast(), lib/undo.ts's
        // single latestUndo slot) DOES stay armed for the full 15s regardless. ponytail: upgrade
        // path is threading an optional ttl through UndoToast/onUndoToast into that push() call.
        showUndoToast(
          label,
          () => {
            void (async () => {
              // Re-check right before reverting, not when the toast was created — the whole point
              // of a 15s window is that the user had time to edit the note themselves in the
              // meantime, and that edit must win over a stale AI revert. noteIndex can be behind by
              // now (another apply, a manual edit) so this re-fetches from the DB rather than
              // trusting the snapshot taken above.
              let latest: CurrentNoteFields;
              try {
                latest = (await call<NoteDetail>("note_get", { id: noteId })).note;
              } catch {
                return; // call() already toasted; can't verify safely, so don't guess
              }
              if (!appliedValuesStillMatch(fields, latest)) {
                emitNotice(t("undo.edit_conflict_skipped", { note: noteTitle }));
                return;
              }
              try {
                await call<AiApplyOrganizeOutput>("ai_apply_organize", { id: noteId, ...revertPayload });
              } catch {
                return; // call() already toasted the failure
              }
              await useNotesStore.getState().loadTree();
              if (useNotesStore.getState().activeNote?.note.id === noteId) {
                await useNotesStore.getState().reloadActive();
              }
            })();
          },
          { delayMs: METADATA_UNDO_DELAY_MS },
        );
      }
    }

    set((state) => {
      const backgroundProposals = new Map(state.backgroundProposals);
      const manualProposals = new Map(state.manualProposals);
      backgroundProposals.delete(noteId);
      if (state.lastProposalOrigin === "manual") manualProposals.delete(noteId);
      const nextManual = manualProposals.entries().next().value as [string, AiOrganizeResult] | undefined;
      return nextManual
        ? {
            lastProposal: nextManual[1],
            lastProposalNoteId: nextManual[0],
            lastProposalOrigin: "manual",
            backgroundProposals,
            manualProposals,
          }
        : { lastProposal: null, lastProposalNoteId: null, lastProposalOrigin: null, backgroundProposals, manualProposals };
    });
    void get().loadHistory();
  },

  translateEnabled: false,
  translateTargetLang: "en",
  translatedText: "",
  translatePending: false,
  translateGateOk: null,
  translateSelectionActive: false,

  loadTranslatePrefs: async () => {
    try {
      const s = await call<{ settings: Record<string, unknown> }>("settings_get_all");
      set({
        translateEnabled: Boolean(s.settings.translate_enabled),
        translateTargetLang: ((s.settings.translate_target_lang as string) || "en") as TranslateLang,
      });
    } catch {
      /* call() 이 이미 토스트를 띄웠다 */
    }
  },

  refreshTranslateGate: async () => {
    try {
      const s = await call<{ settings: Record<string, unknown> }>("settings_get_all");
      const aiEnabled = Boolean(s.settings.ai_enabled);
      const provider = ((s.settings.ai_provider as string) || "ollama").toLowerCase();
      const endpoint = (s.settings.ai_endpoint as string) || (provider === "ollama" ? "http://localhost:11434" : "");
      // 프론트에서 미리 계산해 토글 시점에 보여준다. 최종 게이트는 서버 repo::ai::is_loopback_endpoint.
      const isLocal = provider === "ollama" && isLoopbackEndpoint(endpoint);
      const ok = aiEnabled || isLocal;
      set({ translateGateOk: ok });
      return ok;
    } catch {
      set({ translateGateOk: false });
      return false;
    }
  },

  setTranslateEnabled: async (v) => {
    if (v) {
      const ok = await get().refreshTranslateGate();
      if (!ok) return false;
    }
    set({ translateEnabled: v });
    if (!v) set({ translatedText: "" });
    await callSilent("settings_set", { entries: { translate_enabled: v } }).catch(() => {});
    return true;
  },

  setTranslateTargetLang: async (v) => {
    set({ translateTargetLang: v, translatedText: "" });
    await callSilent("settings_set", { entries: { translate_target_lang: v } }).catch(() => {});
  },

  // 번역은 읽기전용 뷰 상태(translatedText)만 갱신한다 — note/section 관련 store 함수를
  // 절대 호출하지 않는다(원본 섹션 본문을 건드리는 경로가 이 함수 안에 존재하지 않음).
  translateNow: async (text: string, opts?: { requestId?: string }) => {
    const trimmed = text.trim();
    const lang = get().translateTargetLang;
    if (!trimmed) {
      set({ translatedText: "", translatePending: false });
      return;
    }
    const creds = await aiCreds().catch(() => null);
    if (!creds) return;

    const request = beginAiRequest("translate", "document");
    get().addGlow(AI_GLOW_KEYS.translate);
    set({ translatePending: true });
    try {
      const res = await call<AiTranslateTextOutput>("ai_translate_text", {
        text: trimmed,
        target_lang: lang,
        request_id: opts?.requestId,
        ...creds,
      });
      if (request.isLatest()) set({ translatedText: res.translated });
    } catch {
      /* call() 이 이미 토스트를 띄웠다(예: 프라이버시 게이트에 막힘) */
    } finally {
      const pending = request.finish();
      set({ translatePending: pending.kindPending });
      if (!pending.keyPending) get().removeGlow(AI_GLOW_KEYS.translate);
    }
  },

  translateSelection: async (text: string) => {
    set({ translateSelectionActive: true });
    await get().translateNow(text);
  },

  cleanupPending: false,
  promptPending: false,

  cleanupText: async (text: string, opts?: { requestId?: string }) => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    // 프론트 쪽 게이트 선확인(방어적 2중화 — 최종 판정은 항상 백엔드): 아직 게이트를 확인한
    // 적 없으면(null) 지금 확인한다. setTranslateEnabled(true)와 동일한 관례.
    const gateOk = get().translateGateOk ?? (await get().refreshTranslateGate());
    if (!gateOk) return null;

    const request = beginAiRequest("cleanup", useNotesStore.getState().activeNote?.note.id ?? "__global__");
    set({ cleanupPending: true });
    try {
      const res = await call<AiCleanupTextOutput>("ai_cleanup_text", {
        text: trimmed,
        request_id: opts?.requestId,
        ...(await aiCreds()),
      });
      return res.cleaned;
    } catch {
      /* call() 이 이미 토스트를 띄웠다(예: 프라이버시 게이트에 막힘) */
      return null;
    } finally {
      set({ cleanupPending: request.finish().kindPending });
    }
  },

  generateFromPrompt: async (
    prompt: string,
    contextText: string | null,
    opts?: { requestId?: string; presetId?: string; purpose?: "transform" | "generate" | "json" },
  ) => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) return null;
    const gateOk = get().translateGateOk ?? (await get().refreshTranslateGate());
    if (!gateOk) return null;

    const activeNoteId = useNotesStore.getState().activeNote?.note.id;
    const glowKey = activeNoteId && !isEditorGlowSuppressed() ? AI_GLOW_KEYS.editor(activeNoteId) : null;

    const request = beginAiRequest("prompt", activeNoteId ?? "__global__");
    if (glowKey) get().addGlow(glowKey);
    set({ promptPending: true });
    try {
      const res = await call<AiGenerateFromPromptOutput>("ai_generate_from_prompt", {
        prompt: trimmedPrompt,
        context_text: contextText?.trim() || undefined,
        purpose: opts?.purpose,
        request_id: opts?.requestId,
        preset_id: opts?.presetId,
        ...(await aiCreds()),
      });
      return res.generated;
    } catch {
      return null;
    } finally {
      const pending = request.finish();
      set({ promptPending: pending.kindPending });
      if (glowKey && !pending.keyPending) get().removeGlow(glowKey);
    }
  },
}));

/** Subscribe to a glow key's phase for `data-ai-glow="active"|"fading"`. */
export function useAiGlow(key: string | null | undefined): AiGlowPhase | false {
  return useAiStore((state) => (key ? state.aiGlowTargets.get(key) ?? false : false));
}


/**
 * Click-time AI gate for every "AI에게 묻기" entry point that isn't already covered by an
 * aiReachable-gated menu (tree/tab/section rows, the Ask-AI modal's own open) — mirrors
 * EditorPanel.tsx's openSelectionAiAsk (refreshTranslateGate + emitNotice on block), so a user
 * never opens a prompt box that will silently do nothing once they submit it. Backend
 * privacy_gate_ok is the real backstop; this is just the friendly early exit.
 */
export async function ensureAiAskGate(): Promise<boolean> {
  const ok = await useAiStore.getState().refreshTranslateGate();
  if (!ok) emitNotice(t("editor.ai_disabled_hint"));
  return ok;
}
