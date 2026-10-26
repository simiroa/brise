import { t } from "../../../i18n/t";
import type { CollectSource } from "../../../lib/commands.gen";
import { isYoutubeChannelFeedUrl } from "../../../lib/urlKind";

// 수집 소스 표·폼이 함께 쓰는 순수 라벨 도우미. React·스토어·IPC 를 모른다 — 입력(소스 행 하나,
// 분 단위 숫자)에서 문자열만 뽑는다.

const KIND_LABEL_KEY: Record<string, string> = {
  rss: "settings.collect_kind_rss",
  web: "settings.collect_kind_web",
  youtube: "settings.collect_kind_youtube",
  claude_prompts: "settings.collect_kind_claude_prompts",
  codex_prompts: "settings.collect_kind_codex_prompts",
  browser_history: "settings.collect_kind_browser_history",
};

/** 저장된 소스는 kind='rss'로 보이므로(§ saveForm의 youtube_channel 분기), config.url이 채널
 *  구독 피드 형태인지로 "이게 사실 유튜브 채널이다"를 되짚어 뱃지를 구분한다. */
export function sourceKindLabel(s: CollectSource): string {
  if (s.kind === "rss") {
    try {
      const url = (JSON.parse(s.config || "{}") as { url?: string }).url;
      if (isYoutubeChannelFeedUrl(url)) return t("settings.collect_kind_youtube_channel");
    } catch {}
  }
  return KIND_LABEL_KEY[s.kind] ? t(KIND_LABEL_KEY[s.kind]) : s.kind;
}

/** "주소" 축(W5, docs/PLAN-2026-09-01 §W5) — kind별 config 모양이 달라 하나로 판독한다. url이
 *  있으면 그게 주소, claude/codex prompts처럼 project 필터만 있으면 그 값, 아무 필터도 없으면
 *  (전체 대상) 빈 자리 표시자만 보여준다. 새 데이터를 만들지 않는다 — 전부 기존 config JSON. */
export function sourceAddressLabel(s: CollectSource): string {
  try {
    const cfg = JSON.parse(s.config || "{}") as {
      url?: string;
      project?: string;
      dir?: string;
      browser?: string;
      profile?: string;
    };
    if (cfg.url) return cfg.url;
    if (cfg.project) return cfg.project;
    if (cfg.dir) return cfg.dir;
    if (cfg.browser) return `${cfg.browser} · ${cfg.profile || "Default"}`;
  } catch {}
  return "—";
}

/** "주기" 축 — 폼의 Select 이산값(intervalOptions)에 매치되면 그 라벨(로컬라이즈됨)을 쓴다.
 *  ponytail: 폼이 이 목록 밖의 값을 저장할 길이 없으므로(§CollectSection saveForm), raw 분
 *  fallback은 이 UI 이전에 만들어진 레거시 데이터 전용 경로다 — 새 키를 만들지 않는다. */
export function sourceIntervalLabel(minutes: number | null, options: { value: string; label: string }[]): string {
  const raw = minutes ?? 60;
  return options.find((o) => Number(o.value) === raw)?.label ?? `${raw}m`;
}

/** 수집 주기 Select 의 이산 선택지(폼)이자 표 "주기" 축 라벨의 조회 대상. 호출 시점의 언어로 만든다.
 *
 *  ON_OPEN_SENTINEL(0, repo/collect.rs) — "창을 열 때"만 특수값이고 나머지는 실제 분(minute).
 *  15분/30분/2시간처럼 지나치게 촘촘한 선택지는 뺐다: 60초 tick 러너 자체가 그보다 촘촘한
 *  정밀도를 보장 못하고(MIN_INTERVAL_MINUTES=15), 실사용에서 피드를 1시간보다 자주 새로고침할
 *  이유가 드물다. */
export function collectIntervalOptions(): { value: string; label: string }[] {
  return [
    { value: "0", label: t("settings.collect_interval_on_open") },
    { value: "60", label: t("settings.collect_interval_1h") },
    { value: "180", label: t("settings.collect_interval_3h") },
    { value: "360", label: t("settings.collect_interval_6h") },
    { value: "720", label: t("settings.collect_interval_12h") },
    { value: "1440", label: t("settings.collect_interval_24h") },
    { value: "4320", label: t("settings.collect_interval_3d") },
    { value: "10080", label: t("settings.collect_interval_1w") },
  ];
}
