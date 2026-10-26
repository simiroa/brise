import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useSettingsStore } from "../../stores/settings";
import { useAiStore } from "../../stores/ai";
import { call, callSilent } from "../../lib/invoke";
import { switchAiProvider } from "../../lib/aiProviderSwitch";
import type { AiTestConnectionOutput } from "../../lib/commands.gen";
import { t } from "../../i18n/t";
import { openExternalUrl } from "../../lib/urls";
import { Select } from "../Select";
import { SegGroup } from "../settings/SegGroup";
import { PROVIDERS } from "../settings/shared";
import { PROVIDER_POLICY_URL } from "../settings/AiProviderSection";
import { IconCheckMark } from "../icons";

// Key-issuance links per cloud provider — onboarding-only convenience, not duplicated from
// AiProviderSection.tsx (which has no such map; it only holds a *policy* link per provider).
const KEY_ISSUANCE_URL: Record<string, string> = {
  OpenAI: "https://platform.openai.com/api-keys",
  Claude: "https://console.anthropic.com/settings/keys",
  Gemini: "https://aistudio.google.com/app/apikey",
  MiniMax: "https://www.minimax.io/platform/user-center/basic-information/interface-key",
  OpenRouter: "https://openrouter.ai/keys",
};

const CLOUD_PROVIDER_OPTIONS = PROVIDERS.filter((p) => p !== "Ollama").map((p) => ({ value: p, label: p }));


const linkStyle: CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  color: "var(--accent)",
  fontSize: "var(--text-sm)",
  textDecoration: "underline",
  textUnderlineOffset: 2,
  cursor: "pointer",
};

type Choice = "cloud" | "local";
type TestStatus = "idle" | "testing" | "success" | "error";

/**
 * 온보딩 3/4 — AI 연결 (docs/PLAN-2026-09-28-onboarding-rebuild.md §2).
 * 셸이 헤더/이전/다음 을 갖고, 이 컴포넌트는 본문 전체(선택·제공자·테스트·채택·건너뛰기)를 그린다.
 * 핵심 계약: 키 입력은 아무것도 저장하지 않는다. "연결 테스트"를 눌러야 설정이 적용되고 검사되며,
 * 성공 뒤 "이 연결 사용하기"를 명시적으로 눌러야만 AI가 켜진다. 실패해도 건너뛰기는 항상 가능하다.
 */
/**
 * onAdoptReady: 테스트가 성공해 켤 수 있게 되면 "켜기" 함수를, 아니면 null 을 올린다 — 셸의 하단 주 버튼이
 * "이 연결로 켜고 다음"으로 바뀌어 그걸 부른다(오너 2026-09-29: 테스트만 하고 "다음"을 누르면 AI 가
 * 꺼진 채 넘어가던 함정). 켜기는 여전히 사용자가 누르는 명시적 행동이다(§2 3/4).
 */
export function OnboardingAiStep(props: {
  onAdopted: (info: { provider: string; model: string | null }) => void;
  onAdoptReady?: (adopt: (() => Promise<boolean>) | null) => void;
}) {
  const [choice, setChoice] = useState<Choice>("cloud");
  const [provider, setProvider] = useState<string>("Gemini");
  const [apiKey, setApiKey] = useState("");
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [adopted, setAdopted] = useState(false);
  // 재실행(설정에서 다시 열기) 때 "이미 연결되어 있다"를 한 번만 잡아 고정 — 이후 사용자가 선택을
  // 바꿔도 이 배너는 "저장된 상태"를 계속 가리킨다(선택 변경과 뒤섞여 거짓을 말하지 않도록).
  const [alreadyConnected, setAlreadyConnected] = useState<string | null>(null);
  const [modelCount, setModelCount] = useState(0);
  // 로컬(Ollama) 테스트 성공 시 목록·선택. 저장된 ai_model 은 프리필 기본값으로만 쓰고 진짜
  // 선택은 사용자가 드롭다운으로 바꿀 수 있다(§ TASK).
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const savedModelRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    // 조용한 조회 — 값이 없거나 실패해도 기본값(클라우드/Gemini/빈 상태)으로 그냥 둔다.
    void callSilent<{ settings: Record<string, unknown> }>("settings_get_all")
      .then((r) => {
        if (!mountedRef.current) return;
        const stored = ((r.settings.ai_provider as string) || "").toLowerCase();
        if (stored === "ollama") {
          setChoice("local");
        } else {
          const match = PROVIDERS.find((p) => p.toLowerCase() === stored);
          if (match) {
            setChoice("cloud");
            setProvider(match);
          }
        }
        // 저장값은 "0"/"1" 문자열일 수 있다 — truthy 판정 대신 스토어의 파싱된 값을 쓴다.
        if (useSettingsStore.getState().aiEnabled) {
          setAlreadyConnected(stored === "ollama" ? "Ollama" : (r.settings.ai_provider as string) || "");
        }
        savedModelRef.current = (r.settings.ai_model as string) || null;
      })
      // silent-ok: callSilent() already logs; a failed boot-time prefill just leaves the form's defaults.
      .catch(() => {});
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const changeChoice = (next: Choice) => {
    setChoice(next);
    setTestStatus("idle");
    setTestError(null);
    setModels([]);
    setSelectedModel("");
  };

  const handleTest = async () => {
    setTestStatus("testing");
    setTestError(null);
    const providerId = choice === "local" ? "ollama" : provider.toLowerCase();
    const key = apiKey.trim();
    try {
      // 프로바이더 전환은 lib/aiProviderSwitch 한 곳을 지난다 — 이전 프로바이더의 키·엔드포인트는
      // 보관함에 들어가고, 새 쪽 엔드포인트는 그 프로바이더의 보관값(없으면 기본)으로 바뀐다. 클라우드면
      // 방금 친 키를 같은 배치에 쓴다. 로컬이면 Ollama 의 보관값을 되살린다.
      await switchAiProvider(providerId, choice === "local" ? {} : { next: key ? { apiKey: key } : {} });
      // ai_test_connection 은 ai_enabled 가 꺼져 있으면 클라우드를 거부한다 — 켜기 전 확인은
      // 데스크톱 전용 before_enable 커맨드로(specs/commands/ai.yaml).
      const res = await call<AiTestConnectionOutput>("ai_test_connection_before_enable", {
        provider: providerId,
        api_key: choice === "local" ? undefined : key,
      });
      if (!res.ok) throw new Error("connection_failed");
      if (!mountedRef.current) return;
      const modelList = Array.isArray(res.models) ? res.models : [];
      setModelCount(modelList.length);
      if (choice === "local") {
        setModels(modelList);
        const saved = savedModelRef.current;
        setSelectedModel(saved && modelList.includes(saved) ? saved : (modelList[0] ?? ""));
      }
      setTestStatus("success");
    } catch (e) {
      if (!mountedRef.current) return;
      const msg = e instanceof Error ? e.message : "";
      setTestStatus("error");
      setTestError(!msg || msg === "connection_failed" ? t("settings.connection_failed") : msg);
    }
  };

  const handleAdopt = async (): Promise<boolean> => {
    try {
      // ai_model 은 AI 를 켜기 전에 먼저 저장한다 — 실패하면 AI 도 켜지 않는다(같은 try).
      if (choice === "local") {
        await call("settings_set", { entries: { ai_model: selectedModel } });
      }
      await useSettingsStore.getState().setAiEnabled(true);
    } catch {
      // setAiEnabled/settings_set 의 call() 이 이미 토스트했다 — 켜지지 않았으니 채택도 없다.
      return false;
    }
    await useAiStore.getState().ensureAiReachable();
    setAdopted(true);
    props.onAdopted({ provider: choice === "local" ? "Ollama" : provider, model: choice === "local" ? selectedModel : null });
    return true;
  };

  const canTest = testStatus !== "testing" && (choice === "local" || apiKey.trim() !== "");
  const canAdopt = !adopted && testStatus === "success" && (choice === "cloud" || modelCount > 0);

  // 최신 handleAdopt(선택·모델이 바뀔 수 있다)를 ref 로 들고, 셸에는 켤 수 있는 동안만 안정된 함수를 올린다.
  const adoptRef = useRef(handleAdopt);
  adoptRef.current = handleAdopt;
  const onAdoptReadyRef = useRef(props.onAdoptReady);
  onAdoptReadyRef.current = props.onAdoptReady;
  useEffect(() => {
    onAdoptReadyRef.current?.(canAdopt ? () => adoptRef.current() : null);
  }, [canAdopt]);
  useEffect(() => () => onAdoptReadyRef.current?.(null), []);

  // 상태 상자(연결 확인 결과 + 테스트/다시 확인 버튼)는 한 줄 — 성공하면 초록 틴트, 실패하면 빨강 틴트.
  // 버튼은 이 상자 안 한 곳에만 있다(테스트·다시 확인이 같은 요소).
  const statusTone = testStatus === "success" ? "ok" : testStatus === "error" ? "danger" : undefined;
  return (
    <div className="ob-page">
      <div>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <h2 className="ob-title">{t("onboarding.aistep_heading")}</h2>
          {alreadyConnected && (
            <span style={{ fontSize: "var(--text-sm)", color: "var(--ok)" }}>
              {t("onboarding.aistep_already_connected", { provider: alreadyConnected })}
            </span>
          )}
        </div>
        <p className="ob-sub">{t("onboarding.aistep_desc")}</p>
      </div>

      <div className="ob-seg">
        <SegGroup<Choice>
          value={choice}
          onChange={changeChoice}
          ariaLabel={t("onboarding.aistep_heading")}
          options={[
            { value: "cloud", label: t("onboarding.aistep_choice_cloud") },
            { value: "local", label: t("onboarding.aistep_choice_local") },
          ]}
        />
      </div>

      {choice === "cloud" ? (
        <div className="ob-ai-row">
          <div className="ob-group">
            <label className="ob-label">{t("settings.ai_provider")}</label>
            <Select
              value={provider}
              onChange={(v) => {
                setProvider(v);
                setTestStatus("idle");
                setTestError(null);
              }}
              ariaLabel={t("settings.ai_provider")}
              options={CLOUD_PROVIDER_OPTIONS}
            />
          </div>

          <div className="ob-group">
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--space-2)" }}>
              <label className="ob-label">{t("settings.api_key_label")}</label>
              <button type="button" style={{ ...linkStyle, fontSize: "var(--text-xs)" }} onClick={() => void openExternalUrl(KEY_ISSUANCE_URL[provider] ?? KEY_ISSUANCE_URL.Gemini)}>
                {t("onboarding.aistep_key_issuance_link")}
              </button>
            </div>
            <input
              className="field"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t("onboarding.aistep_api_key_placeholder")}
              aria-label={t("settings.api_key_label")}
              data-testid="onboarding-ai-key-input"
            />
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <span className="ob-hint">
            {t("settings.provider_local_notice")} · {t("settings.ai_ollama_gpu_notice")}
          </span>
          <button type="button" style={{ ...linkStyle, flex: "none" }} onClick={() => void openExternalUrl("https://ollama.com")}>
            {t("onboarding.aistep_install_link")}
          </button>
        </div>
      )}

      <div className="ob-status" data-tone={statusTone}>
        <span className="ob-status-text">
          {testStatus === "idle" && t("onboarding.aistep_test_idle")}
          {testStatus === "testing" && t("settings.connection_checking")}
          {testStatus === "success" && (
            <>
              <IconCheckMark size={16} />
              <span>
                {t("onboarding.aistep_test_success")}
                {choice === "cloud" ? ` · ${provider}` : ""}
                {choice === "local" && modelCount > 0 && ` · ${t("settings.models_count", { n: modelCount })}`}
              </span>
            </>
          )}
          {testStatus === "error" && t("settings.error_prefix", { msg: testError ?? "" })}
        </span>
        <button type="button" className="btn ob-btn-inline" onClick={() => void handleTest()} disabled={!canTest} data-testid="onboarding-ai-test-button">
          {testStatus === "testing"
            ? t("settings.connection_checking")
            : testStatus === "success"
              ? t("onboarding.aistep_recheck_btn")
              : t("settings.test_connection")}
        </button>
      </div>

      {choice === "cloud" && (
        <p className="ob-hint">
          {t("onboarding.aistep_cloud_notice")}{" "}
          {/* 연결 버튼 근처에 제공자 약관 — 설정 > AI 와 같은 URL 표(PROVIDER_POLICY_URL). */}
          {PROVIDER_POLICY_URL[provider] && (
            <button
              type="button"
              style={linkStyle}
              onClick={() => void openExternalUrl(PROVIDER_POLICY_URL[provider])}
              data-testid="onboarding-ai-policy-link"
            >
              {t("settings.provider_policy_link", { provider })}
            </button>
          )}
        </p>
      )}

      {testStatus === "success" && choice === "local" && modelCount === 0 && (
        <p className="ob-hint">{t("onboarding.aistep_no_models_hint")}</p>
      )}

      {testStatus === "success" && choice === "local" && modelCount > 0 && (
        <div className="ob-group">
          <label className="ob-label">{t("onboarding.aistep_model_label")}</label>
          <Select
            value={selectedModel}
            onChange={setSelectedModel}
            ariaLabel={t("onboarding.aistep_model_label")}
            options={models.map((m) => ({ value: m, label: m }))}
            testid="onboarding-ai-model-select"
          />
        </div>
      )}
    </div>
  );
}
