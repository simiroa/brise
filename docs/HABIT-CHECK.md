# 습관 체크 (반복 노트 체크 · 내부 `routine_*`)

반복 노트의 오늘치 완료 체크와 이력. 카탈로그/검증 SSOT는 `specs/features/routine.yaml`.

> **이름(2026-10-09, PLAN-2026-10-08 §7 W0)**: 옛 `docs/ROUTINE.md`. "루틴"이라는 말은 이 문서의
> 내부 식별자(`routine_*` 커맨드·`routine_completions` 테이블)에만 남는다 — 폴더별 AI **자동화**
> (`docs/PLAN-2026-10-08-automation.md`, 내부 `automation_*`)와 다른 기능이다(`docs/GLOSSARY.md`).
> 반복 개념이 셋이니 섞지 않는다: ① 이 문서 = 반복 규칙이 붙은 노트의 날짜별 체크(`routine_*`)
> ② 브리핑 "오늘의 습관" = 노트와 무관한 습관 목록(`habit_*`, `specs/commands/habits.yaml`)
>   — 2026-10-21 R18: 카드에 **12주 히트맵**(`habit_history`, 습관별 날짜 체크 이력)을 붙인다. 이 히트맵도 `habit_*` 데이터이고 ①의 `routine_history` 가 아니다.
> ③ "반복 일정" = 타임라인 블록(`timeline_routine_*`).
>
> ⚠️ **스테일(2026-10-09 grep 확인)**: 아래 §1·§5 가 설명하는 `RoutineWidget`·`useRoutineData.ts`
> (`src/components/home/space/`)는 공간 탭과 함께 삭제되어 지금 코드에 없다. 프런트에서
> `routine_today`·`routine_toggle`·`routine_history` 를 부르는 곳도 없고, `routine_today`·`routine_toggle`
> 은 `specs/commands/routine.yaml` 의 `agent:` 블록으로 MCP 도구에 노출되어 있다. Rust 쪽 서술(§2~§4)은
> 이 정리에서 다시 확인하지 않았다.

## 1. 기능 개요

노트에 반복 규칙(`rrule`)이 붙어 있으면 그 노트는 "루틴"이 된다 — 매일/매주 등으로 되풀이되는
할 일(운동, 독서 등)을 날짜별로 체크하고 스트릭/히스토그램으로 돌아본다. 대시보드 공간(Space)
탭의 `RoutineWidget`이 오늘의 루틴 목록 + 스트릭/히트맵/주간/그래프 서브뷰를 보여준다.

## 2. 동작 방식

- **루틴이 되는 조건**: 노트에 `rrule`이 설정돼 있고(제목표시줄 벨 아이콘 → 일정·알림
  모달, `src/components/titlebar/scheduleRrule.ts`) 시작 연월일이 풀 정밀도로 채워져 있으면
  된다. 별도의 "루틴 만들기" 커맨드는 없다 — 반복 규칙이 붙은 노트가 곧 루틴이다.
- **오늘의 루틴**(`routine_today`): 그 노트북에서 `rrule`이 있는 노트를 전부 훑어, RRULE 서브셋
  파서(`repo::schedule::rrule::expand`)로 "오늘 발생하는가"만 계산한다 — occurrence 행을
  실체화하지 않고 매 조회마다 즉석 계산. `start_time` 오름차순(없으면 제목순)으로 정렬.
- **완료 토글**(`routine_toggle`): `(note_id, occur_on)` 쌍을 `routine_completions`에
  INSERT(완료) / DELETE(취소) — 멱등(같은 상태로 두 번 불러도 결과가 같다).
- **이력**(`routine_history`): 지정 기간의 날짜별 `{done, due}` 카운트. `due`도 같은 rrule
  전개로 그 날 발생했어야 할 루틴 수를 센다(완료율 계산의 분모). 최대 400일 범위 —
  넘으면 `Validation` 에러.
- **스트릭**: 서버가 스트릭 수치를 내려주지 않는다 — 프론트가 `routine_history` 결과를
  오늘부터 거꾸로 훑어 계산한다(`useRoutineData.ts::calcRoutineStreak`). "due=0인 날(그날
  발생하는 루틴이 없음)"은 스트릭을 끊지 않고 통과한다.
- **위젯 서브뷰**(`RoutineWidgetConfig.view`): `streak`(스트릭 숫자, 기본값) ·
  `heatmap`(주 단위 격자, `weeks` 설정 가능) · `weekly`(이번 주 요일별 행렬) ·
  `graph`(최근 7일 막대) · `none`.
- **캐시/무효화**: 위젯 여러 개가 같은 오늘/이력 쿼리를 중복 요청하지 않도록 2초 TTL 인메모리
  캐시(`useRoutineData.ts`)를 공유한다. `remote-note-write` 이벤트(다른 기기/모바일에서의
  쓰기)를 받으면 캐시를 전부 무효화하고 다시 불러온다.

## 3. 데이터 모델

전용 완료 이력 테이블만 있고, "루틴"이라는 별도 엔티티/플래그는 없다(반복 규칙이 있는 노트
전체가 대상 집합).

```sql
CREATE TABLE routine_completions (
  note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  occur_on TEXT NOT NULL,   -- 로컬 발생 날짜 'YYYY-MM-DD'
  done_at  TEXT NOT NULL,   -- 완료 시각 ISO8601 UTC
  PRIMARY KEY (note_id, occur_on)
);
```

`activity_log`(7일/2000행 보관, 기기 로컬)이나 `todo_toggle`(마크다운 체크리스트 토글,
시각·occurrence 개념 없음)로는 대체할 수 없어 별도 테이블을 뒀다 — 이유는
`specs/db/schemas/routine_completions.sql` 주석 참고.

## 4. 스케줄/알림 시스템과의 관계

`rrule`, `start_time`, `remind_offset_min` 등 노트의 시각·반복·알림 컬럼은 루틴 전용이 아니라
더 넓은 "일정·알림" 시스템(설계 배경: `docs/PLAN-schedule-system.md`)의 일부다. 루틴은 그
컬럼들 중 `rrule`(+ 시작 연월일)만 조건으로 보는 **소비자**일 뿐 — 알림(리마인더) 발화·트레이
알림 등은 이 문서의 범위 밖이고 스케줄 시스템 쪽 문서를 따른다.

## 5. 핵심 코드 경로

| 영역 | 경로 |
|---|---|
| Rust 커맨드 | `src-tauri/src/commands/routine.rs` |
| Rust repo(오늘/이력/토글) | `src-tauri/src/repo/routine.rs` |
| RRULE 파서/전개 | `src-tauri/src/repo/schedule/rrule.rs` |
| DB 스키마 | `specs/db/schemas/routine_completions.sql` |
| 커맨드 계약 | `specs/commands/routine.yaml` |
| 위젯 UI | `src/components/home/space/widgets/RoutineWidget.tsx` |
| 프론트 데이터 훅 | `src/components/home/space/widgets/useRoutineData.ts` |
| 반복 규칙 입력 UI | `src/components/titlebar/scheduleRrule.ts`, `useReminderDraft.ts` |

## 6. 알려진 한계 / 결정

- 스트릭은 압박 없는 표시가 원칙 — 끊겨도 경고색·알림 없이 숫자만 0으로 돌아간다
  (`space.streak_calm_start` 문구).
- 이력 조회 범위 상한 400일(`ROUTINE_HISTORY_MAX_DAYS`) — 그 이상은 대시보드 타임라인 탭의
  장기 조망으로.
- 루틴은 노트북 스코프(`workspace_id` 필수) — 다른 노트북의 반복 노트는 섞이지 않는다.
