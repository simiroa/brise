import { describe, expect, it } from "vitest";
import { classifyTranscribeError, isSettingsFix } from "./mobileInputFlows";

describe("classifyTranscribeError (M-20)", () => {
  const cases: [string, string][] = [
    ["ai_required: AI is off", "ai_required"],
    ["audio_too_large: x", "too_long"],
    ["transcribe_in_progress: x", "in_progress"],
    ["gemini request failed with status 401 Unauthorized — check your API key: {}", "key"],
    ["gemini request failed with status 403 Forbidden — check your API key / permissions: {}", "key"],
    ["gemini request failed with status 400 Bad Request — check request parameters (model name, payload): {}", "format"],
    ["AI operation deadline exceeded before a retry or fallback could finish", "deadline"],
    ["boom", "failed"],
  ];
  it.each(cases)("%s -> %s", (msg, code) => {
    expect(classifyTranscribeError({ message: msg })).toBe(code);
  });
  it("hides retry only for fixes that live in settings", () => {
    expect(["ai_required", "key", "format"].every((c) => isSettingsFix(c as never))).toBe(true);
    expect(["too_long", "in_progress", "deadline", "failed"].some((c) => isSettingsFix(c as never))).toBe(false);
  });
});
