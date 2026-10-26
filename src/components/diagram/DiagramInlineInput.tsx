import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

type Field = HTMLInputElement | HTMLTextAreaElement;

export interface DiagramInlineInputProps {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  onCommit: (value: string) => void;
  onCancel?: () => void;
  className?: string;
  testId?: string;
  autoFocus?: boolean;
  selectOnFocus?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  style?: CSSProperties;
  onPointerDown?: (e: PointerEvent<Field>) => void;
  /** `<textarea>` — Enter 는 줄바꿈, Ctrl/Cmd+Enter 가 확정(구획 편집: 한 줄 = 한 구획). */
  multiline?: boolean;
  [key: `data-${string}`]: unknown;
}

/**
 * DiagramInlineInput
 *
 * 공통 인라인 편집 입력 컴포넌트:
 * - 노드 라벨, 태그, 아이콘, 설명, 그룹 타이틀, 엣지 라벨 등에서 반복되던 인라인 편집 공통화
 * - Enter (한글 composition 검사 !e.nativeEvent.isComposing 포함), Escape 핸들링
 * - onBlur 시 commit 지원
 * - nodrag nopan nowheel 클래스 기본 포함
 */
export function DiagramInlineInput({
  value,
  defaultValue,
  onChange,
  onCommit,
  onCancel,
  className,
  testId,
  autoFocus = true,
  selectOnFocus = false,
  placeholder,
  ariaLabel,
  style,
  onPointerDown,
  multiline = false,
  ...rest
}: DiagramInlineInputProps) {
  const combinedClass = ["nodrag nopan nowheel", className]
    .filter(Boolean)
    .join(" ");

  const handleFocus = (e: FocusEvent<Field>) => {
    if (selectOnFocus) {
      e.currentTarget.select();
    }
  };

  const handleBlur = (e: FocusEvent<Field>) => {
    onCommit(e.currentTarget.value);
  };

  const handleKeyDown = (e: KeyboardEvent<Field>) => {
    const isComposing = Boolean(
      e.nativeEvent?.isComposing || (e as unknown as { isComposing?: boolean }).isComposing
    );
    if (e.key === "Enter" && !isComposing && (!multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onCommit(e.currentTarget.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel?.();
    }
  };

  const shared = {
    className: combinedClass,
    "data-testid": testId,
    value,
    defaultValue,
    onChange: onChange ? (e: { target: { value: string } }) => onChange(e.target.value) : undefined,
    autoFocus,
    onFocus: handleFocus,
    onBlur: handleBlur,
    onKeyDown: handleKeyDown,
    placeholder,
    "aria-label": ariaLabel,
    style,
    onPointerDown,
    ...rest,
  };

  return multiline ? <textarea {...shared} rows={Math.max(2, (value ?? defaultValue ?? "").split("\n").length)} /> : <input {...shared} />;
}
