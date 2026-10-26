import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "../../../stores/settings";
import type { CollectSource } from "../../../lib/commands.gen";
import {
  collectIntervalOptions,
  sourceAddressLabel,
  sourceIntervalLabel,
  sourceKindLabel,
} from "./collectSourceLabels";

// 소스 행은 이 세 라벨 함수가 읽는 필드(kind·config)만 채운 최소 형태로 만든다.
function src(kind: string, config: unknown): CollectSource {
  return { kind, config: typeof config === "string" ? config : JSON.stringify(config) } as unknown as CollectSource;
}

describe("collectSourceLabels", () => {
  beforeEach(() => {
    useSettingsStore.setState({ uiLang: "en" } as any);
  });

  describe("sourceKindLabel", () => {
    it("알려진 kind 는 로컬라이즈된 이름을 돌려준다", () => {
      expect(sourceKindLabel(src("rss", {}))).toBe("RSS");
      expect(sourceKindLabel(src("web", {}))).toBe("Web Page");
      expect(sourceKindLabel(src("browser_history", {}))).toBe("Browser history");
    });

    it("kind='rss' 인데 config.url 이 유튜브 채널 구독 피드면 '유튜브 채널' 로 되짚는다", () => {
      const channel = { url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv" };
      expect(sourceKindLabel(src("rss", channel))).toBe("YouTube Channel");
      // 채널 ID 모양이 아니면 그냥 RSS
      expect(sourceKindLabel(src("rss", { url: "https://www.youtube.com/feeds/videos.xml?channel_id=UC1" }))).toBe("RSS");
      // rss 가 아니면 채널 판정 자체를 안 한다
      expect(sourceKindLabel(src("web", channel))).toBe("Web Page");
    });

    it("모르는 kind 는 raw 문자열, 깨진 config JSON 은 무시하고 기본 라벨", () => {
      expect(sourceKindLabel(src("mystery", {}))).toBe("mystery");
      expect(sourceKindLabel(src("rss", "{not json"))).toBe("RSS");
    });
  });

  describe("sourceAddressLabel", () => {
    it("url > project > dir > browser·profile 순으로 첫 값을 주소로 쓴다", () => {
      expect(sourceAddressLabel(src("rss", { url: "https://e.com/f.xml", project: "p" }))).toBe("https://e.com/f.xml");
      expect(sourceAddressLabel(src("claude_prompts", { project: "brise", dir: "d" }))).toBe("brise");
      expect(sourceAddressLabel(src("x", { dir: "/tmp/x", browser: "edge" }))).toBe("/tmp/x");
      expect(sourceAddressLabel(src("browser_history", { browser: "edge", profile: "P2" }))).toBe("edge · P2");
    });

    it("browser 만 있고 profile 이 없으면 Default 로 채운다", () => {
      expect(sourceAddressLabel(src("browser_history", { browser: "chrome" }))).toBe("chrome · Default");
    });

    it("아무 필터도 없거나 config 가 비었거나 깨졌으면 자리 표시자", () => {
      expect(sourceAddressLabel(src("rss", {}))).toBe("—");
      expect(sourceAddressLabel(src("rss", ""))).toBe("—");
      expect(sourceAddressLabel(src("rss", "{not json"))).toBe("—");
    });
  });

  describe("collectIntervalOptions / sourceIntervalLabel", () => {
    it("선택지는 '창을 열 때(0)' 를 앞세운 8개 이산값이다", () => {
      expect(collectIntervalOptions().map((o) => o.value)).toEqual([
        "0", "60", "180", "360", "720", "1440", "4320", "10080",
      ]);
    });

    it("선택지에 맞는 분은 그 라벨, 미설정(null)은 60분으로 본다", () => {
      const options = collectIntervalOptions();
      expect(sourceIntervalLabel(180, options)).toBe("3 hours");
      expect(sourceIntervalLabel(0, options)).toBe("When the app opens");
      expect(sourceIntervalLabel(null, options)).toBe("1 hour (Default)");
    });

    it("선택지 밖의 분(레거시 데이터)은 raw '<n>m' 로 떨어진다", () => {
      expect(sourceIntervalLabel(999, collectIntervalOptions())).toBe("999m");
    });

    it("라벨은 호출 시점의 언어로 만들어진다", () => {
      useSettingsStore.setState({ uiLang: "ko" } as any);
      expect(collectIntervalOptions()[1].label).not.toBe("1 hour (Default)");
    });
  });
});
