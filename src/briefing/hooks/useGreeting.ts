/**
 * AI 한 줄 인사 — 기본은 시간대별 정적 문구이고, AI 가 켜져 있고 닿을 때만 한 줄을 받아 **교체**한다.
 * 가드레일: TitleBar 의 AI 진입과 같은 조건(aiEnabled && aiReachable === true)만 쓴다. 호출은 창당 1회.
 * 프라이버시: 프롬프트에는 제목·시각·개수만 들어간다(노트 본문 금지 — 외부 프로바이더일 수 있다).
 * 캐시: 같은 날·같은 입력이면 localStorage 결과를 쓴다(저장 실패해도 동작).
 */
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n/t";
import { callSilent } from "../../lib/invoke";
import { reportFallback, safeErrorDetail } from "../../lib/diag";
import { toIsoDateLocal } from "../../components/home/dateFmt";
import { useSettingsStore } from "../../stores/settings";
import { aiCreds, useAiStore, selectAiAvailability } from "../../stores/ai";
import type { AiGenerateFromPromptOutput } from "../../lib/commands.gen";
import { useDaySchedule, useNow, type DayEntry } from "./useBriefingData";

export type DayPart = "morning" | "afternoon" | "evening" | "night";

export const GREETING_MAX_CHARS = 80;
const TITLE_MAX_CHARS = 40;
const MAX_LISTED = 5;
const AI_TIMEOUT_MS = 15_000;
const CACHE_KEY = "brf.greeting.v1";

// 정적 키 — i18n 미사용 검사가 문자열 리터럴로 본다.
const GREETING_KEY: Record<DayPart, string> = {
  morning: "briefing.greeting_morning",
  afternoon: "briefing.greeting_afternoon",
  evening: "briefing.greeting_evening",
  night: "briefing.greeting_night",
};

export function dayPart(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 22) return "evening";
  return "night";
}

/** 모델에 보낼 사실 — 시간대·개수·앞의 몇 개 일정의 시각+제목뿐. 입력 해시의 기준이기도 하다(분 단위 시각은 넣지 않는다). */
export function buildGreetingFacts(part: DayPart, entries: DayEntry[]): string {
  const lines = entries
    .slice(0, MAX_LISTED)
    .map((e) => `- ${e.start ?? "all-day"} ${e.title.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX_CHARS)}`);
  return [`Time of day: ${part}`, `Events today: ${entries.length}`, ...lines].join("\n");
}

/** 한 줄로 정리 — 개행 제거, 감싼 따옴표 제거, 길이 상한. 비면 null. */
export function sanitizeGreeting(raw: string | null | undefined): string | null {
  const first = (raw ?? "").split(/[\r\n]+/).find((l) => l.trim()) ?? "";
  const one = first.replace(/\s+/g, " ").trim().replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, "").trim();
  if (!one) return null;
  return one.length > GREETING_MAX_CHARS ? `${one.slice(0, GREETING_MAX_CHARS - 1)}…` : one;
}

function hashOf(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

interface CacheRec {
  day: string;
  hash: string;
  text: string;
}

export function readGreetingCache(day: string, hash: string): string | null {
  try {
    const rec = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as CacheRec | null;
    return rec && rec.day === day && rec.hash === hash && typeof rec.text === "string" ? rec.text : null;
  } catch {
    return null; // silent-ok: 저장소가 막혀 있어도 캐시 미스일 뿐이다.
  }
}

function writeGreetingCache(rec: CacheRec): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(rec));
  } catch {
    // silent-ok: 캐시는 덤이다 — 못 써도 다음 열림에 한 번 더 부를 뿐.
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error("greeting_timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e) => {
        clearTimeout(id);
        reject(e);
      },
    );
  });
}

/** 정적 문구로 시작해서, AI 결과가 오면 그 문구를 교체한다(로딩 중 깜빡임 없음). */
export function useGreeting(): { text: string; fromAi: boolean } {
  const now = useNow(60_000);
  const day = toIsoDateLocal(now);
  const part = dayPart(now.getHours());
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const uiLang = useSettingsStore((s) => s.uiLang);
  const aiReachable = useAiStore((s) => s.aiReachable);
  const ensureAiReachable = useAiStore((s) => s.ensureAiReachable);
  const { status, entries } = useDaySchedule(day);
  const [ai, setAi] = useState<string | null>(null);
  const started = useRef(false); // 창당 1회
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (aiEnabled) void ensureAiReachable();
  }, [aiEnabled, ensureAiReachable]);

  const availability =
    typeof selectAiAvailability === "function"
      ? selectAiAvailability({ aiEnabled }, { aiReachable })
      : !aiEnabled
        ? "off"
        : aiReachable === true
          ? "ready"
          : aiReachable === false
            ? "unreachable"
            : "checking";

  useEffect(() => {
    if (started.current || availability !== "ready" || status === "loading") return;
    started.current = true;
    const facts = buildGreetingFacts(part, entries);
    const hash = hashOf(`${uiLang}|${facts}`);
    const hit = readGreetingCache(day, hash);
    if (hit) {
      setAi(hit);
      return;
    }
    const lang = uiLang || "en";
    const prompt =
      `Write one short, warm greeting sentence (under 60 characters) for someone starting their ${part}. ` +
      `Reply in the language with code "${lang}". Output only the sentence: no quotes, no emoji, no line breaks. ` +
      `Use only the facts given; mention the schedule only if it helps.`;
    void (async () => {
      try {
        const res = await withTimeout(
          (async () =>
            callSilent<AiGenerateFromPromptOutput>("ai_generate_from_prompt", {
              prompt,
              context_text: facts,
              ...(await aiCreds()),
            }))(),
          AI_TIMEOUT_MS,
        );
        const text = sanitizeGreeting(res?.generated);
        if (!text) {
          reportFallback("briefing", "greeting_empty", "static greeting kept");
          return;
        }
        writeGreetingCache({ day, hash, text });
        if (mounted.current) setAi(text);
      } catch (e) {
        reportFallback("briefing", "greeting_failed", safeErrorDetail(e));
      }
    })();
  }, [aiEnabled, aiReachable, status, entries, part, day, uiLang]);

  return ai ? { text: ai, fromAi: true } : { text: t(GREETING_KEY[part]), fromAi: false };
}
