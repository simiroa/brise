import { describe, it, expect, vi } from "vitest";

// 이 파일이 검증하는 것은 순수 파서(splitChecklist)뿐이다 — 모듈 최상단에서 Tauri 이벤트 API와
// 스토어를 끌고 오므로(브리지 모듈) 임포트가 성립하도록만 목을 세운다.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { splitChecklist } from "./petThemeBridge";

describe("splitChecklist — 모델 응답 → (제목, 본문)", () => {
  it("takes the first line as the title and the rest as the body", () => {
    const { title, body } = splitChecklist("장보기 목록\n- [ ] 우유\n- [ ] 계란");
    expect(title).toBe("장보기 목록");
    expect(body).toBe("- [ ] 우유\n- [ ] 계란");
  });

  it("strips a markdown heading marker from the title line", () => {
    expect(splitChecklist("## 장보기\n- [ ] 우유").title).toBe("장보기");
  });

  it("keeps everything as body when the model skips the title line", () => {
    // 작은 로컬 모델이 흔히 하는 응답 — 제목을 훔쳐가면 첫 항목이 사라진다.
    const { title, body } = splitChecklist("- [ ] 우유\n- [ ] 계란");
    expect(title).toBeUndefined();
    expect(body).toBe("- [ ] 우유\n- [ ] 계란");
  });

  it("keeps a single-line response whole", () => {
    const { title, body } = splitChecklist("  장보기 목록  ");
    expect(title).toBeUndefined();
    expect(body).toBe("장보기 목록");
  });
});
