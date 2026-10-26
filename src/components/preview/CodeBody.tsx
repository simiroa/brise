import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createLowlight, common } from "lowlight";
import type { Element, ElementContent } from "hast";
import { t } from "../../i18n/t";
import { reportFallback, safeErrorDetail } from "../../lib/diag";
import { IconCheck, IconCopy, IconFolder } from "../icons";

const lowlight = createLowlight(common);

// 확장자 → lowlight 언어. 별칭(py/ts/rs/sh/yml…)은 lowlight 가 알아서 푼다 — 여기는 안 통하는 것만.
// ponytail: dart 는 common 에 없어 java 문법으로 근사한다. 더 정확히 하려면 언어를 따로 등록한다.
const EXT_LANG: Record<string, string> = {
  pyw: "python", mjs: "javascript", cjs: "javascript", jsx: "javascript", tsx: "typescript",
  kts: "kotlin", cc: "cpp", h: "c", hpp: "cpp", zsh: "bash", ps1: "powershell", bat: "dos", cmd: "dos",
  toml: "ini", cfg: "ini", conf: "ini", vue: "xml", svelte: "xml", gradle: "java", mk: "makefile",
  dart: "java",
};

/** 파일 확장자 → 하이라이트 언어. 모르면 null(고정폭 평문). */
export function codeLanguage(ext: string): string | null {
  const lang = EXT_LANG[ext] ?? ext;
  return lowlight.registered(lang) ? lang : null;
}

// hast → React. dangerouslySetInnerHTML 을 쓰지 않는다 — 외부 파일 본문이라 XSS 면을 만들지 않는다.
function renderNode(node: ElementContent, key: number): ReactNode {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return null;
  const el = node as Element;
  const cls = (el.properties?.className as string[] | undefined)?.join(" ");
  return (
    <span key={key} className={cls}>
      {el.children.map((c, i) => renderNode(c, i))}
    </span>
  );
}

/**
 * 첨부 소스·스크립트 뷰어. 에디터 코드블록과 같은 토큰 색(tokens.css `.mdbody pre .hljs-*`)을
 * 재사용하고, 왼쪽에 줄 번호를 둔다. 긴 줄은 접지 않고 가로 스크롤한다(코드 들여쓰기 보존).
 */
export function CodeBody({ text, ext, name, onReveal }: { text: string; ext: string; name?: string; onReveal?: () => void }) {
  const lang = codeLanguage(ext);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text); // 에디터 CodeBlockWithCopy 와 같은 경로
    } catch (e) {
      reportFallback("attachment-code", "copy_failed", safeErrorDetail(e));
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };
  const body = useMemo(() => {
    if (!lang) return text;
    try {
      return lowlight.highlight(lang, text).children.map((c, i) => renderNode(c as ElementContent, i));
    } catch {
      return text; // 하이라이트 실패는 평문으로 — 내용은 그대로 보인다.
    }
  }, [text, lang]);
  const lineCount = useMemo(() => text.split("\n").length, [text]);
  const copyLabel = t(copied ? "editor.code_copied" : "editor.code_copy");
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        className="mdbody scroll"
        data-testid="code-body"
        data-lang={lang ?? "plain"}
        // .mdbody 는 본문용 패딩·max-width 800·가운데 정렬을 준다 — 코드는 패널을 가득 채워야 위/왼쪽이 안 뜬다.
        style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 0, maxWidth: "none", margin: 0 }}
      >
        {/* 글꼴·행간은 pre 한 곳에서 정해 gutter 와 code 가 함께 상속한다 — 줄 번호가 본문 줄과 어긋나지 않게. */}
        <pre style={{ display: "flex", margin: 0, minWidth: "max-content", minHeight: "100%", boxSizing: "border-box", borderRadius: 0, whiteSpace: "pre", tabSize: 4, fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", lineHeight: 1.5 }}>
          <span
            aria-hidden
            data-testid="code-gutter"
            style={{
              flex: "none",
              paddingRight: "var(--space-4)",
              marginRight: "var(--space-4)",
              textAlign: "right",
              color: "var(--faint)",
              userSelect: "none",
              borderRight: "1px solid var(--divider)",
            }}
          >
            {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
          </span>
          <code style={{ font: "inherit" }}>{body}</code>
        </pre>
      </div>
      <div
        data-testid="code-footer"
        className="section-statusbar"
        style={{ justifyContent: "flex-start", gap: "var(--space-3)", fontSize: "var(--text-xs)", lineHeight: 1.4 }}
      >
        {name && <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>}
        <span style={{ color: "var(--faint)" }}>{lang ?? "text"}</span>
        <span style={{ color: "var(--faint)" }}>{t("attachments.code_lines", { n: lineCount })}</span>
        {onReveal && (
          <button
            type="button"
            onClick={onReveal}
            title={t("search.gallery_menu_reveal")}
            aria-label={t("search.gallery_menu_reveal")}
            data-testid="code-reveal"
            style={{ marginLeft: "auto", display: "inline-flex", background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "inherit" }}
          >
            <IconFolder size={14} />
          </button>
        )}
        <button
          type="button"
          onClick={() => void copy()}
          title={copyLabel}
          aria-label={copyLabel}
          data-copied={copied}
          style={{ marginLeft: onReveal ? 0 : "auto", display: "inline-flex", background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "inherit" }}
        >
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
        </button>
      </div>
    </div>
  );
}
