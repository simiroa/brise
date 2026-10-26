import { call } from "./invoke";
import { reportFallback } from "./diag";

/**
 * AI 프로바이더 전환 — `ai_provider` 를 바꾸는 **유일한 관문**(오너: "키를 비우면 안 된다").
 *
 * 활성 프로바이더의 크리덴셜은 여전히 `ai_api_key`/`ai_endpoint` 한 벌이다(백엔드·aiCreds() 등 소비처는
 * 그대로). 그 한 벌을 다른 프로바이더로 그냥 넘기면 A 의 키가 B 로 나가고, 비우면 A 의 키를 잃는다.
 * 그래서 전환은 한 번의 settings_set 배치로 ① 지금 값을 `ai_provider_creds[A]` 에 넣어 두고
 * ② `ai_provider=B` ③ `ai_api_key/ai_endpoint` 를 `ai_provider_creds[B]`(없으면 빈 값)로 채운다.
 * 키는 어디에서도 버려지지 않는다(Ollama 에 남은 옛 키는 아래 planProviderSwitch 참고). `ai_provider_creds` 는 ai_api_key 와 같은 비밀로 취급된다
 * (Rust export::is_secret_setting_key — 번들·백업·원격 응답에서 빠진다).
 *
 * 새 작성자는 반드시 이 함수를 지난다(설정 > AI > 연결, 온보딩). 직접 `ai_provider` 를 쓰면 보관함이
 * 어긋난다.
 */

export interface ProviderCreds {
  api_key?: string;
  endpoint?: string;
}
export type ProviderCredsStash = Record<string, ProviderCreds>;

/** Rust validate_setting("ai_provider_creds") 와 같은 이름 규칙 — 어긋나면 배치 전체가 거부된다. */
const PROVIDER_ID_RE = /^[a-z0-9_-]{1,32}$/;
/** 키를 쓰지 않는 로컬 프로바이더 — 설정 화면도 이 경우 키 칸을 숨긴다. */
const KEYLESS_PROVIDER = "ollama";

export interface ProviderSwitchOptions {
  /** 화면에서 지금 보이는(편집 중일 수 있는) 나가는 프로바이더의 값. 주면 DB 값 대신 이것을 보관한다 —
   *  막 친 키의 blur 저장이 아직 안 끝났어도 그 키가 보관함으로 간다. */
  current?: { apiKey: string; endpoint: string };
  /** 들어오는 프로바이더에 바로 쓸 값(온보딩의 방금 입력한 키). 주지 않은 칸은 보관함에서 꺼낸다. */
  next?: { apiKey?: string; endpoint?: string };
}

export interface ProviderSwitchPlan {
  provider: string;
  apiKey: string;
  endpoint: string;
  creds: ProviderCredsStash;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 저장된 보관함을 읽는다 — 모양이 어긋난 항목만 버리고 나머지는 지킨다. */
export function parseCredsStash(raw: unknown): ProviderCredsStash {
  const out: ProviderCredsStash = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!PROVIDER_ID_RE.test(id) || !v || typeof v !== "object" || Array.isArray(v)) continue;
    const c = v as Record<string, unknown>;
    const entry: ProviderCreds = {};
    if (typeof c.api_key === "string") entry.api_key = c.api_key;
    if (typeof c.endpoint === "string") entry.endpoint = c.endpoint;
    out[id] = entry;
  }
  return out;
}

/** 순수 계산 — 저장된 설정 + 다음 프로바이더 → 한 배치에 쓸 값. */
export function planProviderSwitch(
  settings: Record<string, unknown>,
  nextProvider: string,
  opts: ProviderSwitchOptions = {},
): ProviderSwitchPlan {
  const prevId = (str(settings.ai_provider) || "ollama").toLowerCase();
  const nextId = nextProvider.trim().toLowerCase();
  const outgoing = {
    apiKey: opts.current ? opts.current.apiKey.trim() : str(settings.ai_api_key),
    endpoint: opts.current ? opts.current.endpoint.trim() : str(settings.ai_endpoint),
  };
  const creds = parseCredsStash(settings.ai_provider_creds);

  if (prevId === nextId) {
    return {
      provider: nextId,
      apiKey: opts.next?.apiKey?.trim() ?? outgoing.apiKey,
      endpoint: opts.next?.endpoint?.trim() ?? outgoing.endpoint,
      creds,
    };
  }

  if (PROVIDER_ID_RE.test(prevId)) {
    creds[prevId] = { api_key: outgoing.apiKey, endpoint: outgoing.endpoint };
  } else if (outgoing.apiKey || outgoing.endpoint) {
    // 검증을 통과할 수 없는 옛 이름 — 보관하면 배치가 통째로 거부된다. 기록만 남기고 넘어간다.
    reportFallback("ai", "provider_creds_unstashable", prevId.slice(0, 40));
  }
  const incoming = creds[nextId] ?? {};
  let carriedKey = "";
  // Ollama 는 키를 쓰지 않고 화면에도 키 칸이 없다. 그런데도 키가 남아 있으면 이 관문 이전의 전환이
  // ai_api_key 를 그대로 둔 것(클라우드 키)이다 — Ollama 밑에 숨겨 두면 다시 꺼낼 길이 없으니,
  // 들어오는 프로바이더에 키가 없을 때 그쪽으로 넘긴다. 넘길 수 없으면(이미 키가 있거나 새 키를
  // 받았으면) 버리지 않고 Ollama 보관함에 그대로 둔다.
  if (prevId === KEYLESS_PROVIDER && nextId !== KEYLESS_PROVIDER && outgoing.apiKey && opts.next?.apiKey === undefined && !incoming.api_key) {
    carriedKey = outgoing.apiKey;
    creds[prevId] = { ...creds[prevId], api_key: "" };
  }
  return {
    provider: nextId,
    apiKey: opts.next?.apiKey?.trim() ?? (incoming.api_key || carriedKey),
    endpoint: opts.next?.endpoint?.trim() ?? incoming.endpoint ?? "",
    creds,
  };
}

// 전환은 읽기→계산→쓰기라 둘이 겹치면 나중 것이 먼저 것의 보관을 덮는다 — 줄을 세운다.
let queue: Promise<unknown> = Promise.resolve();

/**
 * 전환을 저장하고 새 활성 값을 돌려준다(화면이 다시 읽지 않고 바로 반영하도록). 사용자 행동이라
 * call() 을 쓴다 — 실패는 토스트 뒤 reject 되고, 호출자가 화면을 되돌린다. 읽기가 실패하면 쓰지
 * 않는다(빈 읽기로 보관함을 새로 만들면 다른 프로바이더들의 키가 지워진다).
 */
export function switchAiProvider(nextProvider: string, opts: ProviderSwitchOptions = {}): Promise<ProviderSwitchPlan> {
  const run = async () => {
    const r = await call<{ settings: Record<string, unknown> }>("settings_get_all");
    // 응답에 설정 객체가 없으면 읽기 실패와 같다 — 빈 값으로 계산하면 보관함을 새로 만들어 버린다.
    if (!r?.settings || typeof r.settings !== "object") throw new Error("settings_get_all: no settings");
    const plan = planProviderSwitch(r.settings, nextProvider, opts);
    await call("settings_set", {
      entries: {
        ai_provider: plan.provider,
        ai_api_key: plan.apiKey,
        ai_endpoint: plan.endpoint,
        ai_provider_creds: plan.creds,
      },
    });
    return plan;
  };
  const p = queue.then(run, run);
  // silent-ok: 줄 유지용 꼬리 — 실패는 반환한 p 로 호출자에게 그대로 간다(call() 이 토스트·기록).
  queue = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}
