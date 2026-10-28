import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentConnectCard } from "./AgentConnectCard";

const callMock = vi.fn();
const noticeMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...a: unknown[]) => callMock(...a),
  callSilent: vi.fn(),
  emitNotice: (m: string) => noticeMock(m),
}));

describe("AgentConnectCard", () => {
  it("설치하면 agent_skill_install 을 부르고 MCP 등록 명령을 보여 준다", async () => {
    callMock.mockResolvedValueOnce({ skill_path: "s", cli_path: "c", mcp_command: "claude mcp add x" });
    render(<AgentConnectCard />);
    expect(screen.queryByTestId("agent-mcp-command")).toBeNull();
    await userEvent.click(screen.getByTestId("agent-skill-install"));
    expect(callMock).toHaveBeenCalledWith("agent_skill_install");
    expect((await screen.findByTestId("agent-mcp-command")).textContent).toBe("claude mcp add x");
    expect(noticeMock).toHaveBeenCalledTimes(1);
  });

  it("설치가 실패하면 결과를 보이지 않는다(오류 토스트는 call 이 띄운다)", async () => {
    callMock.mockRejectedValueOnce(new Error("io"));
    render(<AgentConnectCard />);
    await userEvent.click(screen.getByTestId("agent-skill-install"));
    expect(screen.queryByTestId("agent-install-result")).toBeNull();
  });
});
