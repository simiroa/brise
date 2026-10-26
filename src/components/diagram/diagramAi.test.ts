import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  expandSubstepsWithAi,
  extractTodosFromDiagram,
  copyTodosToClipboard,
} from "./diagramAi";
import type { DiagramModel } from "./diagramModel";
import { useSettingsStore } from "../../stores/settings";
import { useAiStore } from "../../stores/ai";

/**
 * D1(AUDIT-2026-09-26): expandSubstepsWithAi 이제 stores/ai.ts::aiCreds() 를 통해 settings 에서
 * provider/endpoint/api_key/model 을 읽는다(ai_generate_from_prompt 보다 먼저 나가는 call()).
 * 예전엔 `vi.spyOn(invoke, "callSilent")` 로 그 함수 하나만 목킹했는데, aiCreds() 가 쓰는 건
 * `call()` 이라 실제(Tauri 밖) 구현이 그대로 실행돼 매번 조용히 실패했다 — callSilent 는 한
 * 번도 호출되지 못한 채 catch 로 떨어져 fallback 만 반환됐다(이 테스트가 그 자체로 D1을
 * 재현/은폐했었다). call/callSilent 를 함께 목킹하고 커맨드별로 분기한다.
 */
const callMock = vi.fn();
const emitNoticeMock = vi.fn();
vi.mock("../../lib/invoke", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/invoke")>();
  return {
    ...actual,
    call: (...args: unknown[]) => callMock(...args),
    callSilent: (...args: unknown[]) => callMock(...args),
    emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
  };
});

const AI_SETTINGS_RESPONSE = {
  settings: {
    ai_provider: "ollama",
    ai_endpoint: "http://localhost:11434",
    ai_api_key: "",
    ai_model: "llama3",
  },
};

/** settings_get_all 만 채우고(aiCreds 용) 나머지 커맨드는 각 테스트가 덧붙인다. */
function mockAiPipeline(genImpl?: (args: unknown) => unknown) {
  callMock.mockImplementation((cmd: string, args?: unknown) => {
    if (cmd === "settings_get_all") return Promise.resolve(AI_SETTINGS_RESPONSE);
    if (cmd === "ai_generate_from_prompt" && genImpl) return Promise.resolve(genImpl(args));
    return Promise.resolve({});
  });
}

describe("diagramAi", () => {
  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
  });

  describe("expandSubstepsWithAi", () => {
    it("returns smart fallback steps when AI is disabled", async () => {
      useSettingsStore.setState({ aiEnabled: false });
      useAiStore.setState({ aiReachable: false });

      const steps = await expandSubstepsWithAi("신규 기능 기획");
      expect(steps.length).toBeGreaterThanOrEqual(3);
      expect(steps[0]).toContain("신규 기능 기획");
      // AI가 꺼져 있으면 aiCreds()/ai_generate_from_prompt 어느 쪽도 부르면 안 된다.
      expect(callMock).not.toHaveBeenCalled();
    });

    it("parses AI json output when AI is reachable", async () => {
      useSettingsStore.setState({ aiEnabled: true });
      useAiStore.setState({ aiReachable: true });
      mockAiPipeline(() => ({
        generated: '["요구사항 수집", "와이어프레임 설계", "프로토타입 검증"]',
      }));

      const steps = await expandSubstepsWithAi("UI 디자인", "화면 설계");
      expect(steps).toEqual(["요구사항 수집", "와이어프레임 설계", "프로토타입 검증"]);

      // D1 회귀 고정: provider 가 실제로 전달되고, api_key/model 에 "omit" 리터럴이 없어야 한다.
      const genCall = callMock.mock.calls.find((c) => c[0] === "ai_generate_from_prompt");
      expect(genCall).toBeDefined();
      const args = genCall![1] as Record<string, unknown>;
      expect(args.provider).toBe("ollama");
      expect(args.api_key).not.toBe("omit");
      expect(args.model).not.toBe("omit");
    });

    it("falls back gracefully when AI returns invalid JSON", async () => {
      useSettingsStore.setState({ aiEnabled: true });
      useAiStore.setState({ aiReachable: true });
      mockAiPipeline(() => ({ generated: "이것은 유효하지 않은 응답입니다" }));

      const steps = await expandSubstepsWithAi("결제 시스템 연동");
      expect(steps.length).toBeGreaterThanOrEqual(3);
      expect(steps[0]).toContain("결제 시스템 연동");
    });

    it("falls back gracefully when the settings/creds lookup itself fails", async () => {
      useSettingsStore.setState({ aiEnabled: true });
      useAiStore.setState({ aiReachable: true });
      callMock.mockImplementation((cmd: string) => {
        if (cmd === "settings_get_all") return Promise.reject(new Error("db locked"));
        return Promise.resolve({});
      });

      const steps = await expandSubstepsWithAi("배포 파이프라인");
      expect(steps.length).toBeGreaterThanOrEqual(3);
      expect(steps[0]).toContain("배포 파이프라인");
    });
  });

  describe("extractTodosFromDiagram", () => {
    const mockModel: DiagramModel = {
      v: 1,
      empty: false,
      route: "curve",
      states: [],
      direction: "LR",
      structured: true,
      nodes: [
        { id: "n1", label: "기획", desc: "요구사항 정의" },
        { id: "n2", label: "개발", desc: "API 구현" },
        { id: "n3", label: "배포" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2" },
        { id: "e2", from: "n2", to: "n3" },
      ],
      groups: [],
    };

    it("extracts all nodes in flow order as markdown checklist", () => {
      const todos = extractTodosFromDiagram(mockModel);
      const lines = todos.split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe("- [ ] 기획: 요구사항 정의");
      expect(lines[1]).toBe("- [ ] 개발: API 구현");
      expect(lines[2]).toBe("- [ ] 배포");
    });

    it("extracts only selected nodes when selectedNodeIds is provided", () => {
      const todos = extractTodosFromDiagram(mockModel, ["n2", "n3"]);
      const lines = todos.split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe("- [ ] 개발: API 구현");
      expect(lines[1]).toBe("- [ ] 배포");
    });

    it("returns empty string if diagram has no nodes", () => {
      const emptyModel: DiagramModel = {
        v: 1,
        empty: true,
        route: "curve",
        states: [],
        direction: "TB",
        structured: true,
        nodes: [],
        edges: [],
        groups: [],
      };
      expect(extractTodosFromDiagram(emptyModel)).toBe("");
    });
  });

  describe("copyTodosToClipboard", () => {
    it("copies text to clipboard and emits notice", async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: {
          writeText: writeTextMock,
        },
      });

      const ok = await copyTodosToClipboard("- [ ] 테스트 작업");
      expect(ok).toBe(true);
      expect(writeTextMock).toHaveBeenCalledWith("- [ ] 테스트 작업");
      expect(emitNoticeMock).toHaveBeenCalled();
    });

    it("returns false if text is empty", async () => {
      const ok = await copyTodosToClipboard("");
      expect(ok).toBe(false);
    });
  });
});
