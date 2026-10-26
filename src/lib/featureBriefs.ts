/**
 * 기능 온보딩 브리핑 SSOT (docs/PLAN-2026-08-30-ai-surface-and-clients.md §4 W7).
 *
 * "기능을 처음 켤 때 온보딩/경고 모달" — AI 전용이 아니라 범용이다. 여기 등록된 id 만
 * FeatureBriefModal 이 그릴 수 있다. useFeatureBrief.ts 의 트리거 훅과
 * components/onboarding/FeatureBriefModal.tsx(온보딩 모드·읽기 모드 공용)가 이 배열 하나만 읽는다.
 *
 * i18n 키는 aiCapabilities.ts 와 같은 이유로 전부 **리터럴 문자열**로 쓴다 — check-i18n.mjs 의
 * "미사용 키" 검사는 소스에 리터럴로 등장하는 문자열만 "쓰였다"고 인정한다.
 *
 * ai_post_process/link_suggestions/ai_chat_memory 세 항목은 titleKey/bodyKey 가
 * `aiCapabilities.*` 네임스페이스를 그대로 가리킨다(새 문구를 따로 만들지 않는다) — W2 카탈로그의
 * "자세히 ▸" 가 이 모달을 읽기 모드로 열 때(AiCapabilityCatalog.tsx) 보여주는 문구와 온보딩 모드가
 * 정확히 같은 키를 읽으므로 두 모드가 어긋날 수가 없다(오탈자·오역이 나도 한 곳만 고치면 된다).
 */
export interface FeatureBrief {
  id: string;
  titleKey: string;
  bodyKey: string;
  tone: "welcome" | "caution";
  /** "사용법 자세히보기" 보조 버튼 — 있으면 모달 안에서 이 키를 인라인으로 펼친다(카탈로그의
   *  기존 "자세히 ▸" 펼침과 같은 동작, 외부 링크가 아니다). */
  learnMoreKey?: string;
  /** 브라우저로 여는 외부 링크(opener 플러그인) — 앱 내 웹뷰로 열지 않는다. */
  externalLinks?: { labelKey: string; url: string }[];
}

export const FEATURE_BRIEFS: FeatureBrief[] = [
  {
    id: "ai_master",
    titleKey: "featureBriefs.ai_master_title",
    bodyKey: "featureBriefs.ai_master_body",
    tone: "welcome",
    learnMoreKey: "featureBriefs.ai_master_learn_more",
    externalLinks: [
      { labelKey: "featureBriefs.ai_master_privacy_link", url: "https://ai.google.dev/gemini-api/terms" },
    ],
  },
  {
    id: "ai_post_process",
    // aiCapabilities.ts::AUTO_CAPABILITIES 의 ai_post_process 항목과 같은 키 — 카탈로그
    // "자세히 ▸"와 이 온보딩 모달이 글자 하나까지 같은 문구를 읽는다.
    titleKey: "aiCapabilities.ai_post_process_name",
    bodyKey: "aiCapabilities.ai_post_process_detail",
    tone: "caution",
  },
  {
    id: "link_suggestions",
    titleKey: "aiCapabilities.link_suggestions_name",
    bodyKey: "aiCapabilities.link_suggestions_detail",
    tone: "caution",
  },
  {
    id: "ai_chat_memory",
    titleKey: "aiCapabilities.ai_chat_memory_name",
    bodyKey: "aiCapabilities.ai_chat_memory_detail",
    tone: "caution",
  },
  {
    id: "sync_server",
    titleKey: "featureBriefs.sync_server_title",
    bodyKey: "featureBriefs.sync_server_body",
    tone: "caution",
  },
  {
    id: "capture_channel",
    titleKey: "featureBriefs.capture_channel_title",
    bodyKey: "featureBriefs.capture_channel_body",
    tone: "caution",
  },
];

export function getFeatureBrief(id: string): FeatureBrief | undefined {
  return FEATURE_BRIEFS.find((b) => b.id === id);
}

/** seenFeatureBriefs 배열에 심는 sentinel — "소급 시딩(§4 W7)이 이미 한 번 돌았다"는 표식.
 *  실제 브리핑 id 가 아니므로 FeatureBriefModal 이 이 값으로 열릴 일은 없다(getFeatureBrief 가
 *  undefined 를 반환 — 훅이 그 경우 아무 것도 하지 않는다). 새 설정 키를 또 만들지 않기 위해
 *  seenFeatureBriefs 자기 배열 안에 얹는다(PLAN §4 W7 "소급 금지" 절 참고). */
export const FEATURE_BRIEF_SEED_SENTINEL = "__seeded_v1__";
