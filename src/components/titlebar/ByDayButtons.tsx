import { WEEKDAY_CODES, type RepeatDraft } from "./scheduleRrule";
import { weekdayShortLabels } from "../home/dateFmt";

/**
 * 반복 규칙의 요일 토글 버튼 일곱 개(SU..SA) — 일정 수정 모달(`ChipEventModal`)과 카드의 날짜 행(`NoteDatesList`)이 같은 버튼을 쓴다.
 * 예전엔 두 파일이 스타일까지 같은 버튼을 따로 가졌다. 감싸는 요소·`data-testid` 접두(`cal-event-byday` / `reminder-byday`)는 호출부 몫이라
 * 프래그먼트로 돌려준다 — 토글한 새 `byday` 만 `onChange` 로 올린다(나머지 초안 필드는 호출부가 합친다).
 */
export function ByDayButtons({
  byday,
  onChange,
  uiLang,
  testIdPrefix,
}: {
  byday: RepeatDraft["byday"];
  onChange: (next: RepeatDraft["byday"]) => void;
  uiLang: string;
  testIdPrefix: string;
}) {
  const weekdayLabels = weekdayShortLabels(uiLang);
  return (
    <>
      {WEEKDAY_CODES.map((code, i) => {
        const active = byday.includes(code);
        return (
          <button
            key={code}
            type="button"
            data-testid={`${testIdPrefix}-${code}`}
            aria-pressed={active}
            onClick={() => onChange(active ? byday.filter((d) => d !== code) : [...byday, code])}
            style={{
              // 생 26px 이 아니라 칩과 같은 토큰 — 사용자가 글꼴 배율을 올리면 칩만 커지고 요일 버튼은 그대로 남아 줄이 어긋났다.
              width: "var(--ctrl-h-sm)",
              height: "var(--ctrl-h-sm)",
              padding: 0,
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--line)",
              background: active ? "var(--accent)" : "transparent",
              color: active ? "var(--on-solid)" : "var(--text)",
              fontSize: "var(--text-xs)",
              cursor: "pointer",
            }}
          >
            {weekdayLabels[i]}
          </button>
        );
      })}
    </>
  );
}
