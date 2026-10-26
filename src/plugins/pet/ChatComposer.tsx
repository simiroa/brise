import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { IconArrowUp } from "../../components/icons";

/** Shared composer field — sidebar (2 rows, stacked action column) and pet compact (1 row, corner send). */
export function ChatComposer({
  value,
  onChange,
  onSubmit,
  pending,
  disabled,
  rows = 1,
  placeholder,
  sendLabel,
  stopLabel,
  onStop,
  inputRef,
  extra,
  topAction,
  onPaste,
  canSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  pending?: boolean;
  disabled?: boolean;
  rows?: number;
  placeholder: string;
  sendLabel: string;
  stopLabel?: string;
  onStop?: () => void;
  inputRef?: Ref<HTMLTextAreaElement>;
  extra?: ReactNode;
  /** Stacked above the send button in a right-hand action column instead of the corner-overlay send. */
  topAction?: ReactNode;
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  canSubmit?: boolean;
}) {
  // 답을 기다리는 동안 입력 칸에 AI 빛줄기(tokens.css AI-GLOW › BEAM). stores/ai 의 useAiGlow 와
  // 같은 active → fading(300ms) → 해제 모양을 여기서 직접 낸다 — 이 컴포넌트는 펫 창에서도 쓰여서
  // stores/ai 를 끌어오면 작게 유지해야 하는 펫 청크가 커진다.
  const [glow, setGlow] = useState<"active" | "fading" | undefined>(undefined);
  useEffect(() => {
    if (pending) {
      setGlow("active");
      return;
    }
    setGlow((g) => (g ? "fading" : undefined));
    const t = setTimeout(() => setGlow(undefined), 300);
    return () => clearTimeout(t);
  }, [pending]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit();
    }
  };

  // Grows upward with content instead of staying pinned at `rows` — cap at 4x the natural
  // `rows` height (captured once, before the first resize) so a long paste can't eat the whole
  // panel; scrolls internally past that.
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const baseHeightRef = useRef<number | null>(null);
  const setRefs = (el: HTMLTextAreaElement | null) => {
    localRef.current = el;
    if (typeof inputRef === "function") inputRef(el);
    else if (inputRef && typeof inputRef === "object") (inputRef as { current: HTMLTextAreaElement | null }).current = el;
  };
  useEffect(() => {
    const el = localRef.current;
    if (!el) return;
    if (baseHeightRef.current == null) baseHeightRef.current = el.scrollHeight;
    el.style.height = "auto";
    const max = baseHeightRef.current * 4;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [value]);

  const stopping = pending && onStop;
  const sendButton = (
    <button
      type="button"
      className={`pet-chat__send${stopping ? " pet-chat__send--stop" : ""}`}
      aria-label={stopping ? stopLabel : sendLabel}
      disabled={stopping ? false : disabled || !(canSubmit ?? !!value.trim())}
      onClick={() => (stopping ? onStop?.() : onSubmit())}
    >
      {stopping ? stopLabel : <IconArrowUp size={14} strokeWidth={2.4} />}
    </button>
  );
  return (
    <>
      {extra}
      <div
        className={`pet-chat__field${topAction ? " pet-chat__field--stacked" : ""}`}
        data-testid="chat-composer-field"
        data-ai-glow={glow}
        data-ai-glow-beam="true"
      >
        <textarea
          ref={setRefs}
          rows={rows}
          value={value}
          data-testid="chat-composer-textarea"
          placeholder={placeholder}
          disabled={disabled && !stopping}
          onChange={(e) => onChange(e.target.value)}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
        />
        {topAction ? (
          <div className="pet-chat__field-actions">
            {topAction}
            {sendButton}
          </div>
        ) : (
          sendButton
        )}
      </div>
    </>
  );
}
