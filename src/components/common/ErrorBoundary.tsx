import { Component, type ErrorInfo, type ReactNode } from "react";
import { emitNotice } from "../../lib/invoke";
import { reportDiag } from "../../lib/diag";
import { t } from "../../i18n/t";

/** First non-empty line of a React componentStack (e.g. "in ProblemChild" / "at ProblemChild
 *  (...)") — enough to say which component crashed without shipping the whole stack (diag.rs
 *  truncates the message to 300 chars anyway). */
function firstComponentStackFrame(componentStack: string | null | undefined): string {
  if (!componentStack) return "";
  for (const line of componentStack.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    emitNotice(error?.message || "An error occurred");
    // G4 (AUDIT-2026-09-26-fallback-observability.md §3): this used to be dev-console-only, so a
    // release-build crash here left no trace anywhere. Always report — not gated on NODE_ENV.
    reportDiag(
      "error",
      "render",
      "boundary_caught",
      `${error?.name ?? "Error"}: ${error?.message ?? ""} @ ${firstComponentStackFrame(errorInfo.componentStack)}`,
    );
    if (process.env.NODE_ENV === "development") {
      console.error("ErrorBoundary caught an error:", error, errorInfo);
    }
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  public render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          data-testid="error-boundary-fallback"
          className="overlay"
          style={{
            padding: "var(--space-6)",
            margin: "var(--space-4)",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--divider)",
            color: "var(--text)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "var(--space-4)",
            textAlign: "center",
            minHeight: 120,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: "var(--text-md)" }}>
            {this.props.fallbackTitle ?? t("common.component_failed")}
          </div>
          {this.state.error?.message && (
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--muted)",
                maxHeight: 60,
                overflow: "auto",
                wordBreak: "break-word",
              }}
            >
              {this.state.error.message}
            </div>
          )}
          <button
            type="button"
            data-testid="error-boundary-retry"
            className="btn btn-primary"
            onClick={this.handleRetry}
          >
            {t("common.retry")}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
