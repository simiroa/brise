# 노트북 (Notebook)

Brise의 최상위 스코프. 코드 내부 식별자는 여전히 `workspace`(= 노트북, `docs/GLOSSARY.md`) —
사용자에게 보이는 곳(UI 문구·문서)은 전부 "노트북"으로 쓴다. 카탈로그/검증 SSOT는
`specs/features/workspaces.yaml`.

## 1. 기능 개요

폴더·노트·태그·지역/시대/상태 커스터마이즈·공간(Space)까지, 앱 안의 거의 모든 사용자
데이터는 노트북 하나에 속한다. 한 기기에 여러 노트북을 만들어 완전히 분리된 컬렉션으로 쓸 수
있다(예: "일상 기록" 노트북과 "여행" 노트북). 노트북은 SQLite 한 파일 안의 행 하나일
뿐이라 여러 개를 둬도 비용이 크지 않다.

- 좌측 패널 상단의 **노트북 스위처**(`WorkspaceSwitcher.tsx`)로 전환/생성/이름변경/아이콘·
  배경 이미지 설정/삭제.
- **가져오기/내보내기의 단위**다 — `export_workspace_bundle` / `import_bundle`(add_notebook·
  hash_merge 모드)로 노트북 하나를 통째로 다른 기기·다른 설치본에 옮길 수 있다(§4).
- **대시보드는 노트북 스코프**다(컨셉 B, `docs/DASHBOARD.md` §0) — 상태/달력/타임라인/지도/
  관계/공간 여섯 탭 모두 현재 활성 노트북의 데이터만 보여준다. 노트북을 전환하면 대시보드
  탭도 전환된 노트북의 내용으로 다시 렌더된다.

## 2. 동작 방식

- **활성 노트북**: `settings.active_workspace_id`. 없거나 가리키는 행이 없으면
  `created_at` 기준 첫 노트북으로 폴백(`repo/folders.rs::active_workspace_id`) — 항상 유효한
  노트북 하나를 반환하므로 앱이 "활성 노트북 없음" 상태에 빠지지 않는다.
- **전환**(`switchTo`, `stores/workspaces.ts`): 저장 중인 편집을 `flushAll()`로 먼저 흘려보내고,
  대기 중인 undo-삭제도 커밋한 뒤 `settings_set { active_workspace_id }`로 영속화. 탭바/활성
  노트를 리셋하고, 그 노트북의 트리를 다시 로드하고, 휴지통/보관함 카운트와 다중선택 상태도
  새로 맞춘다.
- **생성**: 이름 필수(공백만이면 거부) + 기본 폴더 "Notes" 하나를 같은 트랜잭션에서 시드
  (`repo/workspaces.rs::create`). 연대 프리셋(`korea`/`france`, 타임라인 지역명 프리셋)을
  선택적으로 지정 가능 — 생략하면 전역 설정값으로 폴백.
  각 노트북은 아이콘(`icon`)과 배경 이미지(`bg_image_path`, 최대 20MB, `workspace_bg/{id}/`
  아래 저장)를 개별로 가질 수 있다 — 스위처 트리거 칩과 드롭다운 행이 그 이미지를 배경으로
  깔아 노트북끼리 시각적으로 구분되게 한다.
- **삭제**: 마지막 하나는 삭제 불가(`ws_count <= 1`이면 `AppError::Validation`). 삭제는
  Tier 1 undo-on-delete 패턴(확인 모달이 아니라 목록에서 즉시 사라지고 ~5초 뒤 실제
  `workspace_delete` 커밋, 그 사이 Undo로 취소 가능). 활성 노트북을 지우면 낙관적으로 남은
  첫 노트북으로 즉시 전환한다. 백엔드 삭제는 그 노트북의 folders/notes/attachments를 FK
  CASCADE로 함께 지우고(`workspace_delete` 커맨드), tombstone 하나(`workspaces` 테이블)가
  그 캐스케이드 전체를 동기화 쪽에 암시한다(`docs/SYNC.md` §5 G2).
- **격리**: 다른 노트북의 노트는 절대 섞이지 않는다 — 조회는 전부
  `folders.workspace_id`로 필터링되는 쿼리를 탄다(대시보드 원칙, `docs/DASHBOARD.md` §4).

## 3. 데이터 모델

`workspaces` 테이블(내부 식별자, = 노트북):

| 컬럼 | 의미 |
|---|---|
| `id` | UUID |
| `name` | 노트북 이름 |
| `timeline_preset` | 연대 프리셋 오버라이드(`korea`/`france`/NULL=전역 폴백) |
| `bg_image_path` | 스위처 배경 이미지 상대경로(NULL=미설정) |
| `icon` | 아이콘 키(NULL=기본 그리드 아이콘) |

노트북에 속한 것: `folders`(FK `workspace_id`) → `notes` → `sections`/`sources`/`attachments`,
그리고 노트북 전역 커스터마이즈 `workspace_regions`/`workspace_eras`/`workspace_statuses`,
공간(`spaces`, `docs/DASHBOARD.md` §3.6). 활성 노트북 하나는 `settings` 테이블의
`active_workspace_id` 키(전역 설정, 노트북에 속하지 않음).

## 4. 핵심 코드 경로

| 영역 | 경로 |
|---|---|
| Rust 커맨드 | `src-tauri/src/commands/workspaces.rs` |
| Rust repo | `src-tauri/src/repo/workspaces.rs`(CRUD/배경/아이콘), `repo/folders.rs::active_workspace_id` |
| 프론트 스토어 | `src/stores/workspaces.ts` |
| 스위처 UI | `src/components/WorkspaceSwitcher.tsx`(데스크톱), `src/mobile/MobileWorkspaceSwitcher.tsx` |
| 커맨드 계약 | `specs/commands/workspaces.yaml` |
| 노트북 단위 export/import | `specs/commands/export.yaml::export_workspace_bundle`/`import_bundle`, `repo/transfer/export.rs::dump_workspace` |
| 대시보드와의 관계 | `docs/DASHBOARD.md` §0, §4 |

## 5. 알려진 한계 / 결정

- **총괄(전 노트북) 스코프는 없다** — 대시보드는 항상 노트북 하나만 본다. 근거와 재론 방지
  기록은 `docs/DASHBOARD.md` §5. 필요해지면 커맨드의 `workspace_id: Option<String>` 화로
  회수 가능하도록 짜여 있다.
- **DB 컬럼·커맨드·스토어 키는 여전히 `workspace*`**다 — 즉시 리네이밍하지 않는다
  (마이그레이션·동기화 호환성 비용, `docs/GLOSSARY.md` 코드 식별자 정책). 새로 만드는 코드만
  `notebook*`로 명명한다.
