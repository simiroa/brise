import { describe, it, expect } from "vitest";
import { classifyAiError } from "./aiErrorKind";

describe("classifyAiError", () => {
  it("빈 메시지는 unknown", () => {
    expect(classifyAiError("")).toBe("unknown");
    expect(classifyAiError("   ")).toBe("unknown");
  });

  it("401/403 또는 api key 문구는 no_key", () => {
    expect(classifyAiError("openai request failed with status 401 — check your API key: {}")).toBe("no_key");
    expect(classifyAiError("claude request failed with status 403 — check your API key / permissions: {}")).toBe(
      "no_key",
    );
    expect(classifyAiError("Unauthorized: invalid credentials")).toBe("no_key");
  });

  it("404 + model 문구 또는 no such model 은 model_missing", () => {
    expect(
      classifyAiError('ollama request failed with status 404: {"error":"model \'llama9\' not found, try pulling it first"}'),
    ).toBe("model_missing");
    expect(classifyAiError("no such model: gpt-9")).toBe("model_missing");
  });

  it("connection refused/ECONNREFUSED/dns/error sending request 는 unreachable", () => {
    expect(classifyAiError("error sending request for url (http://127.0.0.1:11434/api/chat)")).toBe("unreachable");
    expect(classifyAiError("tcp connect error: Connection refused (os error 10061)")).toBe("unreachable");
    expect(classifyAiError("ECONNREFUSED 127.0.0.1:11434")).toBe("unreachable");
    expect(classifyAiError("dns error: failed to lookup address information")).toBe("unreachable");
  });

  it("429 또는 rate limit/quota 문구는 rate_limited", () => {
    expect(classifyAiError("openai request failed with status 429 (retryable): rate limit exceeded")).toBe(
      "rate_limited",
    );
    expect(classifyAiError("quota exceeded for this billing period")).toBe("rate_limited");
  });

  it("DEADLINE_EXCEEDED 정확 문구는 deadline", () => {
    expect(classifyAiError("AI operation deadline exceeded before a retry or fallback could finish")).toBe(
      "deadline",
    );
  });

  it("CALL_CANCELLED 정확 문구는 cancelled", () => {
    expect(classifyAiError("AI call was cancelled by the user")).toBe("cancelled");
  });

  it("AI 입력 캡 초과 문구는 input_too_long", () => {
    expect(
      classifyAiError(
        "prompt and context exceed AI input limit of 8000 characters (9000); reduce or summarize the input",
      ),
    ).toBe("input_too_long");
  });

  it("알 수 없는 문구는 unknown", () => {
    expect(classifyAiError("something went wrong")).toBe("unknown");
  });

  it("마스킹된 키 문자열(sk-****)이 섞여도 다른 종류 판정이 흔들리지 않는다", () => {
    expect(
      classifyAiError(
        'openai request failed with status 429 (retryable): {"error":"rate limit", "key":"sk-****"}',
      ),
    ).toBe("rate_limited");
    expect(
      classifyAiError('error sending request for url (...): body echoed sk-**** back'),
    ).toBe("unreachable");
  });

  it("대소문자 무시", () => {
    expect(classifyAiError("UNAUTHORIZED — CHECK YOUR API KEY")).toBe("no_key");
    expect(classifyAiError("RATE LIMIT EXCEEDED")).toBe("rate_limited");
  });
});
