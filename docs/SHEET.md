# 시트 (Sheet) 섹션

노트 안에 꽂히는 수식 그리드 + 차트 섹션(`sections.kind = 'sheet'`). 결정 로그 SSOT는
[`specs/features/sheet.md`](../specs/features/sheet.md)(축별 결정 표 + JSON 스키마 + 단계표),
카탈로그/검증 SSOT는 `specs/features/sheet.yaml`. 이 문서는 그 위에서 "지금 실제로 도는 것"을
코드 경로와 함께 정리한다.

## 1. 기능 개요

관계도(`diagram`)와 같은 자리에 꽂히는 두 번째 비-텍스트 섹션 종류. 가계부·리스트 정리·수식
계산·차트를 한 섹션 안에서 처리한다. 진입점: `+` 섹션 피커의 "시트", 노트 프리셋 "가계부"
템플릿, AI 만들기, 모바일 시트. P1(엔진)~P5(모바일)까지 전 단계가 shipped.

## 2. 동작 방식

- **셀 편집**: 클릭/드래그 선택, `=`로 시작하면 수식. Enter/Tab/화살표/Shift+화살표로 이동,
  Delete로 지움, F2로 편집 재진입. 채우기 핸들(숫자 연속·수식 상대 참조 이동).
- **수식**: 자작 파서(A1 표기·범위·`$` 절대참조·AST, `src/lib/sheet/parser.ts`) +
  [`@formulajs/formulajs`](https://www.npmjs.com/package/@formulajs/formulajs)(MIT) 함수 집합으로
  평가(`src/lib/sheet/eval.ts`). 의존성 그래프 기반 증분 재계산(`engine.ts`)이라 셀 하나를
  고치면 그 셀에 의존하는 셀만 다시 계산한다. 에러: `#CYCLE!`(순환 참조) · `#NAME?`(알 수 없는
  함수) · `#DIV/0!` · `#REF!`(참조가 가리키던 행/열이 삭제됨).
- **구조 편집**: 행/열 삽입·삭제 시 수식 참조를 자동 rewrite(`rewrite.ts`, `$` 존중, 삭제된
  범위는 `#REF!`로). 열 정렬은 값과 함께 참조도 따라 이동.
  자동 성장: 마지막 10행/2열 안에 내용이 생기면 +50행/+26열, 상한 1000행×52열(AZ) —
  도달하면 CSV 내보내기 배너.
- **복붙**: Ctrl+C/V/X가 TSV — 엑셀/구글시트와 그대로 왕복(`src/lib/sheet/csv.ts`, 별도
  파일 가져오기 UI는 없음).
- **Undo/Redo**: 편집 하나(수동 입력이든 AI든 구조 편집이든)가 셀 패치
  `{ref:{before,after}}` 목록 1개로 기록되고 스택 100단계(`history.ts`) — AI가 여러 셀을
  고쳐도 Undo 한 번에 되돌아간다.
- **그리드 UI**: 자작, `react-window` 양축 가상화(`SheetGrid.tsx`). React 상태가 아니라
  React 밖 `Map` + 버전 카운터로 셀 값을 들고 있어 타건 한 번에 그리드 전체가 리렌더되지
  않는다(`sheetCellRenderCount` 테스트 프로브가 이 계약을 회귀 고정).
- **서식**: 열 단위 `fmt`(`text`/`number`/`currency`/`percent`/`date`/`checkbox`, + 소수
  자릿수) + 셀 단위 오버라이드. 통화 기호는 앱 로케일 기본(ko ₩/en $/fr €), 우클릭
  컨텍스트 메뉴(`SheetContextMenu.tsx`)로 변경. 1행 = 헤더 고정.
- **차트**: [Recharts](https://recharts.org/)(MIT, SVG)로 막대/선/원/합계카드
  (`SheetChart.tsx`). 범위 선택 → 툴바 "차트" → `ChartEditor.tsx`. 스펙은 시트 JSON의
  `charts[]` 배열, x축/시리즈는 A1 범위 문자열로 저장.
- **프리뷰 패널**: `SectionPreview`의 sheet 분기 — 차트 + 읽기 전용 미니 그리드
  (`SheetPreview.tsx`). 첨부 바에는 시트 섹션이 있으면 합성 타일 1개(DB 행 없음, 각주/지역
  타일과 같은 패턴).
- **AI**: `AiActionKind "sheet"` 프리셋 2종(`stores/runAiAction.ts`) — 프롬프트 → 새 섹션
  JSON("시트 만들기"), TSV+프롬프트 → 셀 패치 → `sheet_set_cells`("시트 수정하기"). `=` 뒤
  자연어 → 수식 제안(수식 도우미, `SheetSection.tsx`의 `runSheetFormulaHelper`). "AI에게
  묻기"는 시트를 TSV로 컨텍스트에 얹는다.
- **모바일**: 읽기 그리드 + 단일 셀 편집(탭 → 하단 입력) + 행 추가 + 차트
  (`src/mobile/MobileSheetEditor.tsx`, `MobileAiSheet.tsx`).

## 3. 데이터 모델

`sections.body_md`에 JSON 한 덩어리(계산값은 저장하지 않는다 — 로드 시 재계산):

```jsonc
{
  "v": 1,
  "rows": 100,                       // 자동 성장 반영, 상한 1000
  "cols": [{ "w": 96, "fmt": "currency", "dp": 0, "cur": "KRW" }],  // 상한 52
  "cells": {                         // 희소, 키 = A1 표기
    "B2": { "raw": "=SUM(C2:C9)", "fmt": "number", "dp": 2 }
  },
  "charts": [
    { "id": "c1", "type": "bar|line|pie|total", "title": "월별 지출",
      "x": "A2:A13", "series": ["B2:B13"] }
  ]
}
```

`raw`는 사용자가 친 그대로(`=`로 시작하면 수식). 날짜는 ISO `YYYY-MM-DD`, checkbox는
`TRUE`/`FALSE`. 파싱 실패 시 ErrorBoundary + raw 텍스트 보기(관계도와 같은 패턴).

셀 패치(undo/AI/`sheet_set_cells` 공용):
```ts
type CellPatch = Record<string /*A1*/, { raw: string | null /*null=삭제*/, fmt?; dp?; cur? }>;
```

별도 `sheet_cells` 테이블은 없다 — 스냅샷/export/sync/cascade 재배선 비용 대비 다기기 동시
편집 병합이라는 실익 하나뿐이라 보류(`ponytail:` 천장, 필요해지면 테이블로 승격).

## 3.5 차트 첨부 — 라이브 참조 (PLAN-2026-09-20 §2.3 W4, D5·D6ⓒ·D8)

시트 안 차트를 **첨부**로 등록하면 첨부 바·갤러리에 타일이 생기고 프리뷰 패널에서 그 차트만 크게
본다. 스냅샷(PNG)이 아니라 **참조**다 — 첨부 행은 `kind='chart'`, `url="<section_id>#<chart_id>"`,
파일 없음(V88 CHECK: url 전용 arm). 프리뷰(`preview/ChartRefPreview.tsx`)는 열 때마다
`activeNote.sections` 에서 시트 섹션을 찾아 `parseSheet` → `charts.find` → `SheetChart` 로 다시 그리므로
셀이 바뀌면 값이 따라온다(`useSheetState.saveNow` 가 700ms 디바운스 뒤 `activeNote.sections[].body_md`
를 갱신하는 경로).

- **진입점(D6)**: 차트 편집기 하단 "첨부에 등록" 체크박스(`ChartEditor.tsx`) · 차트 카드의 클립 버튼
  (`SheetSection.tsx`) · (W5) 어시스트/퀵 버튼. 셋 다 `lib/sheet/chartAttachment.ts::setChartRegistered`
  **하나**를 부른다. 켜기 = `attachment_add_chart`(멱등 — 같은 url 이 있으면 그 행), 끄기 =
  `attachment_remove`. 낙관적 갱신 없음, 성공 시 `reloadActive`. 체크 상태의 진실은 DB 행
  (`isChartRegistered(activeNote.attachments, sectionId, chartId)`) — 시트 JSON 에 플래그를 두지 않는다.
- **새 차트**는 저장 뒤 등록한다(id 가 그때 생긴다). `setChartRegistered` 가 `flushAll()` 로 시트 본문을
  먼저 DB 에 보내므로 Rust 검증(`charts[]` 에 id 존재)이 통과한다.
- **Rust 검증**(`repo/attachments::add_chart_ref`): 노트 실재 · 섹션 실재 + `kind='sheet'` + **같은 노트
  소속**(다른 노트 시트 참조는 v1 천장, `ponytail:`) · chart_id 가 `charts[]` 에 있음.
- **원본 없음(D8)**: 섹션이 지워지거나(휴지통·이동) 차트가 스펙에서 빠져도 첨부 행은 **남는다**.
  프리뷰가 "원본 없음" + 제거 버튼을 그리고, 삭제는 사용자 몫(섹션 휴지통 복원과 어긋나지 않게).
- **갤러리**: '차트' 탭(`GALLERY_KIND_TABS` 의 `"chart"`, `kind IN ('chart')`), 전체 탭은 SQL 무변경
  (`kind <> 'internal'` 이 자동 포함 — `docs/SCALABILITY.md` 갤러리 규칙). 타일은 아이콘+이름(썸네일 없음).
- **내보내기/가져오기**: url 행이라 파일 채널 무관. `add_notebook`·`hash_merge`(새 노트 분기)는 섹션 id 를
  새로 발급하므로 url 의 섹션 부분을 같이 옮긴다(`transfer/import/mod.rs::remap_chart_url`).
  `hash_merge --update_existing` 의 기존 노트 분기는 섹션을 새 id 로 통째 교체하므로 그 노트의 기존
  chart 첨부는 "원본 없음"이 된다(천장 — 섹션 id 안정성은 이 기능 밖).

## 4. 핵심 코드 경로

| 영역 | 경로 |
|---|---|
| Rust 커맨드 | `src-tauri/src/commands/sections.rs::sheet_set_cells` |
| Rust 투영(TSV/마크다운 표) | `src-tauri/src/repo/sheet.rs` — `sheet_to_tsv`/`sheet_to_markdown_table`, FTS는 상위 200행만(`FTS_MAX_ROWS`) |
| 프론트 엔진 | `src/lib/sheet/{parser,eval,engine,rewrite,history,a1,csv,format,projection,ops}.ts` |
| 그리드/섹션 UI | `src/components/sheet/{SheetSection,SheetGrid,SheetToolbar,SheetFormulaBar,SheetContextMenu,ChartEditor,SheetChart,SheetPreview}.tsx` |
| 차트 첨부 | `src/lib/sheet/chartAttachment.ts`(등록/해제 단일 함수) · `src/components/preview/ChartRefPreview.tsx` · Rust `repo/attachments/mod.rs::add_chart_ref` · `commands/attachments.rs::attachment_add_chart` · V88 |
| 프리셋 | `src/components/sheet/sheetStarter.ts`(빈 시트/가계부 템플릿) |
| 모바일 | `src/mobile/{MobileSheetEditor,MobileAiSheet}.tsx` |
| AI 연동 | `src/stores/runAiAction.ts::runSheetEdit` |
| DB | `db/migrations.rs` V57(sections CHECK에 `'sheet'` 추가), `repo/sections.rs::validate_kind` |
| 커맨드 계약 | `specs/commands/sections.yaml`(`section_create_with_body.kind`, `sheet_set_cells`), `specs/commands/export.yaml::export_sheet_csv` |

## 5. 알려진 한계 / 안 하기로 한 것

시트 간/노트 간 셀 참조 · 필터 · 조건부 서식 · 명명 범위 · 데이터 검증 · 셀 스타일(굵게·색) ·
동시 편집 병합 · 한 노트에 다중 시트/섹션 — 전부 천장으로 남기고 안 한다(한 섹션 = 한 시트).
자세한 근거는 `specs/features/sheet.md` 결정 표.
