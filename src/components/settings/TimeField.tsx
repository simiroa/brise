import { useEffect, useState } from "react";

/** HH:MM 00:00..23:59 — Rust validate_setting 이 받는 모양과 같다. */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 설정 행의 시각 칸(`<input type="time">`) — 종일 알림 시각 · 브리핑 시각 · 저녁 브리핑 시각.
 *
 * 입력 중에는 초안만 바꾸고 **Enter 나 포커스 이탈에서 한 번** 커밋한다. 키를 누를 때마다 저장하면
 * 시·분을 고치는 도중의 빈 값("")이 저장 검증에 걸려 입력하는 동안 토스트가 뜨고, 고친 적 없는 중간
 * 값까지 저장된다. 빈 값·형식이 틀린 값·같은 값은 보내지 않고 원래 값으로 되돌린다. Escape 는 초안을
 * 버린다 — 바꾼 게 있을 때만 이벤트를 삼켜 설정 창이 함께 닫히지 않게 한다.
 *
 * `value` 가 밖에서 바뀌면(저장 실패 롤백·다른 창) 초안을 따라 맞춘다. SettingsRow 의 라벨은
 * `<label>` 이 아니므로 `ariaLabel` 을 꼭 넘긴다.
 */
export function TimeField({
  value,
  onCommit,
  ariaLabel,
  disabled,
  "data-testid": testId,
}: {
  value: string;
  onCommit: (v: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  "data-testid"?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    if (draft !== value && HHMM.test(draft)) onCommit(draft);
    else setDraft(value);
  };

  return (
    <input
      type="time"
      className="field"
      aria-label={ariaLabel}
      data-testid={testId}
      disabled={disabled}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape" && draft !== value) {
          e.preventDefault();
          e.stopPropagation();
          setDraft(value);
        }
      }}
      style={{ width: 120 }}
    />
  );
}
