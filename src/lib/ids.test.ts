import { describe, expect, it } from "vitest";
import { randomId, uniqueId } from "./ids";

describe("ids utility", () => {
  it("generates unique unprefixed IDs", () => {
    const id1 = uniqueId();
    const id2 = uniqueId();
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });

  it("generates prefixed IDs using randomId and uniqueId", () => {
    const id1 = randomId("test");
    const id2 = uniqueId("item");
    expect(id1.startsWith("test-")).toBe(true);
    expect(id2.startsWith("item-")).toBe(true);
    expect(id1).not.toBe(id2);
  });

  it("falls back gracefully when crypto.randomUUID is not available", () => {
    const originalCrypto = globalThis.crypto;
    try {
      // Temporarily mock crypto to simulate environment without randomUUID
      // @ts-expect-error mutating global crypto for test
      delete globalThis.crypto;

      const id1 = randomId("fallback");
      const id2 = uniqueId();
      expect(id1.startsWith("fallback-")).toBe(true);
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: originalCrypto,
        configurable: true,
        writable: true,
      });
    }
  });
});
