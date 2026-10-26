# 시트 섹션 (Sheet) — 기능 결정 요약 (사람용 SSOT)

노트의 새 섹션 kind `sheet`. 관계도(`diagram`)와 같은 자리에 꽂히는 두 번째 비-텍스트 섹션.
용도: 가계부·리스트 정리·수식 계산·차트·AI 보조. 결정일 2026-08-19 (그릴링 세션).

## 결정 표

| 축 | 결정 | 이유 / 대안 기각 |
|---|---|---|
| 수식 엔진 | 자작 파서(A1 · 범위 · `$` 절대참조 · AST) + **formulajs**(MIT) 함수 집합. 증분 재계산(의존성 그래프 · 위상 순서), `#CYCLE!` `#REF!` `#NAME?` `#VALUE!` `#DIV/0!` | HyperFormula 는 GPL — 개인용이라 문제 없지만 통제권·번들 대비 이득 없음. 순수 자작은 함수 커버리지 부족 |
| 그리드 UI | 자작. `react-window` **양축 가상화**. 상태는 React 밖 `Map` + 버전 카운터 | Glide/canvas 그리드는 디자인 토큰(`--surface` `--accent` `--fs`) 밖으로 나감. TipTap 테이블은 셀 참조·구조 편집에 부적합 |
| 저장 | `sections.kind = 'sheet'`, `body_md` 에 JSON 한 덩어리(아래 스키마). 계산값 미저장(로드 시 재계산). **`sheet_set_cells` 커맨드**(셀 패치, AI·모바일·플랜 공용) | 별도 `sheet_cells` 테이블은 스냅샷·export·sync·cascade 재배선 비용 대비 실익 = 다기기 동시 편집 병합뿐. `ponytail:` 천장 — 그게 필요해지면 테이블로 |
| FTS / export / AI 투영 | Rust `sheet_to_text(json)` → TSV. `fts_upsert` 는 **상위 200행만**, 마크다운 export 는 표(전체), AI 컨텍스트도 TSV | JSON 이 검색 결과·.md 에 새는 것 방지. FTS 트라이그램 재색인 비용 상한 |
| 크기 | 초기 100행×26열(A~Z). 마지막 10행/2열 안에 내용 생기면 +50행 / +26열. **상한 1000행×52열(AZ)** — 도달 시 배너 "CSV 로 내보내기". | 앱 안에서 대량 리스트를 다루지 않음 |
| 서식 | **열 단위** `fmt`: `text` `number` `currency` `percent` `date` `checkbox` (+ 소수 자릿수) + **셀 단위 fmt 오버라이드**. 통화 기호 = 앱 로케일 기본(ko ₩ / en $ / fr €), 열·셀에서 덮어쓰기. 우클릭 컨텍스트 메뉴로 변경. 1행 = 헤더(굵게 고정). 정렬은 타입이 결정(숫자 우 · 텍스트 좌) | 셀 굵게·색·조건부 서식은 후속 |
| 구조 편집 | 행/열 삽입·삭제 + **수식 참조 자동 rewrite**(`$` 존중, 삭제 범위 → `#REF!`). 열 정렬(값 기준 실제 데이터 이동, 참조 동반 이동). 필터 X | 참조 미이동은 조용한 오답. rewrite 함수는 채우기 핸들·복붙 상대참조와 공유 |
| 상호작용 | Ctrl+C/V/X = TSV(엑셀/구글시트 왕복 = 가져오기 대체). 채우기 핸들(숫자 연속 · 수식 상대 이동). Enter↓ Tab→ 화살표 Shift+화살표 Delete F2. `=` 로 시작하면 수식 모드에서 셀 클릭으로 참조 삽입. **Undo/Redo** — 편집 = 셀 패치 `{ref:{before,after}}` 목록 1개, 스택 100단계, AI 편집도 한 번에 undo. CSV 내보내기(`export_sheet_csv`) | 별도 파일 가져오기 UI 없음. Ctrl+방향키·Ctrl+A 후속 |
| 시각화 | **Recharts**(MIT, SVG). 막대·선·원·합계카드. 스펙은 시트 JSON `charts[]`. 범위 선택 → 툴바 "차트". AI 수정하기가 `charts` 도 편집 | 자작 SVG 는 툴팁·축·범례까지 500줄+ ; 캔버스 계열은 토큰 못 씀. 차트 성능은 쟁점 아님(범위 = 수십~수백 포인트) |
| 프리뷰 패널 | `previewItem {kind:"section"}` → `SectionPreview` sheet 분기: **차트 + 읽기 전용 미니 그리드** | 관계도 프리뷰와 같은 길 |
| 첨부 바 | 시트 섹션이 있으면 **합성 타일 1개**(각주·지역 타일 패턴, DB 행 없음) → 클릭 시 해당 섹션 프리뷰 | |
| AI | `AiActionKind "sheet"` 프리셋 2종: **시트 만들기**(프롬프트 → 새 섹션 JSON), **시트 수정하기**(TSV + 프롬프트 → 셀 패치 → `sheet_set_cells`). **수식 도우미**(`=` 뒤 자연어 → 수식 제안). **분석**은 기존 "AI 에게 묻기"에 TSV 컨텍스트 | 관계도 만들기/수정하기와 동형 |
| 모바일 | 읽기 그리드 + **단일 셀 편집**(탭 → 하단 입력) + 행 추가 + 차트. 그리드 컴포넌트 `touch` prop 공유 | 폰에서 "지출 한 줄 추가"가 핵심 |
| 진입점 | `+` 피커 "시트" · 노트 프리셋 "가계부" 템플릿 · AI 만들기 · 모바일 시트 | 관계도 4곳 그대로 |
| 안 함 (천장) | 시트 간/노트 간 참조 · 필터 · 조건부 서식 · 명명 범위 · 데이터 검증 · 셀 스타일 · 동시 편집 병합 · 다중 시트/섹션 | 한 섹션 = 한 시트 |

## body_md JSON 스키마 v1

```jsonc
{
  "v": 1,
  "rows": 100,                       // 현재 확보된 행 수(자동 성장 반영). 상한 1000
  "cols": [                          // 길이 = 열 수(초기 26, 상한 52)
    { "w": 96, "fmt": "currency", "dp": 0, "cur": "KRW" }   // fmt/dp/cur 생략 가능(= text)
  ],
  "cells": {                         // 희소. 키 = A1 표기. 빈 셀은 키 없음
    "A1": { "raw": "항목" },
    "B2": { "raw": "=SUM(C2:C9)", "fmt": "number", "dp": 2 }   // 셀 fmt 오버라이드
  },
  "charts": [
    { "id": "c1", "type": "bar|line|pie|total", "title": "월별 지출",
      "x": "A2:A13", "series": ["B2:B13"] }
  ]
}
```

- `raw` 는 사용자가 친 그대로(문자열). `=` 로 시작하면 수식. 계산값·에러는 저장하지 않는다.
- 날짜는 ISO `YYYY-MM-DD` 문자열, checkbox 는 `TRUE`/`FALSE`.
- 파싱 실패 → ErrorBoundary + raw 보기(관계도 패턴).

## 셀 패치 (undo · AI · sheet_set_cells 공용)

```ts
type CellPatch = Record<string /*A1*/, { raw: string | null /*null = 삭제*/, fmt?: ..., dp?: ..., cur?: ... }>;
```
구조 편집(삽입·삭제·정렬)도 결과적으로 셀 패치 + `rows/cols` 변경으로 표현한다.

## 단계

| 단계 | 내용 | 검증 |
|---|---|---|
| **P1 인프라+엔진** | **V57**(sections CHECK 에 `'sheet'` — 테이블 재생성. V56 은 공간 관계 테이블이 먼저 가져갔다) · `validate_kind` · `sheet_set_cells`(spec yaml + gen) · Rust `repo/sheet.rs`(`sheet_to_tsv`·`sheet_to_markdown_table`) + `fts_upsert`/검색 스니펫/markdown·html export/AI 컨텍스트 분기 · 프론트 `src/lib/sheet/`: 파서·평가기(formulajs)·의존성 그래프·증분 재계산·참조 rewrite·패치/undo 모델·JSON 스키마·TSV 투영. UI 없음 | vitest · cargo test --lib |
| **P2 그리드(데스크톱)** | `SheetSection`(관계도 동형) · 가상화 그리드 · 선택/편집/키보드/복붙/채우기 · 행열 삽입삭제·정렬 · 자동 성장·배너 · 우클릭 서식 · `+` 피커·프리셋 · kind 유니온 전파 · 탭 아이콘 · CSV 내보내기 | |
| **P3 차트+프리뷰+첨부** | Recharts · 차트 편집 UI · SectionPreview 분기 · 합성 타일 | |
| **P4 AI** | 프리셋 kind `sheet` 2종 · 수식 도우미 · 묻기 TSV 컨텍스트 · runAiAction/aiSectionBridge/MobileAiSheet 분기 | |
| **P5 모바일** | MobileNote 분기 · touch 그리드 · 셀 편집 · 행 추가 | |

## 관련

- 커맨드: `specs/commands/sections.yaml` (`section_create_with_body.kind`, `sheet_set_cells`)
- 선례: `src/components/diagram/DiagramSection.tsx`, `db/migrations.rs` V26/V55, `repo/sections.rs::validate_kind`
- 용어: `docs/GLOSSARY.md` — 사용자 문구는 "시트"
