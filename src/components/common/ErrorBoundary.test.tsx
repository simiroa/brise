import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
}));

const reportDiagMock = vi.fn();
vi.mock("../../lib/diag", () => ({
  reportDiag: (...args: unknown[]) => reportDiagMock(...args),
}));

function ProblemChild({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error("Test explosion");
  }
  return <div>Normal Content</div>;
}

describe("ErrorBoundary", () => {
  const consoleError = console.error;
  beforeEach(() => {
    // Suppress console.error output during deliberate throw test
    console.error = vi.fn();
    reportDiagMock.mockClear();
  });
  afterEach(() => {
    console.error = consoleError;
  });

  it("renders fallback UI when a child throws and resets on retry", () => {
    let shouldThrow = true;
    const { getByTestId, queryByTestId, queryByText, rerender } = render(
      <ErrorBoundary>
        <ProblemChild shouldThrow={shouldThrow} />
      </ErrorBoundary>
    );

    expect(getByTestId("error-boundary-fallback")).not.toBeNull();
    expect(queryByText("Test explosion")).not.toBeNull();
    expect(queryByText("Normal Content")).toBeNull();

    // Now fix the child condition and click retry
    shouldThrow = false;
    rerender(
      <ErrorBoundary>
        <ProblemChild shouldThrow={shouldThrow} />
      </ErrorBoundary>
    );

    fireEvent.click(getByTestId("error-boundary-retry"));

    expect(queryByTestId("error-boundary-fallback")).toBeNull();
    expect(queryByText("Normal Content")).not.toBeNull();
  });

  it("renders fallbackTitle when provided (EditorPanel / root boundary wiring)", () => {
    const { getByTestId, getByText } = render(
      <ErrorBoundary fallbackTitle="Editor crashed">
        <ProblemChild shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(getByTestId("error-boundary-fallback")).not.toBeNull();
    expect(getByText("Editor crashed")).not.toBeNull();
  });

  // G4 (AUDIT-2026-09-26-fallback-observability.md §3): "ErrorBoundary가 프로덕션에서 에러를
  // 버린다" — the stack log used to be dev-only, so a release-build crash left no trace anywhere.
  it("reports the crash to the diag sink unconditionally (not gated on NODE_ENV === development)", () => {
    render(
      <ErrorBoundary>
        <ProblemChild shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(reportDiagMock).toHaveBeenCalledTimes(1);
    const [level, feature, code, message] = reportDiagMock.mock.calls[0];
    expect(level).toBe("error");
    expect(feature).toBe("render");
    expect(code).toBe("boundary_caught");
    expect(message).toContain("Test explosion");
  });
});
