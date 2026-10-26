import { callSilent } from "./invoke";
import { reportFallback, safeErrorDetail } from "./diag";
import { uniqueId } from "./ids";
import { useSettingsStore, CHAT_MEMORY_MAX_ITEMS, CHAT_MEMORY_MAX_LENGTH } from "../stores/settings";
import { aiCreds } from "../stores/ai";
import type { AiGenerateFromPromptOutput } from "./commands.gen";

/**
 * W17 — 챗봇 메모리 자동 추출 (결정 13.4, W17).
 *
 * 사이드바 채팅 응답 파이프라인 후행 훅:
 * - 대화 턴이 끝난 뒤 백그라운드로 사용자의 기억할 만한 사실(선호, 취향, 배경 등)을 JSON으로 추출하여 chat_memory에 추가한다.
 * - 실패는 조용히 무시한다(메모리는 부가 기능 — 채팅 자체를 방해하지 않음).
 * - aiEnabled가 꺼져 있으면 동작하지 않는다.
 * - 50개 캡(CHAT_MEMORY_MAX_ITEMS) 도달 시 오래된 것을 밀어내지 않고 추가를 멈춘다.
 *
 * ponytail: 추출 결과를 저장하기 전 사용자 확인을 거칠지는 추후 사용자 피드백에 따라 결정(현재는 자동 저장 + 설정에서 삭제 가능).
 */

const EXTRACT_PROMPT = `Analyze the following conversation turn between User and Assistant.
If the User explicitly mentions a permanent personal fact, background, preference, habit, or interest (e.g. "I am a designer", "I live in Paris", "I like cats", "My dog's name is Choco"), extract it as a short, standalone factual sentence in the same language as the user (e.g. "사용자는 디자이너로 일하고 있다", "User lives in Paris").
Do NOT extract temporary requests, questions, emotional states, task instructions, or assistant statements.
If no permanent personal fact is mentioned by the user, return an empty JSON array: []

Respond ONLY with a JSON array of strings, for example:
["Fact 1", "Fact 2"] or []`;

export async function extractAndSaveChatMemory({
  userText,
  assistantText,
}: {
  userText: string;
  assistantText: string;
}): Promise<void> {
  try {
    const aiEnabled = useSettingsStore.getState().aiEnabled;
    // 이 게이트가 펫 말풍선(pet-bubble) 창에서 이 함수 전체를 사실상 죽여 둔다: 그 창은 풀 앱
    // 부팅(useSettingsStore.getState().load())을 안 거치고(main.tsx 의 #/pet-bubble 분기가
    // 먼저 return 한다) settings_get_all 자체가 PET_ALLOWED_COMMANDS 에도 없어 부를 수도 없다
    // — 그래서 aiEnabled 는 이 창에서 영원히 초기값 false 다(D1/AUDIT-2026-09-26, 조사 확인).
    // 즉 이 함수는 pet-bubble 에서 항상 여기서 조용히 끝나고, ai_generate_from_prompt 까지
    // 못 간다 — pet-bubble 전용 창-라벨 가드가 따로 필요 없는 이유.
    if (!aiEnabled) return;
    // PLAN-2026-08-30 §3 W2: 새 킬 스위치 — 대화에서 사실을 뽑아 저장하는 건 사용자가 끌 수 있어야
    // 한다(기본 ON, settings_schema.rs 기본값과 동일).
    if (!useSettingsStore.getState().aiChatMemory) return;

    const trimmedUser = userText.trim();
    if (trimmedUser.length < 4) return;

    // W18 C1: ponytail: 정규식 휴리스틱. 놓치는 사실보다 아끼는 호출이 크다 — 정밀도가 문제되면 N턴 배치로
    const FIRST_PERSON_PATTERN = /(?:나는|내가|제가|내 |나의|나 |\bI am\b|\bI live\b|\bI work\b|\bmy \b|\bI'm\b|\bI have\b|\bI like\b)/i;
    if (!FIRST_PERSON_PATTERN.test(trimmedUser)) return;

    const currentMemory = useSettingsStore.getState().chatMemory;
    if (currentMemory.length >= CHAT_MEMORY_MAX_ITEMS) return;

    const context = `User: ${trimmedUser}\nAssistant: ${assistantText.trim().slice(0, 500)}`;

    // D1(AUDIT-2026-09-26): provider 누락 + api_key/model "omit" 리터럴 — Rust 쪽 provider:
    // String 필수 인자라 매번 조용히 거부됐다(이 함수가 실제로는 한 번도 성공한 적이 없었다는
    // 뜻). stores/ai.ts::aiCreds() 로 실제 크리덴셜을 채운다(크리덴셜 로직 중복 금지).
    const res = await callSilent<AiGenerateFromPromptOutput>("ai_generate_from_prompt", {
      prompt: EXTRACT_PROMPT,
      context_text: context,
      ...(await aiCreds()),
    });

    if (!res?.generated) return;

    let items: string[] = [];
    const text = res.generated.trim();
    const jsonStart = text.indexOf("[");
    const jsonEnd = text.lastIndexOf("]");
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
      if (Array.isArray(parsed)) {
        items = parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      }
    }

    if (items.length === 0) return;

    // W18 C1 경합 수정: LLM 왕복(수 초) 사이 다른 턴이나 설정 창이 chatMemory 를 바꿨을 수 있다.
    // write 직전에 재조회해 그 기준으로 중복·캡을 판정하고 병합한다 — line 43 의 snapshot 은
    // 호출 여부 판단(조기 return)에만 쓰고, 실제 쓰기에는 절대 쓰지 않는다.
    const freshMemory = useSettingsStore.getState().chatMemory;
    const remainingSlots = CHAT_MEMORY_MAX_ITEMS - freshMemory.length;
    if (remainingSlots <= 0) return;

    // 현재 메모리에 없는 항목만 선별 + 200자 캡 적용
    const existingSet = new Set(freshMemory.map((m) => m.text.trim()));
    const toAdd: string[] = [];

    for (const item of items) {
      const clean = item.trim().slice(0, CHAT_MEMORY_MAX_LENGTH);
      if (clean && !existingSet.has(clean)) {
        existingSet.add(clean);
        toAdd.push(clean);
        if (toAdd.length >= remainingSlots) break;
      }
    }

    if (toAdd.length > 0) {
      const newItems = toAdd.map((text) => ({
        id: uniqueId("mem"),
        text,
        created_at: new Date().toISOString(),
      }));
      await useSettingsStore.getState().setChatMemory([...newItems, ...freshMemory]);
    }
  } catch (e) {
    // 메모리 추출 실패는 조용히 무시 (채팅 장애 유발 방지)
    reportFallback("chat", "memory_extraction_failed", safeErrorDetail(e));
  }
}
