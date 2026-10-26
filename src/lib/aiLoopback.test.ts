import { describe, it, expect } from "vitest";
import { isLoopbackEndpoint } from "./aiLoopback";

describe("isLoopbackEndpoint", () => {
  it("detects common loopback hosts", () => {
    expect(isLoopbackEndpoint("http://localhost:11434")).toBe(true);
    expect(isLoopbackEndpoint("http://127.0.0.1:11434")).toBe(true);
    expect(isLoopbackEndpoint("http://[::1]:11434")).toBe(true);
    expect(isLoopbackEndpoint("http://0.0.0.0:11434")).toBe(true);
    expect(isLoopbackEndpoint("LOCALHOST")).toBe(true);
  });

  it("strips userinfo before checking host", () => {
    expect(isLoopbackEndpoint("http://user:pass@localhost:11434/v1")).toBe(true);
    expect(isLoopbackEndpoint("http://user:pass@127.0.0.1:11434")).toBe(true);
  });

  it("rejects empty string and remote hosts", () => {
    expect(isLoopbackEndpoint("")).toBe(false);
    expect(isLoopbackEndpoint("https://api.openai.com/v1")).toBe(false);
    expect(isLoopbackEndpoint("http://192.168.1.10:11434")).toBe(false);
    expect(isLoopbackEndpoint("http://example.com")).toBe(false);
  });
});
