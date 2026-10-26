# Brise 동기화 전략 (SSOT)

목적: 상업 판매를 전제로 한 다기기 동기화 전략. 옵션 비교 + 갭을 메우는 로드맵.
작성: 2026-07-29. 가격은 작성 시점 대략치 — 착수 전 재확인 필요.

---

## 1. 현재 상태 진단 (sync-readiness)

### 이미 갖춘 것 (운이 좋은 부분)
- **모든 PK가 UUIDv4 TEXT** — 기기 간 ID 충돌 없음. autoincrement였다면 전면 마이그레이션감이었다.
- **시각이 ISO8601 UTC TEXT** — 기기 간 비교 가능.
- **notes.updated_at + notes.deleted_at(소프트 삭제)** — LWW(last-write-wins)와 tombstone의 절반이 이미 있다.
- **첨부가 `data_dir/attachments/{note_id}/` 파일 + DB는 rel_path만** — blob 채널 분리가 이미 되어 있다.
  url 전용 kind(`link`/`internal`/`chart` — chart 는 시트 차트 라이브 참조 `"<section_id>#<chart_id>"`, V88)는 행만 오가고 파일 채널과 무관하다.

### 갭 (어떤 옵션을 택해도 메워야 하는 것)
| 갭 | 내용 |
|---|---|
| G1 | (2026-08-01 갱신) V24가 `sections/sources/tags/folders/workspaces`엔 이미 `updated_at`을 추가했다 — 아직 없는 건 `attachments`/`note_tags`와 V27 관계 테이블(`note_regions`/`note_related_exclusions`)뿐이다. `note_regions`는 소속 노트 `updated_at` touch로 우회(§8.1) |
| ~~G2~~ | ~~하드 삭제 경로 존재 (`note_purge`, 태그/첨부/region 삭제) → tombstone 없이 지워져 "삭제가 다른 기기에 전파 안 됨"~~ — **완료**(V24 `deleted_rows(tbl, id, deleted_at)` + `repo/tombstone.rs::record_tombstone`, purge/태그·첨부·region 삭제 경로 전부가 지금은 삭제 직전에 기록한다). 더 이상 갭이 아님 — §5 Phase 0 참고 |
| ~~G3~~ | ~~기기 식별자(device_id) 없음~~ — **완료**(`repo/settings.rs::ensure_device_id`, `db/mod.rs` 부트스트랩에서 최초 실행 시 생성). 더 이상 갭이 아님 — §5 Phase 0 참고 |
| ~~G4~~ | ~~첨부 파일이 내용 주소화(content hash) 안 됨~~ — **완료**(V24 `attachments.content_hash` + `repo/attachments.rs::backfill_content_hashes` 부팅 백필). 더 이상 갭이 아님 — §5 Phase 0 참고 |
| G5 | 계정/인증 개념 없음 (상업 판매 시 어차피 라이선스·결제에 필요) |
| G6 | `body_md` 통짜 텍스트 → 충돌 시 병합 단위가 "섹션 전체" (단일 사용자 다기기에선 conflict-copy 폴백으로 충분) |

**동기화 안 하는 것**: FTS5 인덱스 — 파생 데이터, 동기화 후 로컬 재빌드. (vectors/임베딩은 2026-07-29 서브시스템 전체 제거로 더 이상 해당 없음.)

---

## 2. 다른 앱들은 어떻게 하나

| 앱 | 방식 | 교훈 |
|---|---|---|
| Obsidian | 파일 볼트: 무료(사용자 iCloud/Dropbox) 또는 유료 Obsidian Sync($4~8/월, E2EE) | **동기화 = 구독 상품**. 앱은 사고 동기화는 구독하는 인디 표준 모델 |
| Joplin | 아이템 단위 파일 + 타임스탬프를 사용자 선택 백엔드(Dropbox/WebDAV/S3/Joplin Cloud)에 push/pull | 서버가 멍청해도(파일 저장소) 클라 로직만으로 동기화 성립 |
| Actual Budget | 뮤테이션마다 (entity, field, value, HLC시각) 메시지 → 서버는 append-only 릴레이, 클라가 필드 단위 LWW 병합 | 로컬 SQLite 앱의 자체 동기화 모범 답안. E2EE 가능 |
| Anki | 객체별 USN(update sequence number), 충돌 시 한쪽 전체 승리 + full-sync 폴백 | 단순해도 상업적으로 20년 버팀. 폴백 경로가 핵심 |
| Bear/Things | Apple CloudKit / 자체 서버 | 플랫폼 종속 대신 UX 완성도. Tauri엔 CloudKit 없음 |
| Notion/Linear | 온라인 우선 + 서버 권위, 로컬은 캐시 | 협업 앱의 길. 로컬 우선 정체성과 반대 방향 |

---

## 3. 옵션 비교 (저비용 → 강력)

### 옵션 0 — 백업/복원 (동기화 아님)
DB+첨부를 zip으로 내보내고 다른 기기에서 복원. 이미 export 인프라 일부 존재.
- 비용 **0** / 난이도 하 / 실시간성 없음, 병합 없음(통째 교체)
- 상업 v1의 바닥. 동기화 이전에 "내 데이터 안 잃음"부터 팔린다.

### 옵션 1 — 사용자 소유 스토리지 (Dropbox/iCloud 폴더, Syncthing, Tailscale)
- **금지**: SQLite DB 파일을 동기화 폴더에 직접 두기 — `-wal` 부분 동기화로 손상, conflict copy 지옥.
- **올바른 형태**: 아이템 단위 파일(Joplin식)이나 스냅샷을 동기화 폴더에 export, 열 때 병합.
- 비용 **0**(사용자가 스토리지 지참) / 프라이버시 우수 / 계정 불필요
- 단점: 실시간 없음, 모바일 어려움, "내 Dropbox가 이상해요" 지원 부담, 상용 제품 느낌 아님. Tailscale 연동은 이 계열의 파워유저 버전 — **판매용 기본 경로로는 부적합**.

### 옵션 2 — 멍청한 클라우드 저장소 + 클라 동기화 로직 (Joplin/Actual 모델) ★추천 경로
서버는 blob 저장소(Cloudflare R2 등)뿐. 클라이언트가 행 단위 변경분(+tombstone)을 타임스탬프로 push/pull, LWW 병합. 인증은 소형 Worker 하나(가입/토큰/presigned URL).
- 비용: R2 ~$0.015/GB·월 + egress 무료. **유저 1인당 월 수십 원 수준** → 구독 마진 최고
- E2EE 가능(업로드 전 클라 암호화) → 프라이버시를 셀링포인트로
- 서버가 stateful하지 않아 운영 부담 최소. 폴링 기반(실시간 아님 — 노트 앱엔 보통 충분)
- 단점: 동기화 알고리즘(LWW+tombstone+재시도)을 우리가 소유. 데이터 손실 버그는 우리 책임
- Brise 적합도: **높음**. Rust repo 계층이 이미 모든 쓰기를 중개하므로 변경 추적을 끼워 넣을 자리가 명확

### 옵션 3 — 오프라인 우선 동기화 엔진 SaaS
| 서비스 | 모양 | 비고 |
|---|---|---|
| PowerSync | 서버 Postgres = 권위, 클라 SQLite 복제. 쓰기는 우리 API 경유 | Rust/JS/모바일 SDK. 셀프호스트 가능. 클라우드 ~$49/월~ |
| Turso (libSQL) | 유저당 DB 하나, embedded replica + offline sync | SQLite 네이티브라 이식 마찰 최소. offline write 충돌 처리는 아직 성숙 중 |
| ElectricSQL | Postgres→클라 read-path 동기화, 쓰기는 우리 API | 쓰기 경로 DIY |
| Zero/Jazz/InstantDB 등 | TS/웹 우선 신생 엔진 | React 쪽엔 붙지만 Rust/SQLite repo 계층과 이중 진실이 됨 — 부적합 |
- 비용: 무료 티어 → $30~50/월 + 사용량 / 실시간·멀티디바이스가 "그냥 됨"
- 단점: 벤더 종속, E2EE 대부분 불가(서버가 평문 봄), **앱 데이터 계층을 엔진 중심으로 재구조화하는 이행 비용이 진짜 비용**
- 적합 시점: 실시간 협업·웹 뷰어가 로드맵에 오르는 순간

### 옵션 4 — BaaS 온라인 우선 (Supabase/Firebase)
진실의 원천을 클라우드로 이전, 로컬 SQLite는 캐시로 격하.
- Supabase $25/월~: 인증+실시간+스토리지+RLS 풀패키지
- 단점: **로컬 우선 정체성 포기** — 오프라인이 다시 어려운 문제가 됨. FTS5/벡터 등 로컬 자산 재설계
- 적합 시점: 제품이 "개인 로컬 노트"가 아니라 "웹 포함 멀티플랫폼 SaaS"로 피벗할 때만

### 옵션 5 — 자체 동기화 서버 (Actual/Anki/Things의 완성형)
oplog(HLC 타임스탬프 메시지) + 릴레이 서버 + 스냅샷. 옵션 2의 진화형 — 저장소가 멍청한 blob에서 전용 서버로 바뀌고 websocket 푸시·선택적 동기화·계정 관리가 붙는다.
- 비용: VPS $5~20/월로 수천 유저 / 마진·통제력·E2EE 모두 최고
- 단점: 엔지니어링 비용 최대(수 주), 동기화 버그의 무한 책임. cr-sqlite(SQLite CRDT 확장)로 병합 수학을 위임하는 지름길이 있으나 프로젝트 유지보수 활력 확인 필요
- 적합 시점: 옵션 2가 상업적으로 검증된 뒤의 업그레이드

### 비교 요약
| | 월 운영비 | 구현 난이도 | 실시간 | E2EE | 상업성 |
|---|---|---|---|---|---|
| 0 백업 | 0 | 하 | ✗ | 가능 | 바닥 다지기 |
| 1 사용자 스토리지 | 0 | 중 | ✗ | 가능 | 파워유저용 |
| 2 blob+클라 로직 | ~$5 고정+GB당 센트 | 중상 | 폴링 | **가능** | **구독 앵커, 마진 최고** |
| 3 동기화 엔진 SaaS | $30~50+사용량 | 중(이행비용 大) | ✓ | ✗ | 빠른 출시, 종속 |
| 4 BaaS 온라인 | $25~ | 중 | ✓ | ✗ | 정체성 전환 시만 |
| 5 자체 서버 | $5~20 | 상 | ✓ | 가능 | 완성형, 최후 단계 |

---

## 4. 결정 프레임

핵심 질문은 하나: **"두 기기에서 동시에 편집하는가, 아니면 번갈아 쓰는가?"**
- 번갈아 씀(개인 노트 앱의 95%) → 행 단위 LWW + conflict-copy 폴백이면 충분. 옵션 2로 직행. CRDT 텍스트 병합(Loro/Automerge)은 YAGNI.
- 동시 편집/협업이 제품 비전 → 옵션 3 또는 5 + CRDT. 지금 결정할 필요 없음 — Phase 0은 어느 길이든 동일.

비즈니스 모델 참고: 앱 일회 구매 + 동기화 구독(Obsidian Sync $4/월이 시장 기준가)이 검증된 인디 모델. 옵션 2의 원가(유저당 수십 원)가 이 가격에서 마진이 가장 크다.

---

## 5. 로드맵

### Phase 0 — 동기화 준비 (완료, 2026-08-01 — 서버 0원, 어떤 옵션이든 선행 필수)
1. **G1**: 모든 사용자 데이터 테이블에 `updated_at` 추가, repo 계층 쓰기 경로에서 일괄 갱신 —
   ✅ 완료 (V24: `sections/sources/tags/folders/workspaces`. 잔여 세부사항은 §1 G1 표 참고 —
   `attachments`/`note_tags`/V27 관계 테이블은 여전히 자체 `updated_at`이 없지만 tombstone +
   부모 노트 touch로 갈음)
2. **G2**: 범용 tombstone — 하드 삭제를 `deleted` 마킹으로 전환하거나 `deleted_rows(table, id, deleted_at)` 한 테이블. purge는 "tombstone 남기고 본체 삭제"로 재정의 —
   ✅ 완료 (`deleted_rows`, V24, `repo/tombstone.rs::record_tombstone`)
3. **G3**: `settings`에 `device_id`(UUID, 최초 실행 시 생성) —
   ✅ 완료 (`repo/settings.rs::ensure_device_id`, `db/mod.rs` 부트스트랩에서 호출)
4. **G4**: 첨부 저장 시 SHA-256 계산·저장 (`attachments.content_hash` 컬럼) —
   ✅ 완료 (V24 컬럼 + 신규 쓰기 경로 즉시 계산 + `backfill_content_hashes` 부팅 백필)
5. 백업/복원 완성: DB+첨부 zip export/import 왕복 검증 (옵션 0 완성 = 판매 가능한 안전망) —
   ✅ 완료 (`repo/transfer/backup.rs` 왕복/zip-slip/버전거부 유닛 테스트)
- 산출물: "이 DB는 언제든 동기화에 편입 가능" 상태 — 달성. 되돌릴 일 없는 무후회 투자.

### Phase 1 — 클라우드 백업 (첫 유료 기능, 운영비 ~$5/월)
1. R2 버킷 + 인증 Worker(가입/로그인/presigned URL) — G5 해결
2. 클라 암호화(E2EE) 후 스냅샷 업로드, 다른 기기에서 복원
3. UI: "마지막 백업 시각", 수동+자동(종료 시) 백업
- 아직 병합 없음(최신 스냅샷 교체). 그래도 "폰→PC 옮기기, 기기 분실 복구"가 팔린다.

### Phase 2 — 진짜 동기화 (옵션 2 본체)
1. 행 단위 push/pull: `updated_at > last_sync` 변경분 + tombstone 업로드, 다운로드 후 LWW 병합
2. 충돌 시 conflict-copy(섹션 사본 생성 + 사용자 알림) — Obsidian 방식
3. 첨부는 content_hash 기준 diff 업로드/다운로드
4. 동기화 후 FTS/벡터 로컬 재색인 트리거
5. Anki식 안전망: 병합 불능 시 full-sync(스냅샷 교체) 폴백
- 결정 게이트: 이 시점에 실시간 요구가 검증되면 옵션 3(PowerSync) 이행을 재평가 — Phase 0/1 자산은 그대로 유효

### Phase 3 — 확장 (수요 검증 후)
- websocket 푸시(자체 서버=옵션 5로 승격 또는 엔진 SaaS), 선택적 동기화, 웹 뷰어, 협업(CRDT)
- 지금 설계하지 않는다. Phase 2까지의 데이터 모델(UUID+updated_at+tombstone+oplog화 가능한 repo 계층)이 어느 방향으로든 호환.

---

## 6. 공통 원칙 (어떤 옵션이든)
- 파생 데이터(FTS5)는 절대 동기화하지 않는다 — 로컬 재빌드
- SQLite 파일 자체를 네트워크/동기화 폴더에 노출하지 않는다
- 모든 동기화 쓰기는 repo 계층 단일 경로 경유 (변경 추적 누락 방지)
- 스키마 버전(`user_version`)이 다른 기기 간 동기화는 거부 — 앱 업데이트 유도
- 삭제는 전파되어야 한다: tombstone 없는 삭제는 "부활 버그"가 된다

---

## 7. 전송 계층 결정 (2026-07-29) — Tailscale, 스냅샷 pull부터

첫 위성 클라이언트(모바일 웹 뷰어, `docs/CLIENT-RULES.md` 참고)를 계기로 전송 계층을 확정한다.
아래는 §3 옵션 비교의 "판매용 기본 경로로는 부적합" 평가를 뒤집는 게 아니라 그와 별개인
결정이다 — Tailscale은 여기서 상업용 동기화 상품(옵션 2/5)의 기반이 아니라, 오너 본인이 이미
가진 tailnet 위에서 오너 자신의 기기끼리 붙는 **1인용 전송 계층**으로 채택한다.

- **결정: TLS/NAT 통과는 Tailscale에 위임한다.** 서버(데스크톱 앱 내장 HTTP)는 자체 TLS를
  구현하지 않고, tailnet(CGNAT `100.64.0.0/10`) 또는 localhost에만 바인딩한다. 인증서 발급·갱신,
  방화벽 통과, 기기 간 라우팅을 전부 Tailscale이 대신한다 — 이 결정이 없었다면 옵션 0(백업/복원)
  다음 단계로 자체 TLS 서버를 만들어야 했을 것이다.
- **결정: 데스크톱 앱 내장 HTTP 서버("동기화 beta")로 스냅샷 pull 방식부터 시작한다.** 첫
  구현은 §5 옵션 2의 "행 단위 push/pull + LWW"가 아니라, 훨씬 단순한 "클라이언트가 서버의 현재
  상태를 읽기만 한다"(스냅샷 pull). **갱신(2026-07-30): 모바일 클라이언트는 더 이상 읽기
  전용이 아니다** — 노트 생성/수정은 `POST /api/v1/invoke`(`note_create`/`note_update`/
  `section_update`), 체크리스트 토글과 첨부 업로드는 전용 REST가 이미 배포됐다("단일 소유자
  쓰기 베타"). `POST /api/v1/notes` · `PUT /api/v1/notes/{id}` · `GET /api/v1/notes/{id}`
  REST CRUD는 없다. 아직 없는 것은 진짜 다기기 동시-쓰기의 충돌 병합(§5 옵션 2의 행 단위
  push/pull + LWW 본체)이다 — 정확한 쓰기 규칙·현재 구현의 갭은 `docs/CLIENT-RULES.md`
  §4/§7.3(SSOT)을 참고. (2026-08-26 갱신: 이 HTTP 서버의 2번째 소비자 = 외부 접근 CLI `brise`.
  모바일 웹과 동일하게 `POST /api/v1/invoke`를 사용하여 147개 커맨드를 실행하며, 상세는 `docs/CLI.md` 참고.)
- **로드맵은 그대로다.** 양방향 LWW 동기화는 §3 옵션 2("멍청한 클라우드 저장소 + 클라 동기화
  로직") 경로를 계속 추천 경로로 유지한다 — Tailscale 서버는 그 경로의 "클라우드 blob"을
  "오너의 다른 기기"로 좁힌 축소판이지, 경로 자체를 대체하지 않는다. §5 Phase 2(행 단위
  push/pull + LWW + tombstone)가 여전히 다음 목표다.
- **클라이언트 계약은 별도 문서로 분리했다.** API 하위호환·버전 협상·쓰기 규칙(LWW/tombstone/
  device_id/원자성)·보안·태그 병합 등 클라이언트가 지켜야 할 정확한 규칙은
  **`docs/CLIENT-RULES.md`**(SSOT)를 참고 — 이 문서(SYNC.md)는 "왜 이 경로를 택했나"에 집중하고,
  "무엇을 지켜야 하나"는 그쪽이 담당한다.

---

## 8. Wave 4 테이블 동기화 규칙 (2026-07-31) — note_regions / note_related_exclusions

V27 이 추가한 두 INSERT+DELETE 전용 테이블. G2 범용 tombstone(`deleted_rows(tbl, id,
deleted_at)`)이 삭제 전파를 커버한다 — UPDATE 경로가 없으므로 행 단위 `updated_at` 없이도
"살아 있는 행 + 삭제 tombstone" 로 동기화 가능하다.

### 8.1 `note_regions` (다중 경유지)

| 항목 | 규칙 |
|---|---|
| PK | 단일 UUID (`id`) |
| INSERT | 동기화 대상 — 행 전체를 push. `repo/notes.rs::region_add` 가 **같은 트랜잭션**에서 소속 노트의 `notes.updated_at` 도 갱신(잔여 리스크 3 수정, 2026-07-31) |
| DELETE | `repo/notes.rs::region_remove` 가 **같은 트랜잭션**에서 `record_tombstone(tx, "note_regions", id)` + 소속 노트 `notes.updated_at` 갱신 |
| REORDER | `position` 만 UPDATE — Phase 0 G1 이 아직 이 테이블 자체에 `updated_at` 을 넣지 않았으므로, 재정렬은 행 단위 LWW 대상이 아니다. 대신 `repo/notes.rs::region_reorder` 가 **같은 트랜잭션**에서 소속 노트의 `notes.updated_at` 을 갱신한다(잔여 리스크 3 수정) — G1 규칙(자식 행 변경 → 부모 노트 touch, sections/tags 와 동일 패턴)과 맞춘 것. |
| CASCADE | 노트 purge 시 FK CASCADE 로 자식 행 삭제 — 부모 `notes` tombstone 이 자식을 암시(§`repo/tombstone.rs` 캐스케이드 규칙). 개별 경유지 삭제만 명시 tombstone. |
| 대표 지역 | `notes.region` + `notes.lat/lng` 는 노트 행 LWW 로 이미 동기화. 경유지는 `note_regions` 만. |
| 번들 왕복 (2026-08-01) | `repo/transfer/export.rs::NoteRegionRow` / `import.rs::insert_note_region` — 소속 노트별로 export(`dump`/`dump_folder`), import 는 sections/sources/attachments 와 동일하게 신규 노트의 자식으로만 삽입(플레인 INSERT, id 리매핑 없음). `Bundle.note_regions`는 `#[serde(default)]`로 구 번들도 빈 배열로 파싱 |

**요약 (INSERT/DELETE/REORDER 세 경로 모두)**: `note_regions` 행 자체는 여전히 `updated_at` 이
없어 "이 경유지 하나가 언제 바뀌었나"는 행 단위로 알 수 없다 — 대신 세 경로 모두 소속 노트의
`notes.updated_at` 을 같이 올려, LWW 가 최소한 "이 노트에 뭔가 바뀌었다"는 신호는 받게 한다.
삭제만 `deleted_rows` tombstone 으로 개별 행 단위 전파가 가능하고(§8 서두 규칙), 추가·재정렬은
노트 단위 신호에 얹혀 간다 — Phase 2 동기화가 노트의 `updated_at` 이 전진한 것을 보면 그 노트의
`note_regions` 전체를 다시 확인/재전송하는 식으로 이 갭을 메울 수 있다. G1 을 `note_regions` 까지
확장해 행 자체에 `updated_at` 을 붙이면 이 우회가 필요 없어진다.

### 8.2 `note_related_exclusions` (자동 연관 해제 목록)

| 항목 | 규칙 |
|---|---|
| PK | **복합** `(id_1, id_2)` — 양방향 정규화(`min(id_a,id_b), max(...)`) |
| INSERT | 동기화 대상 — 사용자가 의도적으로 숨긴 쌍이므로 기기 간 공유해야 UX 가 일치한다 |
| DELETE | `related_restore` 가 쌍을 지울 때 tombstone |
| 번들 왕복 (2026-08-01) | `repo/transfer/export.rs::NoteRelatedExclusionRow` / `import.rs::insert_note_related_exclusion`. 두 노트 중 하나만 폴더 스코프 번들에 포함돼도(export.rs::dump_folder) 안전 — import 는 `INSERT OR IGNORE`라 FK 위반(반대편 노트가 로컬에 없음)이면 조용히 스킵, 이미 존재하는 쌍(PK 충돌)도 그대로 흡수. id 리매핑 없음(양쪽 다 note id 그대로, tags 처럼 이름 충돌로 재매핑할 별도 정체성이 없음) |

#### Tombstone id 결정: **(a) synthetic composite id**

`record_tombstone(tbl, id)` 는 단일 문자열 id 만 받는다. 복합 PK 를 스키마 변경으로 단일
UUID 로 바꾸는 방안도 검토했으나:

1. **V27 은 이미 배포된 개발 DB 에 적용됐을 수 있다** — PK 재작성은 V28 마이그레이션 + 데이터
   이관이 필요하고, tombstone 만 위해 스키마를 흔들 가치는 없다.
2. **이미 같은 패턴이 있다** — `note_tags` 는 복합 관계이지만 tombstone id 를
   `"{note_id}:{tag_id}"` 로 합성한다(`repo/notes.rs::replace_note_tags`).
3. **(b) device-local 제외** 는 "한 기기에서 숨긴 연관이 다른 기기에서 다시 뜨는" 부활 UX 를
   만든다. 연관 해제는 의도적 사용자 데이터이므로 동기화 대상이어야 한다.

**채택 (a)**: tombstone id = `"{id_1}:{id_2}"` (이미 저장 시 정렬된 min:max 순서).
스키마/PK 변경 없음. 삭제 경로:

- `related_restore(note_id)` — 해당 노트가 속한 모든 쌍을 SELECT 한 뒤 각 쌍을 DELETE +
  `record_tombstone("note_related_exclusions", "{id_1}:{id_2}")` (같은 트랜잭션).

재생성(같은 쌍을 다시 exclude) 시 살아 있는 행이 tombstone 보다 우선하는 것은 Phase 2 LWW
규칙이 담당 — Phase 0 은 "삭제가 전파될 재료" 만 남긴다.

### 8.3 `notes.remind` (V30, 2026-08-01)

| 항목 | 규칙 |
|---|---|
| 종류 | `notes` 위의 컬럼(`INTEGER NOT NULL DEFAULT 0`) — 별도 테이블/행 아님 |
| 전파 | 새 테이블 규칙 불필요 — `notes` 행 자체가 이미 G1 LWW 대상(`updated_at`)이므로 그 위에 얹힌다 |
| 삭제 | 별도 tombstone 없음 — 노트 자체가 지워질 때의 `notes` tombstone 하나로 암시(캐스케이드 규칙과 동일 논리) |
| 쓰기 경로 | `repo::notes::update`(`note_update` 커맨드, `remind: Option<bool>`) — 다른 필드와 같은 UPDATE 문에서 함께 `updated_at` bump |
| 번들 왕복 | `repo/transfer/export.rs::NoteRow.remind` / `import.rs::insert_note` — export/import 양쪽 SELECT·INSERT 에 포함(`#[serde(default)]`로 구 번들도 0 으로 파싱) |
| 모바일 피드 | `sync_server::handlers::NoteListItem` 은 의도적으로 미노출 — 모바일 종료일 입력 UI 결정 전까지 보류(docs/DASHBOARD.md §2) |

### 8.4 `notes.end_year`/`end_month`/`end_day` (V28/V29, 2026-08-01) — 사건 축 기간 종료

| 항목 | 규칙 |
|---|---|
| 종류 | `notes` 위의 세 컬럼(`INTEGER NULL`, `month`/`day`와 동일한 정밀도 인코딩) — 별도 테이블/행 아님 |
| 이력 | V28 이 `due_at`(마감 축)과 함께 신설. V29(같은 날)가 `due_at`을 이 트리플로 흡수한 뒤 컬럼째 DROP — 지금은 `end_*` 세 컬럼만 존재하고 `due_at`은 스키마에서 완전히 사라졌다(db/migrations.rs V28_SQL/V29_SQL 히스토리 주석 참고). 동기화 규칙은 오직 이 최종 상태(`end_*`)만 대상 — `due_at`은 동기화 대상이었던 적이 없다(V28~V29 사이 짧게 존재했지만 그 구간의 배포 빌드가 없다) |
| 전파 | 새 테이블 규칙 불필요 — `notes` 행 자체가 이미 G1 LWW 대상(`updated_at`)이므로 그 위에 얹힌다(§8.3 `remind`와 동일 논리) |
| 삭제 | 별도 tombstone 없음 — 노트 자체가 지워질 때의 `notes` tombstone 하나로 암시 |
| 쓰기 경로 | `repo::notes::dates::date_update`(`note_date_update` 커맨드, 2026-09-08 재설계) — 진실은 `note_dates` position 0 행이고 `notes.*` 는 그 투영이다(`project_primary`). start ≤ end 불변식은 그대로 앱 레벨에서 강제 후 `updated_at` bump |
| 번들 왕복 | `repo/transfer/export.rs::NoteRow.end_year/end_month/end_day` / `import.rs::insert_note` — export/import 양쪽 SELECT·INSERT 에 포함(`#[serde(default)]`로 구 번들도 `None`으로 파싱). Sync audit P1 fix(2026-08-01) 전까지는 컬럼만 있고 번들에는 빠져 있어 export→import 왕복 시 조용히 사라졌었다 — `icon`/`lat`/`lng`(더 오래된 V11/V17 컬럼)도 같은 fix 로 같이 채워짐 |

새 테이블도, 새 tombstone 규칙도 필요 없었다 — `notes` 행이 이미 갖춘 LWW/번들 배관에
컬럼 하나를 더 얹은 것뿐이라는 점이 다른 §8 항목들과의 차이.

### 8.5 `note_dates` (V76, PLAN-2026-09-08-dates-rebuild.md — SSOT는 `docs/NOTES.md` §2.6b)

> **2026-09-08 재설계로 이 절이 갱신됐다.** 아래는 V70~V75(GRILL-2026-09-07 D2/D3/D4) 시절의
> 모양이다 — 지금은 전부 틀렸다: `position` 개념이 생겼고(0=대표/사건 축, 1..=관련), 모든 행이
> 시각·알림·반복을 갖고, `notes.year/month/day/end_*/remind/start_time/end_time/
> remind_offset_min/rrule` 은 이제 그 자체가 진실이 아니라 position=0 행의 **투영**이다(진실은
> `note_dates`, 갱신은 `repo::notes::dates::project_primary` 하나뿐). 감사(2026-09-08)로 남긴다:
> 옛 서술 그대로 두면 "note_dates 엔 날짜만 있다"·"position 없음" 이 사실과 반대로 읽힌다.

| 항목 | 규칙 |
|---|---|
| PK | 단일 UUID (`id`) — 변화 없음 |
| 형태 | `note_regions`(§8.1)의 형제 그대로지만, 이제 `position` 이 있다(0=사건 축/대표, 1..=관련 날짜, `date_make_primary` 가 두 position 을 교환). 대표와 관련 사이에 컬럼 차이가 없다 — 정밀도 사다리(연→월→일→시:분)·기간·알림·반복을 어느 행이나 다 갖는다 |
| INSERT/UPDATE | 동기화 대상 — 행 전체를 push. `date_add`/`date_update`/`date_make_primary`/`date_reorder` 전부 **같은 트랜잭션**에서 `project_primary(tx, note_id)` 를 부르고, 그 함수가 소속 노트의 `notes.updated_at` 도 함께 갱신한다(§8.1 과 동일 우회 — `note_dates` 자체엔 여전히 `updated_at` 이 없다) |
| DELETE | `repo/notes/dates.rs::date_remove` 가 **같은 트랜잭션**에서 `record_tombstone(tx, "note_dates", id)` + 소속 노트 `notes.updated_at` 갱신. position=0 행은 삭제 불가(축은 NOT NULL) — "초기화"는 정밀도를 연도로 되돌리는 UPDATE 이지 DELETE 가 아니다 |
| CASCADE | 노트 purge 시 FK CASCADE 로 자식 행 삭제 — 부모 `notes` tombstone 이 자식을 암시. 개별 날짜 삭제만 명시 tombstone |
| 판정 규칙(D3 폐기) | 옛 "판정은 대표만 본다"는 폐기됐다 — 발화는 **시작일**, 미처리는 **종료일**(없으면 시작일), 어느 행이든 `remind=1` 이면 후보다(`repo::schedule::candidates`가 `note_dates` 를 직접 훑는다, 대표/관련 구분 없음). 완료(✓)는 그 행의 `remind` 를 끄는 것 |
| 사건 축(D4 갱신) | `notes.year/month/day` 는 여전히 "그 노트가 언제의 일인가"의 유일한 답(연대 필터·타임라인·그래프가 보는 축)이지만, 이제 그 컬럼 자체가 진실이 아니라 **position=0 행의 사본**이다 — `notes.*` 를 직접 UPDATE 하면 다음 `project_primary` 호출(다른 날짜 mutation)이 조용히 되돌린다. 타임라인/그래프/연대 필터가 `note_dates` 를 조인하지 않는 것은 여전히 사실(투영만 읽는다) |
| 번들 왕복 | `repo/transfer/bundle.rs::NoteDateRow` — `year/month/day/end_*/start_time/end_time/remind/remind_offset_min/rrule/position` 전부 `#[serde(default)]` 로 확장. 옛 번들(v75 이전, `date`/`end_date` 문자열·position 없음)은 `year.is_some()` 분기로 `import/mod.rs::insert_note_date` 가 그 자리에서 트리플로 변환한다(§`repo/transfer/bundle.rs` 헤더 주석). `add_notebook`/`replace_merge` 는 항상 새 자식 행으로 삽입(포지션 포함 그대로)이라 드리프트가 없고, `hash_merge` 의 "제자리 갱신" 분기(`update_note_in_place`, title 매치 + 본문 해시 다름)는 **2026-09-08 감사에서 발견 — position=0 행을 안 건드리고 `notes.*` 만 갈아치우던 결함을 수정**(다음 날짜 mutation 이 되돌렸다). 지금은 `note_dates` 부터 UPDATE 하고 `project_primary` 를 부른다(회귀 테스트: `hash_merge_update_existing_primary_date_survives_later_date_mutation`) |
| 달력 표시 | `dashboard_calendar`가 그 달에 걸리는 관련 날짜(position!=0)를 `CalendarItem.kind="extra"`로 낸다 — title은 소속 노트의 제목 |
| sync_server(HTTP RPC) | `src-tauri/src/sync_server/dispatch.gen.rs` 는 `specs/commands/*.yaml` 에서 코드생성되므로 행 커맨드 다섯(`note_date_add`/`note_date_update`/`note_date_remove`/`note_date_reorder`/`note_date_make_primary`) + `note_dates_list` 가 이미 자동으로 실려 있다. 옛 여섯 커맨드(§`docs/NOTES.md` §2.6b)를 부르는 **구버전 클라이언트**(모바일)는 dispatch 의 매치에 arm 이 없어 `DispatchError::UnknownCommand` 로 안전하게 거부된다(패닉·크래시 없음) — 다만 그 클라이언트는 날짜/알림을 더 이상 편집할 수 없으니 업데이트가 필요하다는 사용자 안내는 별도다 |

### 8.6 `notes.archived_at` (V36, W7-f 아카이브) — 리그레션(데이터 손실 P0, 2026-09-19 리뷰어 확인)

| 항목 | 규칙 |
|---|---|
| 종류 | `notes` 위의 컬럼(`TEXT NULL`, ISO8601) — 별도 테이블/행 아님. NULL=보임, NOT NULL=아카이브 시각 |
| 전파 | 새 테이블 규칙 불필요 — `notes` 행 자체가 이미 G1 LWW 대상(`updated_at`)이므로 그 위에 얹힌다(§8.3 `remind`와 동일 논리) |
| 삭제 | 별도 tombstone 없음 — 노트 자체가 지워질 때의 `notes` tombstone 하나로 암시 |
| 쓰기 경로 | `repo::notes::archive`/`unarchive`(`note_archive`/`note_unarchive` 커맨드) |
| 번들 왕복 | 이 절을 쓰게 만든 버그 그 자체: V36(2026-08 도입)부터 이 수정 전까지 `bundle.rs::NoteRow`에 필드 자체가 없어 `export.rs`의 세 SELECT(`dump_folder`/`dump_workspace`/`dump`) 모두 `archived_at`을 담지 않았다. `deleted_at IS NULL` 필터만 있고 `archived_at`은 의도적으로 필터링하지 않으므로(아카이브는 "숨김"이지 "제외"가 아니다 — dump 는 아카이브 노트를 계속 포함해야 맞다) 아카이브 노트도 번들에는 실렸지만, 컬럼 자체가 없어 `import/mod.rs::insert_note`가 항상 `archived_at=NULL`로 심었다 — `add_notebook`/`duplicate_notebook`(같은 경로 재사용)/`replace`/`merge`/`hash_merge` 다섯 경로 전부에서 아카이브가 조용히 풀리는 데이터 손실이었다(§8.3 `remind`·§8.4 `end_*`/`icon`/`lat`/`lng`가 겪은 것과 같은 계열의 누락). `#[serde(default)]`로 이 필드가 없는 구버전 번들도 `None`(=미아카이브, 버그 이전과 동일한 겉보기 동작)으로 파싱된다 |
| `hash_merge` 제자리 갱신 규칙 | `update_note_in_place`는 `is_favorite`/`status`와 같은 규칙을 따른다 — **번들 쪽 값이 로컬 값을 조건 없이 덮어쓴다**(양방향: 로컬만 아카이브였으면 풀리고, 번들만 아카이브였으면 로컬이 아카이브된다). `deleted_at`은 이 규칙의 대상이 아니다 — 애초에 번들에 실리지 않고, 휴지통에 있는 로컬 노트는 `title_to_id` 스캔의 `deleted_at IS NULL` 필터로 매치 대상에서 아예 빠진다(값 병합이 아니라 스코프 제외). 회귀 테스트: `hash_merge_update_existing_adopts_incoming_archived_state` / `hash_merge_update_existing_unarchives_when_incoming_is_not_archived`(양방향 각각) |
