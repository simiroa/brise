import { describe, it, expect } from "vitest";
import { buildManifest, repoFromEndpoint, versionMismatch } from "./release-public.mjs";

describe("repoFromEndpoint", () => {
  it("GitHub 릴리스 주소에서 owner/repo 를 뽑는다", () => {
    expect(repoFromEndpoint("https://github.com/simiroa/brise/releases/latest/download/latest.json")).toBe("simiroa/brise");
  });
  it("GitHub 릴리스가 아닌 주소는 null — 다른 호스팅으로 옮기면 스크립트가 멈춘다", () => {
    expect(repoFromEndpoint("https://updates.example.com/latest.json")).toBeNull();
    expect(repoFromEndpoint(undefined)).toBeNull();
  });
});

describe("versionMismatch", () => {
  it("세 곳이 같으면 null, 다르면 무엇이 다른지", () => {
    expect(versionMismatch({ pkg: "0.5.4", conf: "0.5.4", cargo: "0.5.4" })).toBeNull();
    expect(versionMismatch({ pkg: "0.5.4", conf: "0.5.3", cargo: "0.5.4" })).toContain("tauri.conf.json 0.5.3");
  });
});

describe("buildManifest", () => {
  it("Tauri v2 업데이터 형식 — windows-x86_64 하나, 서명은 공백 제거", () => {
    const m = buildManifest({
      version: "0.5.4",
      notes: "변경 요약",
      pubDate: "2026-10-27T00:00:00.000Z",
      signature: "  c2ln\n",
      url: "https://github.com/simiroa/brise/releases/download/v0.5.4/Brise_0.5.4_x64-setup.exe",
    });
    expect(m).toEqual({
      version: "0.5.4",
      notes: "변경 요약",
      pub_date: "2026-10-27T00:00:00.000Z",
      platforms: {
        "windows-x86_64": {
          signature: "c2ln",
          url: "https://github.com/simiroa/brise/releases/download/v0.5.4/Brise_0.5.4_x64-setup.exe",
        },
      },
    });
  });
});
