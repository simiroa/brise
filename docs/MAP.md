# 지도 (Map)

노트를 지리 좌표에 꽂아 보는 지도 도메인. 대시보드 지도 탭·좌측 사이드바 지도·공간(Space)
위젯·노트 편집 중 지역 첨부까지 같은 지도 컴포넌트를 공유한다. 카탈로그/검증 SSOT는
`specs/features/map.yaml`(105줄) — 세부 결정은 코드가 사실상의 SSOT라고 그 문서가 명시한다.

## 1. 기능 개요

- **대시보드 지도 탭**(`docs/DASHBOARD.md` §3.5): 내 노트 마커들의 bounding box에 맞춰
  기본으로 열림. 좌상단 장소 검색, 빈 지점 클릭/마커 클릭으로 새 노트 생성, 마커 클릭 시
  하단 필름스트립(선택 노트 + 최근접 N개, 카드→카드 탐색).
- **좌측 사이드바 지도**·`RegionFilter`·`RegionPickerDialog`·노트 프리뷰의 `RegionPreview` —
  같은 지도 컴포넌트를 더 작은 자리에서 재사용.
- **공간(Space) 위젯**: `NoteMapWidget`(노트 위치 미니맵) · `VisitedRegionsWidget`(방문
  국가/지역 채우기 지도) — 둘 다 항상 SVG(`WorldMap`) 경로만 쓴다(위젯 캔버스 안에서 온라인
  타일까지 띄우지 않는다).

## 2. 동작 방식

- **렌더러 이중화**(`WorldMapAuto.tsx`): 온라인이면 [MapLibre GL](https://maplibre.org/)
  (`maplibre-gl`, 온라인 벡터 타일)을 `WorldMapGL.tsx`로 지연 로드해서 그린다. 오프라인이거나
  MapLibre의 `error` 이벤트(스타일/타일/스프라이트 로드 실패)가 뜨면 그 세션 동안
  [d3-geo](https://github.com/d3/d3-geo) + [world-atlas](https://github.com/topojson/world-atlas)
  기반 자작 SVG 지도(`WorldMap.tsx`)로 영구 폴백한다 — GL↔SVG를 오가며 카메라가 튀는 것이
  거친 지도보다 나쁘다는 판단. 호출부는 어느 쪽이 렌더되는지 몰라도 된다(props는
  `WorldMapProps`로 동일).
  - `WorldMap.tsx`는 `world-atlas`의 110m/50m/10m 국경 토폴로지를 줌 레벨(`currentZoom`)에
    따라 단계적으로 지연 import하고(LOD), Admin-1(시/도 경계)은 뷰포트가 걸친 경도 밴드만
    로드한다. 항상 "로드된 것 중 가장 정밀한 티어"를 그려 중간에 빈 초록 화면이 뜨지 않는다.
- **팬/줌 클램프**(`geometry.ts::minCoverZoom`/`clampMapTransform`): `geoMercator` 기본 투영은
  가로 변 기준 정사각형이라 세로가 넓은 창에서는 위아래 여백이 드러날 수 있다 — 화면비를
  반영해 줌 하한과 x/y 팬 한계를 계산해 모든 transform 생성·드래그·휠 줌 경로에 적용한다.
- **휠 규약 (2026-09-08)**: 가로 휠 = 팬 · **Ctrl/Cmd+휠 = 커서 기준 줌** · 맨 세로 휠은 소비하지
  않는다(설정의 지도 미리보기를 품은 스크롤 컨테이너가 대신 스크롤된다). 대시보드 타임라인·이미지
  미리보기와 같은 규약 — 근거와 사고 이력은 `docs/DASHBOARD.md` §3.4.
  생성 확정 등 어떤 상호작용도 지도의 배율/중심을 스스로 움직이지 않는다(뷰포트 불변 원칙).
- **장소 검색/역지오코딩**: `geocode_search`/`geocode_reverse` 커맨드가 Nominatim
  (OpenStreetMap) API를 Rust에서 호출한다. 검색 결과 클릭 → 카메라가 그 좌표로 fly-to +
  임시 핀 → 확인/취소 팝오버(`MapCreatePopover.tsx`) → 확정 시 `note_create`(lat/lng 프리필).
- **노트-지역 연결**: 두 축이 있다.
  1. `notes.lat`/`notes.lng`(+ `notes.region` 라벨) — 노트 하나의 **대표 좌표** 한 점.
  2. `note_regions` 테이블 — 노트 하나에 **여러 경유지**(waypoint)를 순서 있게 붙일 수 있다.
     지도에서는 대표와 다른 색 마커 + 경로선으로 표시(`note_regions_list`). 첫 추가 장소가
     자동으로 대표가 되고, 경유지 중 하나를 대표로 승격할 수도 있다(`docs/DASHBOARD.md` §2).
- **드래그/이동**: 노트를 지도에 드롭하거나 기존 마커를 옮기면 `note_set_location`으로
  좌표를 쓴다.
- **필터**: 대시보드 검색은 마커를 지우지 않고 매치되지 않는 마커를 그 자리에서 dim 처리한다.
  사이드바 `RegionFilter`는 태그/상태 축과 함께 bbox 쿼리(`note_query`)로 마커를 좁힌다.

## 3. 데이터 모델

| 컬럼/테이블 | 의미 |
|---|---|
| `notes.lat`/`notes.lng` | 대표 좌표(REAL, -90..90 / -180..180 CHECK), NULL=미설정 |
| `notes.region` | 대표 좌표의 지명 라벨(자유 텍스트, 역지오코딩으로 자동 채움 가능) |
| `note_regions` | 노트당 다중 경유지 — `lat`/`lng`(NOT NULL) + 순서(`position`) + 대표 플래그 |

`note_regions`는 자체 `updated_at`이 없다 — INSERT/DELETE/REORDER 세 경로 모두 같은
트랜잭션에서 소속 노트의 `notes.updated_at`을 함께 갱신해 동기화 LWW 신호를 대신한다
(`docs/SYNC.md` §8.1).

## 4. 핵심 코드 경로

| 영역 | 경로 |
|---|---|
| 렌더러 스위치 | `src/components/map/WorldMapAuto.tsx` |
| GL 렌더러 | `src/components/map/WorldMapGL.tsx`(maplibre-gl) |
| SVG 렌더러 | `src/components/map/WorldMap.tsx`(d3-geo, world-atlas) |
| 좌표 변환/클램프 | `src/components/map/geometry.ts` |
| 대시보드 지도 탭 | `src/components/home/HomeMapPane.tsx`, `MapPlaceSearch.tsx`, `MapCreatePopover.tsx`, `MapContextMenu.tsx` |
| 공간 위젯 | `src/components/home/space/widgets/{NoteMapWidget,VisitedRegionsWidget}.tsx` |
| 지역 다중 편집 | `NoteRegionsList`(프리뷰 첨부·메타줄 `RegionMetaBadge`에서 재사용) |
| 지오코딩 커맨드 | `src-tauri/src/commands/geocode.rs`, `specs/commands/geocode.yaml` |
| 위치 쓰기 커맨드 | `note_set_location`, `note_regions_list`(`specs/commands/dashboard.yaml` 등) |

## 5. 알려진 한계 / 결정

- 클러스터링·경로(다중 지점 잇는 여행 루트) 그리기는 v1 제외(`docs/DASHBOARD.md` §5).
- 연간 뷰 없음(장기 조망은 대시보드 타임라인 탭 담당).
- 공간 위젯은 항상 SVG 경로만 쓴다 — GL 온라인 타일은 대시보드/사이드바 지도 전용.

## 지역 추가 — 인라인 검색이 기본, 지도는 탈출구 (2026-09-07)

노트에 지역을 다는 흐름은 **칩 → 팝오버 → 인라인 검색**으로 끝난다. 모달(`RegionPickerDialog`)은
"지도에서 고르기"를 눌렀을 때만 열린다.

그전에는 팝오버의 "장소 추가"가 곧바로 그 모달을 열었다. 모달이 무거운 이유는 세계지도
(`WorldMapAuto`)를 품기 때문이다 — 지도는 보이는 경도 밴드만 늦게 불러오고 줌 단계마다 도시
데이터를 더 받는 구조라(지오메트리 자산 4.8MB/8파일) **크고 오래 열려 있는 화면**을 전제로
설계돼 있다. 좁고 바깥 클릭으로 닫히는 팝오버와는 상극이고, 정작 흔한 경우(검색해서 고르기)는
지도가 전혀 필요 없다. 검색 결과(`useGeocodeSearch` → `GeocodeResultItem`)에 좌표가 이미 들어
있기 때문이다.

- 대표 지역과 경유지 **둘 다** 같은 인라인 검색에서 시작한다(오너 결정).
- **팝오버를 열기만 해서는 지오코딩이 호출되지 않는다** — 네트워크를 타는 경로라 명시적 입력에만
  돈다. `NoteRegionsList.test.tsx` 가 이 계약을 고정한다.
- `RegionPickerDialog` 자체는 그대로다. 임의 좌표를 눈으로 찍어야 할 때의 탈출구이고, 설정·
  온보딩의 다른 호출부도 계속 쓴다.
