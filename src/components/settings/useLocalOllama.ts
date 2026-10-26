import { useEffect, useState } from "react";
import { callSilent } from "../../lib/invoke";
import { isLoopbackEndpoint } from "../../lib/aiLoopback";

/**
 * "AI 가 loopback(로컬) Ollama로 설정돼 있는가" — CollectSection(자연어 소스 등록)과
 * PetPersonaSection(펫 채팅)이 각자 settings_get_all 을 불러 똑같이 계산하던 predicate.
 * ai_enabled(클라우드 AI 토글)가 꺼져 있어도 로컬 Ollama면 AI 의존 기능을 켜도 되는 게이트.
 */
export function useLocalOllama(): boolean {
  const [localOllama, setLocalOllama] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // 선택적 조회 — 실패하면 "로컬 아님"으로 두고 토스트는 띄우지 않는다(callSilent 가 진단에 남긴다).
    void callSilent<{ settings: Record<string, unknown> }>("settings_get_all")
      .then((r) => {
        if (cancelled) return;
        if (!r.settings || (r.settings.ai_provider == null && r.settings.ai_endpoint == null)) {
          setLocalOllama(false);
          return;
        }
        const provider = String(r.settings.ai_provider ?? "ollama").toLowerCase();
        const endpoint = String(r.settings.ai_endpoint ?? "");
        setLocalOllama(provider === "ollama" && (endpoint === "" || isLoopbackEndpoint(endpoint)));
      })
      .catch(() => {
        if (!cancelled) setLocalOllama(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return localOllama;
}
