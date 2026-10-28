import { anchorId } from "./settingsAnchor";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useSettingsStore } from "../../stores/settings";
import { useAiStore } from "../../stores/ai";
import { call } from "../../lib/invoke";
import { reportFallback } from "../../lib/diag";
import { useFeatureBriefTrigger } from "../../lib/useFeatureBrief";
import { switchAiProvider } from "../../lib/aiProviderSwitch";
import { t } from "../../i18n/t";
import { Select } from "../Select";
import { Badge } from "./Badge";
import { SettingsRow } from "./SettingsRow";
import { SubGroup } from "./SubGroup";
import { SegGroup } from "./SegGroup";
import { MetricTileGroup, type MetricTileItem } from "./MetricTileGroup";
import { linkBtn, PROVIDERS, SETTINGS_CTRL_WIDTH } from "./shared";
import { Toggle } from "./Toggle";
import { canonicalProvider, useAiConnectionSettings, type AiConnectionFields } from "./useAiConnectionSettings";
import { IconActivity, IconExternalLink, IconLayoutGrid, IconSparkles } from "../icons";
import { IconAction } from "./IconAction";
import { SettingsCard } from "./SettingsCard";

// Convenience presets shown via <datalist> for cloud providers — the field stays a free-text
// input (backend just forwards whatever string is set as `ai_model`), these are just common
// picks so the user isn't stuck guessing a model id from scratch.
const MODEL_PRESETS: Record<string, string[]> = {
  OpenAI: ["gpt-4o", "gpt-4o-mini", "gpt-4.1-mini"],
  Claude: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
  // gemini-2.5-*/2.0-*/1.5-* are legacy/deprecated — 3.x only (gemini-interactions-api skill).
  Gemini: ["gemini-3.1-flash-lite", "gemini-3.6-flash", "gemini-3.1-pro-preview"],
  MiniMax: ["MiniMax-Text-01", "MiniMax-M2"],
  // OpenRouter 는 모델 id 에 공급자 네임스페이스가 붙는다 — 맨 이름(`gpt-4o-mini`)은 404 다.
  OpenRouter: ["openai/gpt-4o-mini", "anthropic/claude-sonnet-5", "google/gemini-3.7-flash"],
};

// Placeholder shown when the endpoint field is empty — mirrors backend's
// Provider::default_endpoint() (src-tauri/src/repo/ai.rs) so leaving it blank is safe and the
// hint text is never another provider's URL (was previously a Claude/Gemini → OpenAI mixup).
const ENDPOINT_PLACEHOLDERS: Record<string, string> = {
  Ollama: "http://localhost:11434",
  OpenAI: "https://api.openai.com/v1",
  Claude: "https://api.anthropic.com/v1",
  Gemini: "https://generativelanguage.googleapis.com/v1beta",
  MiniMax: "https://api.minimax.io/anthropic/v1",
  OpenRouter: "https://openrouter.ai/api/v1",
};

export const PROVIDER_POLICY_URL: Record<string, string> = {
  OpenAI: "https://openai.com/policies/row-terms-of-use/",
  Claude: "https://www.anthropic.com/legal/consumer-terms",
  Gemini: "https://ai.google.dev/gemini-api/terms",
  MiniMax: "https://www.minimax.io/platform/protocol/terms-of-service",
  OpenRouter: "https://openrouter.ai/terms",
};

const PROVIDER_OPTIONS = PROVIDERS.map((name) => ({ value: name, label: name }));

/** 행 우측 텍스트 입력 — SettingsRow 의 control 자리에 들어가는 표준 폭. */
const fieldStyle: CSSProperties = { width: SETTINGS_CTRL_WIDTH, textAlign: "left" };

type TestResult =
  | { latencyMs?: number; models?: string[] }
  | { error: string }
  // IPC 자체가 실패했다 — call() 이 이미 토스트로 말했으므로 인라인에는 다시 쓰지 않는다.
  | { toasted: true };

/**
 * 설정 > AI > 연결 (PLAN-2026-09-15 §4 W3).
 * 마스터 스위치 카드(첫 줄) → 통계 타일(값이 있는 것만) → 카드 1장: SubGroup 3(인증 / 모델 / 진단).
 * **AI 마스터 스위치(`ai_enabled`)의 유일한 거처다**(PLAN-2026-10-24 D7) — 일반 페이지의 토글과 각 AI 페이지의
 * 켜기 배너는 없어졌고, 다른 AI 페이지는 꺼져 있을 때 여기로 오는 링크 한 줄(AiOffLink)만 둔다. 마스터 카드는
 * 꺼짐일 때 접히는 본문 **밖**이라 늘 보인다. 켜면 `ensureAiReachable` 이 뒤따르고 `ai_master` 기능 브리핑이
 * (OFF→ON 전환 1회만) 뜬다.
 *
 * 프로바이더·엔드포인트·키·모델은 이 페이지가 직접 읽고(useAiConnectionSettings) 쓴다. 프로바이더 전환은
 * lib/aiProviderSwitch 를 지나 키를 프로바이더별로 보관·복원한다(키가 다른 프로바이더로 새지 않는다).
 */
export function AiProviderSection() {
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const linkSuggestions = useSettingsStore((s) => s.linkSuggestions);
  const linkSuggestionsModel = useSettingsStore((s) => s.linkSuggestionsModel);
  const setLinkSuggestionsModel = useSettingsStore((s) => s.setLinkSuggestionsModel);

  const testConnection = useAiStore((s) => s.testConnection);
  const availableModels = useAiStore((s) => s.availableModels);
  const ensureAiReachable = useAiStore((s) => s.ensureAiReachable);
  const setAiEnabled = useSettingsStore((s) => s.setAiEnabled);
  const notifyFeatureBrief = useFeatureBriefTrigger();
  const aiReachable = useAiStore((s) => s.aiReachable);
  const aiReachableError = useAiStore((s) => s.aiReachableError);
  const aiReachableChecking = useAiStore((s) => s.aiReachableChecking);

  const { fields, loaded, edit, commitSaved, revert, savedValue } = useAiConnectionSettings();
  const { provider, endpoint, apiKey, model, modelFallback } = fields;

  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [linkModel, setLinkModel] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [switching, setSwitching] = useState(false);
  // 취소는 백엔드 리스너를 죽이지 못한다 — 브라우저는 이미 열렸고, 리스너는 자기 타임아웃으로
  // 알아서 접힌다. 그래서 세대 카운터를 올려 **뒤늦게 도착한 키를 무시**하는 쪽으로 취소한다.
  // (그냥 setConnecting(false) 만 하면 사용자가 취소한 뒤에 키가 조용히 저장된다.)
  const connectGen = useRef(0);
  // 저장은 줄을 세운다 — 연결 테스트·프로바이더 전환이 막 친 키의 blur 저장을 기다린 뒤 돈다
  // (안 기다리면 옛 키로 테스트하거나, 옛 키를 보관함에 넣는다).
  const pendingSave = useRef<Promise<void>>(Promise.resolve());
  const switchingRef = useRef(false);

  const isGemini = provider.toLowerCase() === "gemini";
  const isOllama = provider.toLowerCase() === "ollama";
  const isOpenRouter = provider.toLowerCase() === "openrouter";
  // 모르는 저장값이면 어느 칸도 켜지 않는다(Ollama 로 둔갑시키지 않는다 — useAiConnectionSettings).
  const providerValue = PROVIDERS.find((p) => p.toLowerCase() === provider.toLowerCase()) ?? provider;

  // 설정 창은 별도 웹뷰라 스토어가 비어 있다 — 열 때 한 번 조용히 확인해 모델 수를 채운다
  // (안 하면 키·모델이 있어도 "사용 가능 모델 0" 으로 보인다). 같은 크리덴셜이면 캐시로 즉시 끝난다.
  useEffect(() => {
    if (aiEnabled) void ensureAiReachable();
  }, [aiEnabled, ensureAiReachable]);

  const handleToggleAi = (next: boolean) => {
    // setAiEnabled → settings_set 은 lib/invoke 의 call 을 쓰므로 실패 시 이미 토스트를 띄운 뒤 재throw 한다.
    // ensureAiReachable 은 성공했을 때만 이어져야 하므로 .then 뒤에 catch 를 붙여 rejection 이 미처리로
    // 새지 않게 삼킨다(함정 ⑧).
    // silent-ok: 실패는 setAiEnabled 안에서 이미 토스트·진단 기록됐다(invoke 의 call 경로).
    void setAiEnabled(next).then(() => ensureAiReachable()).catch(() => {});
    notifyFeatureBrief("ai_master", aiEnabled, next);
  };

  useEffect(() => {
    setLinkModel(linkSuggestionsModel);
  }, [linkSuggestionsModel]);

  /* 한 칸(또는 함께 바뀌는 몇 칸)을 저장하고 도달성을 다시 본다(핑거프린트가 자동으로 무효화된다).
     실패하면 call() 이 토스트를 띄우고, 화면은 마지막 저장값으로 되돌린다.
     인자를 `{ entries: { … } }` 통째로 받는 건 취향이 아니라 게이트 때문이다 —
     scripts/check-settings-keys.mjs 는 파일에서 `entries: { … }` 리터럴을 찾아 백엔드
     validate_setting 허용 목록과 대조한다. 키를 헬퍼 뒤로 감추면 그 대조가 조용히 사라진다. */
  const persistAiField = (
    payload: { entries: Record<string, unknown> },
    committed: Partial<AiConnectionFields>,
  ): Promise<void> => {
    setTestResult(null);
    const run = async () => {
      try {
        await call("settings_set", payload);
        commitSaved(committed);
        void ensureAiReachable();
      } catch {
        revert(Object.keys(committed) as (keyof AiConnectionFields)[]);
      }
    };
    const p = pendingSave.current.then(run);
    pendingSave.current = p;
    return p;
  };

  /** blur 저장 — 앞뒤 공백을 걷어내고, 마지막 저장값과 같으면 IPC 를 쏘지 않는다. */
  const blurSave = (key: "apiKey" | "endpoint" | "model" | "modelFallback", save: (v: string) => void) => {
    const v = fields[key].trim();
    if (v === savedValue(key)) {
      commitSaved({ [key]: v });
      return;
    }
    save(v);
  };

  const saveModel = (v: string) => {
    edit("model", v);
    void persistAiField({ entries: { ai_model: v } }, { model: v });
  };

  const saveLinkModel = async () => {
    await setLinkSuggestionsModel(linkModel.trim());
  };

  const selectProvider = async (name: string) => {
    if (!loaded || switchingRef.current || name.toLowerCase() === provider.toLowerCase()) return;
    switchingRef.current = true;
    setSwitching(true);
    setTestResult(null);
    // 화면에 보이는 키·엔드포인트가 나가는 프로바이더의 값이다(아직 안 끝난 blur 저장 포함).
    const current = { apiKey: apiKey.trim(), endpoint: endpoint.trim() };
    edit("provider", name);
    try {
      await pendingSave.current;
      const plan = await switchAiProvider(name, { current });
      commitSaved({ provider: canonicalProvider(plan.provider), apiKey: plan.apiKey, endpoint: plan.endpoint });
      void ensureAiReachable();
    } catch {
      // call() 이 토스트를 띄웠다 — 프로바이더 선택만 되돌린다(키·엔드포인트는 건드린 적 없다).
      revert(["provider"]);
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  };

  /* OpenRouter 로그인 연결 — 브라우저 OAuth 로 사용자 소유 키를 받아 그대로 저장한다.
     엔드포인트는 비운다 — 비워 두면 백엔드 Provider::OpenRouter::default_endpoint() 가 맡는다. */
  const connectOpenRouter = async () => {
    const gen = ++connectGen.current;
    setConnecting(true);
    setTestResult(null);
    try {
      const res = await call<{ api_key: string }>("ai_openrouter_connect");
      if (gen !== connectGen.current) return; // 사용자가 취소했다 — 늦게 온 키는 버린다
      edit("apiKey", res.api_key);
      edit("endpoint", "");
      await persistAiField({ entries: { ai_api_key: res.api_key, ai_endpoint: "" } }, { apiKey: res.api_key, endpoint: "" });
    } catch {
      // call() 이 이미 토스트를 띄웠다(trap #8) — 여기서는 대기 상태만 푼다.
    } finally {
      if (gen === connectGen.current) setConnecting(false);
    }
  };

  const cancelConnect = () => {
    connectGen.current += 1;
    setConnecting(false);
  };

  const handleTestConnection = async () => {
    setTestResult(null);
    // 방금 친 키의 blur 저장이 끝난 뒤에 테스트한다 — 안 그러면 옛 키로 테스트한다.
    await pendingSave.current;
    try {
      const res = await testConnection();
      setTestResult({ latencyMs: res.latencyMs, models: res.models });
    } catch (e: unknown) {
      // ok:false 만 testConnection 이 직접 던지는 "connection_failed" 다 — 인라인으로 말한다.
      // 그 밖의 실패는 IPC 거부라 call() 이 이미 토스트를 띄웠다(두 번 말하지 않는다).
      const msg = e instanceof Error ? e.message : "";
      setTestResult(msg === "connection_failed" ? { error: t("settings.connection_failed") } : { toasted: true });
    }
  };

  // Auto-probe failure (title-bar hide path) surfaces here so the user can act without a silent hide.
  const autoFailMsg =
    !testResult && aiReachable === false
      ? aiReachableError || t("settings.connection_failed")
      : null;

  const policyUrl = PROVIDER_POLICY_URL[providerValue] || "";
  const handleOpenPolicy = async () => {
    if (!policyUrl) return;
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(policyUrl);
    } catch {
      reportFallback("ai", "policy_open_fallback", providerValue);
      window.open(policyUrl, "_blank");
    }
  };

  const reachBadge = aiReachableChecking ? (
    <Badge tone="neutral">{t("settings.ai_badge_checking")}</Badge>
  ) : aiReachable === true ? (
    <Badge tone="accent">{t("settings.ai_badge_reachable")}</Badge>
  ) : aiReachable === false ? (
    <Badge tone="danger">{t("settings.ai_badge_unreachable")}</Badge>
  ) : (
    <Badge tone="neutral">{t("settings.ai_badge_unknown")}</Badge>
  );

  // 값이 없는 타일은 세우지 않는다 — "—" 타일은 고장처럼 읽힌다. 현재 모델은 늘 값이 있다(기본값 표기).
  const latencyMs = testResult && "latencyMs" in testResult ? testResult.latencyMs : undefined;
  const tiles: MetricTileItem[] = [
    ...(latencyMs != null
      ? [{ id: "latency", icon: <IconActivity size={16} />, value: `${latencyMs} ms`, label: t("settings.ai_tile_latency") }]
      : []),
    ...(availableModels.length > 0
      ? [{ id: "models", icon: <IconLayoutGrid size={16} />, value: availableModels.length, label: t("settings.ai_tile_models") }]
      : []),
    { id: "model", icon: <IconSparkles size={16} />, value: model || t("settings.model_default_hint"), label: t("settings.ai_tile_model") },
  ];

  const inlineError = testResult && "error" in testResult ? testResult.error : null;
  const okResult = testResult && !("error" in testResult) && !("toasted" in testResult) ? testResult : null;

  return (
    <>
      {/* 정보 스트립(통계 타일)이 페이지 맨 위다(2026-10-27 설정 디자인 개편) — 마스터 스위치는 아래 연결 카드의 첫 줄로
          흡수됐다. 꺼진 상태에서도 카드는 늘 보이고 본문(SubGroup)만 접힌다. */}
      {aiEnabled && <MetricTileGroup tiles={tiles} columns={tiles.length} />}

      <SettingsCard
        title={t("settings.ai_provider")}
        badge={!isOllama ? <Badge tone="accent">{t("settings.external_badge")}</Badge> : undefined}
        actions={<span data-testid="ai-reach-badge">{reachBadge}</span>}
        icon={<IconSparkles size={14} strokeWidth={2} />}
        testId="settings-ai-provider-card"
      >

        {/* 마스터 스위치(PLAN-2026-10-24 D7) — 이 카드의 첫 줄. `aiEnabled` 가 거짓이면 아래 본문이 통째로 접히지만 이 줄은 그 밖이라
            꺼진 상태에서도 항상 보인다. */}
        <div data-testid="settings-ai-master-card">
          <SettingsRow
            anchor="ai_master"
            label={t("settings.enable_ai_features")}
            control={
              <Toggle
                checked={aiEnabled}
                onChange={(next) => handleToggleAi(next)}
                aria-label={t("settings.enable_ai_features")}
                data-testid="settings-ai-enabled-toggle"
              />
            }
            data-testid="settings-ai-master"
          />
        </div>

        {aiEnabled && (
          <>
            {/* 인증 — 프로바이더 SegGroup(6칸이라 전폭) + 키 + 엔드포인트. 첫 SubGroup 이라 선 없음. */}
            <SubGroup title={t("settings.ai_group_auth")} data-testid="settings-ai-group-auth">
              <div
                style={{ "--settings-ctrl-w": "100%", marginBottom: "var(--space-3)" } as CSSProperties}
                aria-busy={switching || undefined}
              >
                {/* 읽기 전엔 아무 칸도 고르지 않는다 — 초기값(Ollama)을 고른 채 두면 읽기가 끝난 뒤 표시가
                    Ollama → 저장값(예: Gemini) 으로 미끄러지는 애니메이션이 열 때마다 생겼다(2026-10-28). */}
                <SegGroup
                  value={loaded ? providerValue : ""}
                  onChange={(name) => void selectProvider(name)}
                  options={PROVIDER_OPTIONS}
                  ariaLabel={t("settings.ai_provider")}
                />
              </div>

              {isOpenRouter && (
                <div style={{ marginBottom: "var(--space-3)" }}>
                  {connecting ? (
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
                      <span style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>
                        {t("settings.openrouter_connect_pending")}
                      </span>
                      <button type="button" style={linkBtn} onClick={cancelConnect}>
                        {t("common.cancel")}
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="btn" onClick={() => void connectOpenRouter()}>
                      {t("settings.openrouter_connect")}
                    </button>
                  )}
                  <div style={{ marginTop: "var(--space-2)", fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                    {t("settings.openrouter_connect_hint")}
                  </div>
                </div>
              )}

              {!isOllama && (
                <SettingsRow
                  label={t("settings.api_key_label")}
                  control={
                    <input
                      value={apiKey}
                      type="password"
                      onChange={(e) => edit("apiKey", e.target.value)}
                      onBlur={() =>
                        blurSave("apiKey", (v) => {
                          edit("apiKey", v);
                          void persistAiField({ entries: { ai_api_key: v } }, { apiKey: v });
                        })
                      }
                      placeholder={isGemini ? "AIzaSy..." : "sk-..."}
                      aria-label={t("settings.api_key_label")}
                      className="field"
                      style={fieldStyle}
                    />
                  }
                />
              )}

              <SettingsRow
                anchor="ai_endpoint"
                label={t("settings.endpoint_label")}
                control={
                  <input
                    value={endpoint}
                    onChange={(e) => edit("endpoint", e.target.value)}
                    onBlur={() =>
                      blurSave("endpoint", (v) => {
                        edit("endpoint", v);
                        void persistAiField({ entries: { ai_endpoint: v } }, { endpoint: v });
                      })
                    }
                    placeholder={ENDPOINT_PLACEHOLDERS[providerValue] ?? "https://api.openai.com/v1"}
                    aria-label={t("settings.endpoint_label")}
                    className="field"
                    style={fieldStyle}
                  />
                }
              />
            </SubGroup>

            {/* 모델 — 모델 · 폴백 · 링크 제안 모델 */}
            <SubGroup title={t("settings.ai_group_models")} divider data-testid="settings-ai-group-models">
              <SettingsRow
                anchor="ai_model"
                label={t("settings.model_label")}
                control={
                  isOllama ? (
                    availableModels.length > 0 ? (
                      <Select
                        value={model}
                        onChange={saveModel}
                        ariaLabel={t("settings.model_label")}
                        options={[
                          { value: "", label: t("settings.model_default_hint") },
                          ...availableModels.map((m) => ({ value: m, label: m })),
                        ]}
                      />
                    ) : (
                      <input
                        value={model}
                        onChange={(e) => edit("model", e.target.value)}
                        onBlur={() => blurSave("model", saveModel)}
                        placeholder={t("settings.model_placeholder_ollama")}
                        aria-label={t("settings.model_label")}
                        className="field"
                        style={fieldStyle}
                      />
                    )
                  ) : (
                    <>
                      <input
                        list="ai-model-presets"
                        value={model}
                        onChange={(e) => edit("model", e.target.value)}
                        onBlur={() => blurSave("model", saveModel)}
                        placeholder={t("settings.model_placeholder_cloud")}
                        aria-label={t("settings.model_label")}
                        className="field"
                        style={fieldStyle}
                      />
                      <datalist id="ai-model-presets">
                        {(MODEL_PRESETS[providerValue] ?? []).map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                    </>
                  )
                }
              />

              <SettingsRow
                anchor="ai_model_fallback"
                label={t("settings.model_fallback_label")}
                control={
                  <input
                    value={modelFallback}
                    onChange={(e) => edit("modelFallback", e.target.value)}
                    onBlur={() =>
                      blurSave("modelFallback", (v) => {
                        edit("modelFallback", v);
                        void persistAiField({ entries: { ai_model_fallback: v } }, { modelFallback: v });
                      })
                    }
                    placeholder="gemma-4-31b"
                    aria-label={t("settings.model_fallback_label")}
                    className="field"
                    style={fieldStyle}
                  />
                }
              />

              <SettingsRow
                anchor="ai_link_suggest_model"
                label={t("settings.collect_link_suggest_model")}
                hint={t("settings.collect_link_suggest_model_hint")}
                disabled={!(aiEnabled && linkSuggestions)}
                disabledReason={t("settings.link_suggest_disabled_reason")}
                control={
                  <input
                    value={linkModel}
                    onChange={(e) => setLinkModel(e.target.value)}
                    onBlur={() => void saveLinkModel()}
                    type="text"
                    className="field"
                    aria-label={t("settings.collect_link_suggest_model")}
                    data-testid="settings-link-suggestions-model"
                    placeholder={t("settings.ai_model_placeholder")}
                    disabled={!(aiEnabled && linkSuggestions)}
                    style={fieldStyle}
                  />
                }
              />
            </SubGroup>

            {/* 진단 — 연결 테스트 + 정책 링크 / 로컬 안내 */}
            <SubGroup title={t("settings.ai_group_diag")} divider data-testid="settings-ai-group-diag">
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
                <IconAction
                  icon={<IconActivity size={16} />}
                  label={t("settings.test_connection")}
                  titleOverride={aiReachableChecking ? t("settings.connection_checking") : undefined}
                  busy={aiReachableChecking}
                  id={anchorId("ai_test_connection")}
                  data-testid="settings-ai-test-connection"
                  onClick={() => void handleTestConnection()}
                  disabled={aiReachableChecking || switching}
                />
                {inlineError && (
                  <div style={{ fontSize: "var(--text-sm)", color: "var(--danger)" }} data-testid="settings-ai-test-error">
                    <span>{t("settings.error_prefix", { msg: inlineError })}</span>
                  </div>
                )}
                {okResult && (
                  <div style={{ fontSize: "var(--text-sm)", color: "var(--ok)" }}>
                    <span>
                      {t("settings.test_ok", { ms: okResult.latencyMs ?? 0 })}
                      {okResult.models && okResult.models.length > 0 && ` · ${t("settings.models_count", { n: okResult.models.length })}`}
                    </span>
                  </div>
                )}
                {autoFailMsg && (
                  <div style={{ fontSize: "var(--text-sm)", color: "var(--danger)" }}>
                    <span>{t("settings.error_prefix", { msg: autoFailMsg })}</span>
                  </div>
                )}
              </div>

              <div style={{ marginTop: "var(--space-4)" }}>
                {isOllama ? (
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                    <div>{t("settings.provider_local_notice")}</div>
                    {/* WF F3: Ollama has no GPU check of its own — a CPU-only box just times out at the
                        45s AI call deadline (transport.rs) instead of erroring clearly. One line, no
                        gating: we don't probe for a GPU here, just set expectations up front. */}
                    <div style={{ marginTop: "var(--space-1)" }}>{t("settings.ai_ollama_gpu_notice")}</div>
                  </div>
                ) : (
                  policyUrl && (
                    <IconAction
                      icon={<IconExternalLink size={16} />}
                      label={t("settings.provider_policy_link", { provider: providerValue })}
                      data-testid="settings-ai-policy-link"
                      onClick={() => void handleOpenPolicy()}
                    />
                  )
                )}
              </div>
            </SubGroup>
          </>
        )}
      </SettingsCard>
    </>
  );
}

