import { useCallback, useEffect, useRef, useState } from "react";
import { callSilent } from "../../lib/invoke";
import { reportFallback } from "../../lib/diag";
import { PROVIDERS } from "./shared";

/**
 * 설정 > AI 페이지들이 읽는 연결 값(프로바이더·엔드포인트·키·모델·폴백 모델) — 한 경로로 읽는다.
 *
 * 설정 창은 별도 웹뷰라 메인 창에서 바뀐 값을 모른다 — 창이 포커스를 얻을 때마다 조용히 다시 읽는다
 * (선택적 조회라 callSilent: 실패해도 토스트 없이 진단 로그만 남고 지금 값이 남는다). 사용자가
 * 고치는 중인 칸(edit 으로 바꾸고 아직 commit 하지 않은 칸)은 다시 읽기가 덮지 않는다.
 */
export interface AiConnectionFields {
  /** PROVIDERS 의 표기(예: "Gemini"). 모르는 저장값은 소문자 원문 그대로 — 외부로 취급된다. */
  provider: string;
  endpoint: string;
  apiKey: string;
  model: string;
  modelFallback: string;
}

const INITIAL: AiConnectionFields = { provider: "Ollama", endpoint: "", apiKey: "", model: "", modelFallback: "" };

/** 저장된 ai_provider → 화면 표기. 모르는 값은 Ollama 로 둔갑시키지 않는다(로컬로 보이면 외부 전송
 *  요약이 거짓말을 한다) — 원문을 돌려주고 기록을 남긴다. */
export function canonicalProvider(stored: unknown): string {
  const raw = (typeof stored === "string" && stored.trim() ? stored : "ollama").trim().toLowerCase();
  const known = PROVIDERS.find((n) => n.toLowerCase() === raw);
  if (known) return known;
  reportFallback("ai", "unknown_provider", raw.slice(0, 40));
  return raw;
}

function fromSettings(s: Record<string, unknown>): AiConnectionFields {
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    provider: canonicalProvider(s.ai_provider),
    endpoint: text(s.ai_endpoint),
    apiKey: text(s.ai_api_key),
    model: text(s.ai_model),
    modelFallback: text(s.ai_model_fallback),
  };
}

export function useAiConnectionSettings() {
  const [fields, setFields] = useState<AiConnectionFields>(INITIAL);
  const [loaded, setLoaded] = useState(false);
  const dirty = useRef(new Set<keyof AiConnectionFields>());
  // 마지막으로 DB 에 있다고 아는 값 — blur 때 "안 바뀌었으면 저장 생략"과 실패 롤백의 기준.
  const saved = useRef<AiConnectionFields>(INITIAL);
  const mounted = useRef(true);

  const reload = useCallback(() => {
    void callSilent<{ settings: Record<string, unknown> }>("settings_get_all")
      .then((r) => {
        if (!mounted.current || !r?.settings) return;
        const next = fromSettings(r.settings);
        saved.current = next;
        setFields((prev) => {
          const merged = { ...next };
          for (const k of dirty.current) (merged as Record<string, string>)[k] = prev[k];
          return merged;
        });
        setLoaded(true);
      })
      // silent-ok: callSilent 이 이미 진단에 남겼다 — 다시 읽기 실패는 지금 보이는 값을 그대로 둔다.
      .catch(() => {});
  }, []);

  useEffect(() => {
    mounted.current = true;
    reload();
    window.addEventListener("focus", reload);
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", reload);
    };
  }, [reload]);

  /** 입력 중 — 다시 읽기가 이 칸을 덮지 않게 표시하고 화면 값만 바꾼다. */
  const edit = useCallback(<K extends keyof AiConnectionFields>(key: K, value: AiConnectionFields[K]) => {
    dirty.current.add(key);
    setFields((f) => ({ ...f, [key]: value }));
  }, []);

  /** 저장이 끝난 값 — 표시를 풀고 화면·기준값 둘 다 반영한다. */
  const commitSaved = useCallback((patch: Partial<AiConnectionFields>) => {
    for (const k of Object.keys(patch) as (keyof AiConnectionFields)[]) dirty.current.delete(k);
    saved.current = { ...saved.current, ...patch };
    setFields((f) => ({ ...f, ...patch }));
  }, []);

  /** 저장 실패 — 그 칸들을 마지막 저장값으로 되돌린다. */
  const revert = useCallback((keys: (keyof AiConnectionFields)[]) => {
    const back: Partial<AiConnectionFields> = {};
    for (const k of keys) {
      dirty.current.delete(k);
      back[k] = saved.current[k];
    }
    setFields((f) => ({ ...f, ...back }));
  }, []);

  const savedValue = useCallback((key: keyof AiConnectionFields) => saved.current[key], []);

  return { fields, loaded, edit, commitSaved, revert, savedValue, reload };
}
