/**
 * 좌표 → 사람이 부르는 지역 이름. 날씨가 "노트북 기본 위치 근처" 같은 **출처 설명** 대신 실제
 * 지명을 보여주기 위한 것이다(오너 지적 1).
 *
 * 방식: 이미 있는 `geocode_reverse`(Rust/Nominatim, zoom=10 = 도시 단위) 재사용. 이름을 새 설정
 * 키로 저장하는 길도 있었지만 그러면 settings_schema.rs::validate_setting 에 arm 을 더해야 하고
 * (안 하면 저장이 조용히 실패한다), 무엇보다 **이미 저장된 좌표에는 이름이 없어서** 기존 사용자는
 * 위치를 다시 고르기 전까지 계속 옛 문구를 본다. 역지오코딩은 지금 있는 좌표에 바로 붙는다.
 *
 * 폴백: 이름을 못 얻으면(오프라인/실패/바다 한가운데) null 을 돌려주고, 호출자가 기존 출처 문구를
 * 그대로 쓴다 — 좌표를 노출하지도, 빈칸을 남기지도 않는다.
 *
 * 캐시는 모듈 전역 Map(좌표 소수 2자리 ≈ 1km + 언어). 날씨 캐시와 같은 이유로 컴포넌트 밖에 둔다 —
 * 헤더와 공간 위젯이 같은 좌표를 동시에 물어도 왕복은 한 번이다.
 */
import { useEffect, useState } from "react";
import { call } from "../../lib/invoke";
import { useSettingsStore } from "../../stores/settings";
import type { LatLng } from "../../lib/weather";

const cache = new Map<string, string>();

function cacheKey(loc: LatLng, lang: string): string {
  return `${loc.lat.toFixed(2)},${loc.lng.toFixed(2)}:${lang}`;
}

export function usePlaceName(loc: LatLng | null | undefined): string | null {
  const uiLang = useSettingsStore((s) => s.uiLang);
  const lang = uiLang || "ko";
  const key = loc ? cacheKey(loc, lang) : null;
  const [name, setName] = useState<string | null>(() => (key ? cache.get(key) ?? null : null));

  useEffect(() => {
    if (!loc || !key) {
      setName(null);
      return;
    }
    const hit = cache.get(key);
    if (hit) {
      setName(hit);
      return;
    }
    let cancelled = false;
    void call<{ label: string | null }>("geocode_reverse", { lat: loc.lat, lng: loc.lng, lang })
      .then((res) => {
        const label = res?.label?.trim();
        if (!label) return;
        cache.set(key, label);
        if (!cancelled) setName(label);
      })
      .catch(() => {
        // 오프라인 / Nominatim 실패 — 호출자가 출처 문구로 폴백한다.
      });
    return () => {
      cancelled = true;
    };
  }, [key, lang, loc]);

  return name;
}
