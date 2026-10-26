# 노트 — 노트 기능 SSOT 확장 문서

> 이 문서는 `specs/features/notes.yaml`(1차 소스, F-N01~F-N06)의 디테일 확장이다. 커맨드 계약의
> 정본은 `specs/commands/notes.yaml`/`sections.yaml`/`attachments.yaml`, DB 스키마의 정본은
> `specs/db/schemas/notes.sql`/`content.sql` — 이 문서와 실제 코드가 다르면 코드(현재 shipped
> 동작)가 우선한다.

## 1. 기능 개요

노트북(내부 식별자 `workspace`) 안에서 폴더 트리로 정리되는 개별 노트. 노트 하나는:
- 멀티 섹션 에디터(탭으로 나뉜 본문, 텍스트/다이어그램/시트 세 종류)
- 읽기 전용 원문 사료(sources) — 텍스트 산문을 쓰지 않고 사료를 그대로 붙여넣는 용도
- 첨부(attachments) — 이미지/문서/오디오/링크/노트/노트간 링크/각주
- 좌측 프리뷰 패널에서 섹션·첨부·관련 노트를 클릭 시 미리보기

이 6가지가 `specs/features/notes.yaml`의 F-N01~F-N06으로 각각 나뉜다: F-N01 폴더 트리+CRUD,
F-N02 멀티 섹션 에디터, F-N03 원문 사료 패널(프리뷰), F-N04 첨부파일, F-N05 내보내기/백업·복원,
F-N06 휴지통/아카이브.

**이 문서의 범위 밖**: 스냅샷/복원은 `docs/ACTIVITY.md`, 통합 검색은 `docs/SEARCH.md` 참고.

## 2. 동작 방식

### 2.1 노트 생성/조회 — F-N01

`note_create`는 life-recording 피벗(역사 전용 → 인생 기록 중심) 이후 `year`/`month`/`day`를
각각 독립적으로 미지정 시 오늘(로컬 타임존)로 채운다. 명시값이 있으면 그대로 존중한다(발췌/복제가
원본 연도를 넘기는 경우). 생성 직후 기본 Overview 섹션 1개 + 빈 소스 목록을 갖는 `NoteDetail`을
돌려주고, FTS 행을 동일 트랜잭션에서 upsert한다.

**2026-09-20 실험(오너 "넣어봐 보고 이상하면 지울게")** — 노트북별 설정 두 개가 이 "오늘" 기본값
경로(`repo::notes::create_today_default`, `note_create`의 유일한 경유지)에서만 동작을 바꾼다:
`new_note_date_precision`("day"(기본)|"month"|"year")은 year/month/day 를 **셋 다 생략했을 때만**
적용되고(하나라도 명시하면 기존의 "필드별 독립 오늘 폴백" 그대로, 부분 입력 재해석 없음),
`new_note_section_name`(≤40자 문자열, 생략/무효 시 "Overview")은 첫 섹션 이름을 날짜와 무관하게
바꾼다. 둘 다 **노트가 속한 폴더의 노트북**(활성 노트북이 아니다 — AI 디스패치·가져오기·동기화가
비활성 노트북의 폴더에도 쓸 수 있다) 기준으로 읽고, 값이 없거나 손상됐으면 항상 기존 동작으로
폴백한다. `create_with_timestamp`(가져오기/보드·달력·타임라인/펫/일정이 직접 쓰는 저수준 경로)는
이 두 설정을 전혀 보지 않는다 — 자세한 근거는 `specs/commands/notes.yaml`의 `note_create` notes.

목록 조회는 스코프별로 커맨드가 나뉜다(`specs/commands/notes.yaml`):

| 커맨드 | 용도 |
|---|---|
| `note_query` | 사이드바가 노트를 얻는 단일 read 엔드포인트 — 폴더/연도/기록축(updated/created)/즐겨찾기/태그/지역/상태/좌표 축을 AND로 조합, 서버측 페이지네이션 |
| `folder_list` / `folder_list_meta` | 트리 데이터(폴더 + 경량 `NoteSummary` 목록). `folder_list_meta`는 부팅 첫 페인트용으로 노트 행 자체를 비운다 |
| `note_summaries_map` | id로만 아는 노트를 배치 조회(탭/첨부/컨텍스트 메뉴가 트리 캐시에 없는 노트를 해석) |
| `note_get_many` | 배치 `note_get` — 섹션 본문까지 든 `NoteDetail[]`을 입력 순서로(없는·휴지통 id 생략, 500개 상한). 대시보드 달력 날짜 패널이 쓴다 |
| `note_related` | 에디터 하단 "관련 노트" 스트립 — 백링크(×100) + 사건 날짜 일치(+30) + 공유 첨부(×15) + 공유 태그(×10) + 연도 근접(≤10) 가산 점수, `note_related_exclusions`로 개별 쌍 제외 가능 |

노트의 날짜 축은 **시작(`year`/`month`/`day`) + 종료(`end_year`/`end_month`/`end_day`) 두 축**뿐이며
(2026-09-08 이후 `note_date_update`, §2.6b), "마감 취급"(긴급도/빨강/알림 뱃지) 같은 표시
효과는 저장 필드가 아니라 노트별 opt-in `remind` 플래그(`note_update`)로 제어된다 — 자세한 배경은
`docs/DASHBOARD.md` §2. 지역(`note_set_region`)·상태(`note_set_status`)·좌표(`note_set_location`)·
아이콘(`note_set_icon`)은 전용 커맨드로 분리돼 있고, 날짜·일정은 `note_date_*` 행 커맨드가 맡는다 —
`note_update`의 "필드 생략 = 변경 없음" 관례로는 명시적 해제(null)를 표현할 수 없기 때문.

### 2.2 섹션 타입 — F-N02

섹션(`Section`, `src/lib/commands.gen.ts`)은 노트 내부의 탭 단위 구성 요소다:

```ts
export interface Section {
  id: string;
  name: string;
  body_md: string;
  position: number;
  kind: 'text' | 'diagram' | 'sheet';
}
```

- **`text`** (기본): TipTap 에디터가 렌더하는 산문. `body_md`는 마크다운.
- **`diagram`**: mermaid 소스 텍스트가 `body_md`에 그대로 저장된다 — Tiptap/mdSerialize 경로를
  절대 타지 않는다(`src/components/diagram/DiagramSection.tsx`가 대신 렌더).
- **`sheet`**: `body_md`가 시트 JSON 한 덩어리(`specs/features/sheet.md` §body_md JSON 스키마 v1).
  마찬가지로 Tiptap 경로를 타지 않는다(`src/components/sheet/SheetSection.tsx`). 셀 단위 패치는
  전용 커맨드 `sheet_set_cells`.

새 섹션은 `section_create`(빈 본문) 또는 `section_create_with_body`(AI 정리/프롬프트 결과, 관계도
스타터 등 본문을 채워서 생성 — 기존 섹션을 절대 덮어쓰지 않는다는 불변식을 지키기 위해 항상 새
탭으로 들어간다)로 만든다. 마지막 남은 섹션은 삭제 불가(`section_delete` → CONFLICT).

**파일 → 섹션 가져오기**(`section_import_file`, `specs/commands/sections.yaml`): 파일 하나를 새
섹션으로 만든다. 확장자가 파서와 `kind`를 결정한다 — `md`/`txt`는 내용 그대로, `docx`/`pdf`/`hwpx`/`pptx`는
텍스트 추출(`repo::extraction`, `specs/service/extraction.yaml`), `csv`/`tsv`/`xlsx`는 표를 시트
JSON으로 바꿔 `kind='sheet'` 섹션이 된다. 그 밖의 확장자는 VALIDATION이고 첨부로 남는다.
`xlsx`만 워크시트 한 장당 섹션 하나를 만들기 때문에 이 커맨드의 출력은 `sections` 배열이다(나머지
형식은 항상 길이 1). 폴더 경로는 VALIDATION이고, 폴더를 펼치는 일은 `section_import_scan`이
맡는다 — 드롭과 "…" 메뉴 둘 다 이 스캔을 먼저 거쳐 파일 목록을 얻는다.

**`hwpx`·`docx`는 서식형이 먼저다**(PLAN-2026-10-07-doc-import-export W1 hwpx · W4 docx): `lib/docImport.ts::importOneFile`(배치는 `lib/noteActions.ts::importFilesAsSections`)이
`doc_import_html`(Rust `repo/doc_import/` — 표 병합·셀 배경·열 너비, 굵게·색·형광, 정렬·들여쓰기, 개요 제목,
목록, 링크, 그림은 노트 첨부로 저장)로 HTML을 받아 `mdSerializeHtml`(붙여넣기와 같은 스키마 관문)로 본문을 만들고
`section_create_with_body`로 넣는다. 실패하면 `reportFallback("doc-import", …)` 후 위의 텍스트 추출로 물러난다.
글상자는 본문 문단으로, 각주는 문서 끝 목록으로 옮기고, 머리말·꼬리말·수식·차트·삽입 개체 등은 버린 개수만
가져오기 끝 알림 한 줄("그대로 못 가져온 것 n개 — …")로 알린다. 되돌리기는 섹션만 지운다(그림 첨부는 남는다).
DOCX(`repo/doc_import/docx.rs`)는 스타일 상속(basedOn)·번호 목록(끊겼다 이어지는 번호는 `<ol start>`)·필드·각주/미주·
변경 추적(수락한 모양 — 넣은 글자는 남고 지운 글자는 빠짐)까지 읽고, 메모는 개수만 센다. 외부 링크 그림은 절대 내려받지
않고, 암호화·옛 `.doc`·DOCTYPE 은 VALIDATION 으로 텍스트 추출에 넘긴다. 글꼴·크기·목록 번호 서식(가., ①)은 버린다.

가져오기 진입점은 파일 드롭·"…" 메뉴 말고 세 개가 더 있고, 셋 다 **새 커맨드 없이** 기존 경로를
재사용한다:
- **첨부/사료 승격** — 첨부 바 타일 우클릭 "섹션으로 가져오기". 사료는 `Source.body`(추출된 원문)가
  이미 프런트에 있으므로 `section_create_with_body` 로 그대로 넣고, 첨부는
  `useAttachmentsBase()` 의 `baseDir` + `rel_path` 로 절대 경로를 만들어 `section_import_file` 에
  넘긴다. 첨부 쪽은 데스크톱 전용이다(브라우저 모드의 `baseDir` 는 파일 경로가 아니라 HTTP
  접두사). 내부링크 첨부와 파생 타일(지역·각주)에는 메뉴가 뜨지 않고, **링크 첨부는 이 승격 메뉴가
  아니라 링크 넛지로 간다**(아래 "링크" 항목 ④ — 가져올 것이 디스크 파일이 아니라 원격 본문이다).
- **클립보드 표** — 에디터 본문에 표를 붙여넣으면 기본 붙여넣기는 그대로 두고 "시트로 만들기"
  토스트만 띄운다(`showToastOnly`, 되돌리기 슬롯을 점유하지 않는다). 표 안에 캐럿이 있으면 제안
  하지 않는다 — 그 자리는 `tableMatrixPaste` 확장이 셀을 채우는 경로다. 행렬 → 시트 문서 변환은
  `src/lib/sheet/fromMatrix.ts` 이고, 행/열 상한 규칙은 파일 경로의 Rust 쌍둥이
  (`csv_import::rows_to_sheet_json`)와 같아야 한다.
- **링크** — 넛지(`common/LinkNudge.tsx`)가 "〈호스트〉 페이지의 내용을 추출" · "내용을 AI로 정리"
  (AI 꺼져 있으면 숨는다) · "브라우저에서 열기"를 말풍선으로 띄운다. **자리는 넷이고 컴포넌트는
  하나다**(오너 2026-09-10) — 문구·게이트·동작이 갈라질 수 없게:
  ① 에디터에 단독 URL 을 붙여넣은 직후 그 링크 아래, ② 에디터 링크 우클릭(붙여넣는 순간을 놓쳐도
  다시 닿을 길 — 선택 없는 우클릭은 원래 아무 메뉴도 열지 않았고 `SelectionContextMenu` 의 모든
  행은 선택에 대한 명령이라 그 빈자리가 링크 몫이 됐다), ③ **링크가 여럿 든 선택 영역** 우클릭 →
  선택 메뉴의 "선택 안의 링크 N개…" 행이 같은 넛지를 연다(범위 안 링크 수집은
  `editor/linkHrefs.ts::linkHrefsInRange` 한 곳 — 문서 순서, 중복 제거, `note://` 제외),
  ④ 첨부 바의 **링크 타일** 우클릭 — 예전에 저장해 둔 링크도 같은 액션에 닿아야 한다. ④가 필요했던
  이유는 `canPromoteAttachment`(`lib/fileKinds.ts`)가 `rel_path` 를 요구해서 링크 첨부는 승격 메뉴
  대상이 **아예 아니었고**, 그래서 우클릭이 아무 일도 하지 않았기 때문이다. 그 함수를 넓히지 않고
  타일 쪽에서 갈래를 하나 더 뒀다 — 링크는 파일 승격(`section_import_file`)과 경로가 다르다.

  실제 동작은 `lib/linkImport.ts` 한 관문이다(첨부 바 "링크 추가" 대화상자의 가져오기 버튼도 같은
  함수를 탄다 — 원래 그 안에 인라인으로 있던 3단계를 올린 것이다). 커맨드는 기존 것뿐이다:
  `attachment_add_link` → `attachment_fetch_reader` → `insertAiSection`(추출본 그대로) 또는
  `runAiAction("organize")`(AI 정리 — 입력 상한 프리플라이트·프로바이더 실패 안내를 그쪽이 이미
  갖고 있다. `ai_cleanup_text` 는 8192자에서 **조용히 절단**하므로 쓰지 않는다).
  부수효과가 하나 있고 의도된 것이다: **링크는 첨부로도 남는다**(같은 URL 이 이미 있으면 그 행을
  재사용한다) — 추출 출처가 노트에 남지 않으면 "이 섹션이 어디서 왔나"를 되짚을 수 없다.

  **출처 한 줄이 자동으로 붙는다**(`lib/aiSectionBridge.ts::withSourceLine`, 정책은 `docs/AI.md`
  §1.0-5) — 두 모드 모두 본문 끝에
  `> 출처: [제목](url)` 이 붙는다. AI 갈래에서 이걸 프롬프트로 부탁하지 않는 이유: 모델이 지킬
  때도 있고 안 지킬 때도 있어 출처가 있는 섹션과 없는 섹션이 섞인다. 대신 `runAiAction` 의
  `insertSection` 을 우리가 넘기므로 **삽입 직전** 본문에 붙인다(만들어진 뒤 `section_update` 로
  덧붙이면 쓰기가 두 번이고 실패 지점이 늘어난다). 제목의 `[]` 는 공백으로 바꾼다 — 남의 페이지에서
  온 문자열이라 마크다운 링크를 깨뜨릴 수 있다.

  **N개 일괄**(`importLinksToSections`)은 파일 여러 개를 섹션으로 가져오는 배치와 **똑같은 관례**를
  쓴다: `runBatch` 순차 실행 · 진행 토스트(`section_import_progress` 문구 공유) · 부분 실패를
  숫자로 보고 · 하나라도 만들어졌으면 `showUndoToast` + `undoImportedSections`. 유사 기능이 다른
  경험을 갖지 않게 하는 것이 규칙이라 문구 키까지 그쪽 것을 그대로 쓴다. 순차인 이유는 그쪽과 같고
  (+ 하나 더) 각 링크가 원격 fetch 라 병렬로 쏘면 같은 호스트에 동시 요청이 되고 사이에 끼는
  `reloadActive`/섹션 삽입이 서로 경합한다. 진행 토스트 문턱이 파일(3개)보다 낮은 2개인 이유는
  링크 하나가 최대 10초(fetch 타임아웃)라 둘만 돼도 체감이 파일 셋보다 길기 때문이다.
  못 읽은 링크는 성공으로 세지 않는다(배치 콜백이 throw 해서 `runBatch` 가 failed 로 센다) —
  "3개 완료"가 거짓이 되면 안 된다.

  "가능한 경우에만 제안"의 판정은 `lib/urls.ts::linkBodyMaybeReadable` 이고 **정적 검사**다
  (http(s) + 확장자로 이미 비-HTML 인 것 제외). 붙여넣는 순간 실제로 fetch 하면 더 정확하지만 그건
  사용자가 요청하지 않은 원격 요청을 링크마다 한 번씩 보내는 것이라 `attachment_fetch_reader` 의
  "명시적 사용자 액션에서만 fetch, 백그라운드 프리페치 금지" 원칙과 어긋난다 — 그래서 제안은
  낙관적으로 띄우고 **못 읽는 페이지는 누른 뒤** 정직하게 알린다(링크 첨부는 남으므로 "브라우저에서
  열기"로 갈 길이 있다). 여러 개일 때는 읽을 수 없는 것을 목록에서 먼저 걸러 세므로 "링크 N개"의
  N 은 **실제로 시도할 수 있는 수**다.

  다섯 번째 자리는 넛지가 아니라 버튼이다: **링크 미리보기(`preview/LinkReaderPreview.tsx`)의
  "섹션으로 가져오기"**. 그 화면은 `attachment_fetch_reader` 결과를 **이미 손에 들고 그리고 있으므로**
  여기서는 `importLinkToSection` 을 부르지 않고 마지막 단계(`insertAiSection` + 출처 한 줄)만
  재사용한다 — 다시 부르면 같은 페이지를 한 번 더 가져온다(최대 10초). 관문을 우회하는 것이 아니라
  관문의 앞 두 단계(첨부 확정·fetch)가 이미 끝나 있는 자리다.

**에디터의 링크는 Ctrl/Cmd+클릭으로만 열린다**(오너 2026-09-10). Link 확장이 `openOnClick: false`
(`lib/mdSerialize.ts`)라 클릭으로 여는 경로는 애초에 없었고, `EditorPanel` 의 본문 클릭 핸들러가
조합키가 눌린 http(s) 앵커만 `openExternalUrl`(`lib/urls.ts` — plugin-opener, 실패하거나 브라우저
모드면 새 탭)로 보낸다. 조합키 없는 클릭은 `preventDefault` 로 확실히 끊는다: 웹뷰의 기본 활성화로
앱이 그 페이지로 넘어가면 돌아올 길이 없다. **세번클릭(문단 전체 선택)은 본문 편집에서 자주 쓰는
제스처라 "열기"와 같은 제스처를 다투게 두지 않는다.** `note://` 위키링크만 예외로 맨클릭 인앱
이동이 그대로다 — 셸/OS opener 를 타지 않는 순수 스토어 호출(`selectNote`)이기 때문이다.

**붙여넣은 파일 경로는 인라인 코드가 된다**(오너 2026-09-10 — "요약이 아니라 그냥 바로 스타일화
해서 나중에 빠르게 복사할 수 있도록"). 넛지도 제안도 아니고 묻지 않고 바로 적용한다: 클립보드
텍스트가 **경로 하나뿐**이면(`soleFilePathFromPasteText`, EditorPanel.tsx — 붙여넣기 순수 분기들이
사는 그 자리) `code` 마크를 입혀 넣는다. 파일시스템은 만지지 않는다 — 존재·타입 확인이 없고,
그래서 이 기능은 "추출"이 아니라 "스타일링"이다(프런트가 파일시스템을 못 읽는다는 제약이
`useEditorFileDrop.ts` 주석에 이미 있다). 판정은 **보수적**이다: 한 줄이어야 하고, 윈도 드라이브
경로(`C:\…` — 공백 허용, `C:\Program Files\…` 가 흔하다) · UNC(`\\server\…`) · 슬래시 2개
이상의 공백 없는 POSIX 경로만 받는다. `/summarize` 처럼 슬래시로 시작하는 한 낱말은 거부한다
(붙여넣은 슬래시 명령이 코드가 되면 안 된다). http(s) URL 로 파싱되는 것은 무조건 제외 — 링크
분기와 같은 문자열을 다르게 판정하면 안 되는 방어선이다. 이미 `code`/`codeBlock` 안이면 기본
붙여넣기 체인이 옳으므로 아무것도 하지 않는다(표 분기의 `isActive("table")` 방어와 같은 관용구).
삽입과 stored mark 해제를 **한 체인(한 트랜잭션)** 으로 묶는다: Ctrl+Z 한 번으로 되돌아가야 하고,
해제하지 않으면 이어 치는 글자까지 코드가 된다.

가져오기 배치에는 진행 표시와 되돌리기가 붙는다. 파일이 3개 이상이면 진행 토스트(`lib/
progressToast.ts`, `Toast.tsx` 의 `progress` 종류)가 뜬다 — 같은 key 로 다시 emit 하면 쌓이지
않고 문구만 바뀌고, ttl 이 없어 호출자가 `null` 로 지울 때까지 남으며, 3개 상한에 밀려 사라지지
않는다(undo 토스트와 같은 이유). 배치 시작 시 `0/N` 을 먼저 띄우는 이유는 `runBatch` 의
`onProgress` 가 한 건이 끝난 뒤에야 처음 불려서, 큰 pdf 한 장이 도는 동안 다시 무반응이 되기
때문이다. 되돌리기는 그 가져오기가 만든 섹션 id 만 지운다(`undoImportedSections`) — 삭제 전
`flushAll()`, 삭제 후 활성 노트면 `reloadActive()`. 열려 있던 섹션이 지워지면 EditorPanel 의
노트 로드 effect 가 스스로 다른 섹션으로 물러난다(`sameNote` 판정). 생성 자체는
`section_create_with_body`와 **같은 repo 함수**를 타므로 섹션 insert 경로는 여전히 한 벌이다.
진입점은 두 개다: 섹션 영역에 파일을 떨어뜨리기, 그리고 타이틀 줄 우측 "…" 메뉴의 다중 파일
선택. **드롭존은 활성 섹션 종류와 무관하다** — `EditorPanel`의 최상위 컨테이너(탭 바 포함) 하나가
드롭을 받으므로 시트·관계도 섹션을 보고 있어도 어떤 파일이든 새 섹션이 된다. 예전에는 이 존이
텍스트 분기 안에만 있어 시트·관계도에서는 드롭이 아무 반응도 없었다. **존은 반드시 하나여야
한다** — 두 개가 포개지면 같은 드롭이 두 번 처리되어 섹션이 두 벌 생긴다
(`EditorPanel.dropZone.contract.test.ts`가 이 불변식을 고정한다). 에디터가 없는 갈래(시트·관계도)
에서는 이미지도 첨부로만 간다 — 꽂을 캐럿 자리가 없다. CSV가 시트 상한(1000행 × 52열)을 넘으면 거부가 아니라 절단하고 `truncated`로 알린다.

**섹션 → 파일 내보내기**: 텍스트 섹션은 `export_section_md`(body_md를 .md로, `specs/commands/
export.yaml`), 시트 섹션은 기존 `export_sheet_csv`. 관계도 PNG(`export_diagram_png`)는 캔버스가
마운트돼 있어야 하므로 섹션 탭 메뉴가 아니라 관계도 툴바에 그대로 남는다.

**내보내기·인쇄 모달**(PLAN-2026-10-07-doc-import-export W3, `components/export/ExportModal.tsx`): 텍스트 섹션 탭
"내보내기…", 노트 우클릭 "내보내기", 타이틀 "…" 메뉴 내보내기가 같은 모달을 범위(이 섹션 / 노트 전체)만 달리 연다.
왼쪽은 `<iframe srcdoc>` 미리보기(테마 무관 — 문서 형식은 A4 종이 `exportPaper.ts`, HTML·서식 복사는 그 결과물 그대로), 오른쪽은
형식(HWPX · DOCX · PDF·인쇄 · HTML · 서식 복사 · Markdown — 형식별 갈래는 `exportFormats.ts` 표 한 곳)·범위·용지·"달라지는 점"
(`exportDoc.ts::exportDifferences`). 시트 섹션은 계산값 표로(`exportSheets.ts`), 각주는 `[n]` + 끝 목록으로(`exportFootnotes.ts`)
모든 형식에 같게 들어가고 관계도만 빠진다. **HTML**(W6)은 그림을 data URI 로 품은 단일 파일(`export_html` — Rust 가 `data-rel-path` 만 첨부
루트 안에서 읽어 채운다), **서식 복사**는 인라인 style 조각을 `export_html_inline` 으로 채워 클립보드에 text/html + text/plain. **PDF·인쇄**(W5)는 파일을 쓰지 않고 그 미리보기
iframe 을 그대로 `contentWindow.print()` 한다 — WebView2 인쇄 창이 프린터·"Microsoft Print to PDF"·쪽 나눔을 맡고, 인쇄 CSS
(`printCss` — `@page` 크기·여백·쪽 번호, 브라우저 머리글 끔)는 미리보기 문서에 늘 들어 있다. [인쇄…] 는 iframe 이 지금
문서를 다 그린 뒤에만 켜진다(용지를 바꾼 직후 이전 문서가 인쇄되지 않게). 문서 JSON 은 `flushAll()` → `note_get` → 헤드리스
TipTap(텍스트 섹션만). HWPX·DOCX 는 `export_hwpx`·`export_docx`(Rust `repo/doc_export/` — 표 격자·정렬·그림 크기는 `pm.rs`
공용, 형식별 작성기는 `hwpx.rs`·`docx.rs`. DOCX 는 맑은 고딕, 한 행 63열 초과 표는 Word 한계라 VALIDATION), 저장 뒤 토스트의 [기본 앱으로 열기]·[폴더 열기]는
`export_open`(프런트 opener 권한이 `$RESOURCE` 뿐이라 Rust 가 연다 — 내보내기 형식 확장자만). Markdown 은 기존
`export_section_md`·`export_note`(고른 .md 파일에 쓰고 첨부는 옆 `{stem}_files/`; W6 에서 html 형식·폴더 단위 HTML 제거). 시트·관계도 섹션의 섹션 탭 내보내기(CSV·PNG)는 그대로다.

**섹션 이동 — 드래그·우클릭 (F-N08, `docs/PLAN-2026-09-10-section-dnd-trash.md`)**: 탭 드래그는
포인터 이벤트다(`lib/noteDrag.ts`의 `section` 페이로드) — HTML5 `draggable`은 WebView2 가
`dragDropEnabled`로 OS 레벨에서 가로채 웹뷰 안에서 `dragover`/`drop`이 아예 안 뜨는 자리라 앱에서
죽어 있었고 jsdom 테스트만 통과해 그걸 가렸다. 같은 드래그가 두 갈래로 갈린다:

- **같은 노트 안 탭 위**(`section:<id>` 대상) → 재정렬, `section_reorder`(그대로).
- **트리의 노트 행 위**(`note:<id>` 대상) → 다른 노트로 이동, `section_move { id, target_note_id }`.
  대상 노트 맨 뒤(그 노트 `MAX(position)+1`)에 새 섹션으로 붙는다. 폴더·칸반 위에 놓으면 아무 일도
  없다.
- **미리보기 카드 위**(`preview:card` 대상) → 그 섹션을 미리보기에 고정,
  `setPreviewItem({ kind: "section", … })`. **IPC 도 DB 도 타지 않는 순수 UI 상태**라 낙관적 갱신·
  롤백이 없다. 접힌 레일 상태(`previewCollapsed`)에서는 받지 않는다(파일 드롭존과 같은 판단).
  섹션 탭 우클릭 "미리보기" 토글과 **같은 상태**를 쓴다. 이 진입점이 첨부 바에 있던 **시트 파생
  타일을 대신한다** — 시트는 첨부가 아니라 섹션이므로 첨부 바에 타일로 합성하는 것이 원칙에 맞지
  않았고(오너 2026-09-10), "섹션을 미리보기에 끌어다 놓는다"가 종류와 무관하게 통하는 규칙이다.

우클릭 메뉴 "다른 노트로 이동…"도 `InternalNotePicker`로 노트를 고른 뒤 **같은** `section_move`를
부른다 — 드래그와 우클릭이 서로 다른 경로로 갈리지 않는다. 원 노트의 유일한 섹션은 `section_delete`와
같은 규칙으로 CONFLICT(빈 노트를 만들지 않는다), 같은 노트로의 드롭은 no-op. 낙관적 갱신은 없다(두
노트를 건드려 롤백이 복잡한 대신 왕복이 짧다). `ponytail:` 본문 이미지 첨부는 옮기지 않는다 — 첨부
경로가 노트 id를 포함한 상대경로라 이동 후에도 그대로 그려지지만, 원 노트를 **완전 삭제**하면 그
폴더가 지워져 깨진다(천장, 업그레이드 경로는 `repo/sections.rs::move_to_note`의 독스트링).

**섹션 휴지통**: `section_delete`는 이름은 그대로지만 하드 삭제가 아니라 **별도 테이블
`section_trash`**(마이그레이션 V79) 경유다 — `sections`에 `deleted_at` 컬럼을 넣지 않는다. 이유는
`FROM sections`가 Rust에 69곳(검색·내보내기·AI 컨텍스트·칸반·관계도·시트·스냅샷)이라 컬럼 방식이면
전부에 `deleted_at IS NULL`을 넣어야 하고 하나만 빠져도 지운 섹션이 유령으로 남는다. 별도 테이블은
기존 쿼리를 하나도 안 고친다.

- 삭제는 같은 트랜잭션에서 행을 `section_trash`로 옮긴 뒤 `sections`에서 지운다. tombstone은 그대로
  찍힌다(동기화 상대에겐 삭제가 맞다). **삭제 확인 다이얼로그는 없다** — 되돌릴 수 있는 동작에 확인을
  묻지 않는다는 노트 휴지통과 같은 규칙.
- 복구(`section_restore`)는 같은 id로 `sections`에 되돌리고(위치는 그 노트 맨 뒤), tombstone을
  지운다(`remove_tombstone` — 살아 있는 행에 묘비가 남지 않게). **원 노트가 없거나 휴지통이면
  CONFLICT**(노트를 먼저 복구해야 한다).
- 완전 삭제(`section_purge`)는 휴지통 행만 지운다 — 섹션엔 딸린 파일이 없다. 노트를 완전
  삭제(`note_purge`)하면 그 노트의 섹션 휴지통 행도 FK CASCADE로 같이 사라진다.
- 사이드바 휴지통 **배지 숫자**(`trashCount`)는 노트만 센다 — 섹션 수는 더하지 않는다. 다만 섹션만
  버리고 노트가 0인 순간에도 사이드바 휴지통 **행 자체**는 떠 있어야 모달로 갈 길이 남으므로, 행
  노출 여부는 `sectionTrashCount`(= `section_trash_list` 길이)가 따로 정한다(`stores/trash.ts`,
  `leftpanel/notetree/rows.ts`). 모바일은 섹션 휴지통을 노출하지 않는다(0 고정 — 오버레이가 노트만
  보여준다). `TrashModal`은 노트 구역 아래 섹션 구역을 하나 더 갖고, 행 관례는 노트와 같다: 복구는
  확인 없이 바로, 완전 삭제만 확인 다이얼로그.

### 2.3 에디터 — `src/components/EditorPanel.tsx`

`EditorPanel`은 TipTap(`useEditor`)을 `PREVIEW_EXTENSIONS`(StarterKit/Markdown/TaskList/Link/
BriseImage/Table 등, 프리뷰 패널의 `SectionPreview.tsx`와 공유하는 스키마 목록) + 인터랙션 전용
확장(Placeholder/EmojiRender/SlashCommand/WikiLink/TaskListDashInputRule)으로 구성한다.
`onUpdate`에서 700ms 디바운스 후 `mdSerializeEditor(editor)`로 직렬화해 `updateSectionBody`를
호출하는 것이 자동 저장 경로다. `flushRef.current()`가 섹션 전환/노트 전환/창 close 시 이 디바운스를
즉시 flush한다.

**섹션/노트 전환**은 `switchSection`(섹션 탭 클릭)과 "노트가 바뀌면" `useEffect`(활성 노트 자체가
바뀔 때)로 나뉜다 — 둘 다 `bodyCacheRef`(섹션별 최신 편집 캐시, store가 타이핑 중 `activeNote`를
갱신하지 않아 필요)에서 복원한 본문을 `editor.commands.setContent(body, MARKDOWN_SET_CONTENT_OPTIONS)`
로 주입한다. `diagram`/`sheet` 섹션은 이 경로에서 `setContent`를 건너뛴다(각 전용 컴포넌트가 직접
렌더).

**알려진 함정**: `EditorPanel`은 컴포넌트 맨 아래에 `if (!editor || !activeNote) return null` 형태의
조기 반환을 갖는다. 이 컴포넌트의 훅은 전부 그 반환 위에 있어야 한다 — 과거 이 규칙 위반으로 앱
전체가 백지로 크래시한 사고가 2회 있었다(`CLAUDE.md` 함정 1).

**2026-09-20 — 에디터 동작 6종 토글**(오너 결정, 설정 > 에디터. `stores/settings.ts`, 기본 전부
ON = 이 변경 전까지의 동작 그대로): 저장은 `date_nudge_enabled`/`region_nudge_enabled`/
`paste_link_nudge`/`paste_path_inline_code`/`paste_table_sheet_suggest`/`editor_md_autoformat`
불리언 6개, 정확히 무엇을 끄고 무엇은 안 끄는지:

- **`dateNudgeEnabled`**(`components/editor/dateNudge.ts`) — 끄면 타이핑 날짜 넛지가 파싱조차
  안 한다(디바운스 타이머 자체를 안 건다). `dateNudgeAuto`(완전자동 등록)보다 우선한다 — "off"가
  "auto"를 덮는다. 끄는 순간 이미 떠 있던 칩·라인 프레임은 다음 키 입력을 기다리지 않고 즉시
  사라진다(`useSettingsStore.subscribe`로 dismiss 메타 트랜잭션을 쏜다). **안 건드리는 것**:
  `/날짜` 슬래시 커맨드(`DateEntryPopover`)는 명시적 사용자 액션이라 그대로 동작.
- **`regionNudgeEnabled`**(`components/editor/regionDetect.ts::useRegionDetect`) — 끄면 스캔도
  `region_registry` fetch 도 없고, 이미 있던 후보를 그 노트에 대해 즉시 비운다 — 배지 점
  (`RegionMetaBadge`)과 "감지됨" 섹션(`RegionDetectedSection`)이 다음 스캔을 기다리지 않고 바로
  사라진다. 다시 켜면 마운트 시 즉시 스캔과 같은 경로로 바로 재스캔한다. **안 건드리는 것**:
  `/지역` 슬래시 커맨드(`RegionEntryPopover`)는 그대로.
- **`pastePathInlineCode`**(`components/editor/useEditorPaste.ts`) — 끄면 "붙여넣은 파일 경로
  하나뿐이면 인라인 코드로" 분기를 통째로 건너뛰어 기본 붙여넣기(평문)로 떨어진다.
- **`pasteLinkNudge`** — 끄면 단독 URL 붙여넣기의 "가져올까요?" 넛지(`LinkNudge`)만 안 뜬다.
  **안 건드리는 것**: `pasteUrlSuggest`(AI 링크 요약 제안, `aiEnabled && linkSuggestions` 가
  실효 게이트)는 별개 축이라 이 토글이 꺼져도 그대로 호출된다.
- **`pasteTableSheetSuggest`** — 끄면 표 모양 클립보드 붙여넣기의 "시트로 만들까요?" 토스트가 두
  호출 지점(paste 핸들러 안 + 이 훅이 직접 노출하는 `suggestSheetFromPaste`) 모두에서 안 뜬다.
  **안 건드리는 것**: 표 **안**에 붙여넣는 matrix paste(`tableMatrixPaste.ts`, 셀을 바로 채우는
  별도 플러그인)는 이 토글과 무관하게 그대로 동작.
- **`editorMdAutoformat`**(`components/editor/mdAutoformatGate.ts`) — 끄면 타이핑 INPUT RULE만
  꺼진다(`# `/`- `/`1. `/`- [ ] `/`> `/``` ``` ```/`---`/`**bold**`/`*italic*`/`` `code` ``/
  `~~strike~~`/Typography 의 스마트 따옴표류 전부). 에디터를 다시 만들지 않고 **즉시** 토글되며
  (최우선순위 확장이 `handleTextInput`을 가로채 기본 삽입을 대신 dispatch, 파일 헤더 주석에
  TipTap/ProseMirror 소스 근거 — `editor.setOptions({enableInputRules})`는 부팅 시 한 번만
  읽혀 라이브가 아니라서 기각했다), undo 이력에 유령 스텝을 안 남긴다. **안 건드리는 것**:
  붙여넣기 규칙(마크다운 텍스트 붙여넣기), 슬래시/`[[`/`#`/`/날짜`/`/지역` Suggestion 팝업,
  키보드 단축키(Ctrl+B 등)·툴바 버튼, Enter 키맵 동작(리스트 이어쓰기 등 — 이 레포에 Enter
  트리거 input rule 이 아예 없어 `handleKeyDown`은 손대지 않았다). 데스크톱(`EditorPanel.tsx`)과
  모바일(`mobile/MobileNote.tsx`) 둘 다 적용 — 읽기 전용 프리뷰(`SectionPreview`/`MarkdownBody`)와
  AI 프롬프트 입력(`AskAiComposer`, 서식 확장을 대부분 꺼둔 전용 구성)은 대상이 아니다.
  IME(한글) 조합 종료(`compositionend`)는 의도적으로 안 건드린다 — ProseMirror 자신의 조합 종료
  처리를 가로채면 조합 중이던 텍스트가 문서에 커밋되지 않는 회귀가 나므로, 조합으로 트리거 문자를
  한꺼번에 커밋하는 극히 드문 경우만 이 스위치가 꺼져 있어도 규칙이 발동할 수 있는 의도적 한계로
  남겨뒀다(근거는 `mdAutoformatGate.ts` 헤더 주석).

**2026-09-20 — 실험적 에디터 동작 3종**(오너: "넣어봐, 보고 이상하면 지울게". `stores/settings.ts`
필드는 이미 있었고 이번에 실효 게이트를 얹었다 — 기본값은 각기 다르다, 아래). 각 항목은
`실험적 — 오너가 보고 뺄 수 있다(2026-09-20)` 주석으로 표시돼 있고, 파일 몇 개만 지우면 빠지도록
독립적으로 구성했다:

- **`linkOpenOnClick`**(기본 false) — 켜면 조합키 없는 맨 클릭으로도 http(s) 링크가 열린다
  (`EditorPanel.tsx`의 `shouldOpenLinkOnPlainClick`). Ctrl/Cmd+클릭은 이 프리퍼런스와 무관하게
  항상 열린다(오너 2026-09-10 규칙, 그대로 — `linkOpen.contract.test.ts`가 계속 고정). 맨 클릭도
  다음은 제외: 보조/우클릭, 텍스트 드래그 선택을 막 끝낸 클릭(mouseup 시점 선택이 비어있지 않음),
  잠긴(content_locked) 노트(`editor.isEditable`), 링크 편집 팝오버(`data-editor-pop`) 클릭.
  위키링크(`note://`)는 이 프리퍼런스와 무관하게 이미 맨 클릭으로 이동한다(변경 없음). **모바일은
  대상 밖** — `mobile/MobileNote.tsx`는 오늘도 http(s) 링크를 탭으로 여는 경로 자체가 없다
  (위키링크 탭만 지원); 이 실험은 그 간극을 메우지 않는다.
- **`editorWordCount`**(기본 **true**) — 에디터 상태줄(`.section-statusbar`)의 글자 수·단어 수
  표시. 이 표시는 설정이 생기기 **전부터 늘 보이던 것**이라, 이 키는 새로 켜는 옵트인이 아니라
  "끌 수 있게" 하는 스위치다(그래서 기본 true — false 였다면 키를 만든 것만으로 기존 화면에서
  사라진다). 같은 자리의 **한 값**이다: 켜져 있으면 `components/editor/WordCountBar.tsx` 가 상태줄
  안의 한 칸으로 "글자 N · 단어 N"(선택 중이면 "선택 N자 · N단어")을 그리고, 끄면 그 칸이 비고
  리스너도 안 달린다. 세는 방식도 같이 고쳤다 — 예전 상태줄은 매 렌더마다 `doc.textContent` 로
  세서 (1) 문단 경계가 없어 앞 문단 끝 단어와 뒤 문단 첫 단어가 붙고 (2) `.length` 가 UTF-16
  단위라 이모지·조합형 글자가 여러 자로 세어지고 (3) 큰 문서에서 렌더마다 전체를 다시 훑었다.
  지금은 순수 함수 `wordCount.ts`(`Intl.Segmenter` 그레이프임/단어 경계, 없으면 코드포인트/공백
  폴백)를 update/selectionUpdate 250ms 디바운스로만 부른다. 범위는 현재 연 섹션의 문서뿐(노트
  전체 아님), **데스크톱 전용**. 설정을 없애게 되면 조건만 지우고 `WordCountBar` 는 남긴다.
- **`editorWidth`**(`"narrow" | "normal" | "wide"`, 기본 `"normal"`) — 본문 최대 폭.
  narrow≈640px, normal=기존 800px(값 변경 없음), wide≈1000px(`tokens.css`의
  `.editor-width-narrow`/`.editor-width-wide`, `.editor-desktop`과 결합해서만 적용 — 모바일
  `.mdbody`는 이 클래스가 안 붙어 그대로). `editorFullWidth`가 켜지면 이 값은 무시된다(설정
  화면이 이미 그 상태의 컨트롤을 잠근다; `EditorPanel.tsx`도 `editorWidthClassName`이 그 경우
  항상 빈 문자열을 돌려줘 클래스 자체를 안 붙인다 — JS 레벨 1차 + tokens.css 소스 순서 2차, 이중
  안전장치). 이미지(`max-width:100%`)/표(`width:100%`+`table-layout:fixed`)/고정 툴바(폭
  무관)/날짜·링크 넛지(실측 DOM 좌표 기반)/프리뷰 패널(`SectionPreview.tsx`, `.editor-desktop`
  없는 별도 `.mdbody`라 애초에 미적용)까지 전부 확인했고 이 토글과 무관하게 그대로 맞는다.
  **정렬**: narrow/wide 는 `max-width` 만 바꾼다 — `.editor-desktop .mdbody` 의 `margin:0`(W24 의
  의도적 좌측 정렬)을 그대로 물려받아 본문은 **왼쪽에 붙은 채** 폭만 달라진다(오늘의 normal/800px
  과 같은 원칙). 설정 화면의 힌트도 그렇게 말한다(첫 판은 "가운데 정렬되는 최대 폭"이라고 적혀
  있어 640px 에서 버그처럼 읽혔다 — 문구를 고쳤다). 가운데 정렬을 원하면 W24 결정을 뒤집는 일이라
  오너가 따로 정한다.

### 2.4 스토어의 캐럿 보존 — `src/stores/notesActive.ts::updateSectionBody`

`updateSectionBody(id, body_md)`는 활성 노트가 초안(`activeDraft`)이 아닌 한 **`activeNote.sections`를
의도적으로 갱신하지 않는다**:

```ts
// activeBodyEmpty only — never patch activeNote.sections here. EditorPanel's note-load
// effect calls editor.commands.setContent() on any new activeNote reference; doing that on
// every 700ms autosave would reset the caret out from under whoever is still typing.
const cur = get().activeNote;
if (cur) {
  const nextSections = cur.sections.map((sec) => (sec.id === id ? { ...sec, body_md } : sec));
  set({ activeBodyEmpty: isNoteBodyEmpty(nextSections) });
}
```

`nextSections`는 `activeBodyEmpty` 판정에만 쓰이고 `set()`으로 저장되지 않는다 — `activeNote`
객체 참조가 그대로 유지되므로 `EditorPanel`의 "노트가 바뀌면" effect가 재실행되지 않고, 따라서
`editor.commands.setContent()`가 매 700ms 저장마다 캐럿을 초기화하는 일이 없다. 대신 서버에는
`section_update`로 실제 저장되고 `patchNoteSummary`로 `updated_at`만 트리 캐시에 반영된다.

**결과적으로 `activeNote.sections`의 `body_md`는 방금 타이핑한 섹션 이후로 신선하지 않다.**
섹션 본문을 최신 상태로 읽어야 하는 호출부(예: AI 컨텍스트, 내보내기 트리거)는 먼저
`flushAll()`(`src/lib/invoke.ts` — pending 디바운스를 즉시 flush)을 호출한 뒤 `note_get`으로 DB에서
다시 읽어야 한다. `reloadActive()`(`stores/notesActive.ts`)가 이 패턴의 정석 구현이다:

```ts
reloadActive: async () => {
  const id = get().activeNote?.note.id;
  if (!id) return;
  await flushAll();
  const detail = await call<NoteDetail>("note_get", { id });
  set({ activeNote: detail, ... });
  ...
}
```

같은 이유로 `SectionPreview.tsx`(프리뷰 패널)도 `activeNote.sections`가 아니라 `flushAll()` 후
`note_get` 계열 조회로 최신 본문을 읽는다.

### 2.5 프리뷰(좌측 패널) — `src/components/preview/`

`previewItem`(`src/stores/ui.ts`)으로 선택된 대상을 좌측 프리뷰 패널이 렌더한다.
`src/components/preview/` 아래에 대상별 컴포넌트가 나뉜다: `SectionPreview.tsx`(섹션 본문 —
text는 TipTap read view, diagram은 mermaid 렌더, sheet는 `SheetPreview`), `SourcePreview.tsx`(원문
사료), `ImagePreview.tsx`/`DocPreview.tsx`/`LinkReaderPreview.tsx`/`FootnotePreview.tsx`(첨부 종류별),
`InternalNotePreview.tsx`/`NotePreview.tsx`(내부 링크·직접 메모), `RegionPreview.tsx`(지역).

`SectionPreview.tsx`도 `useEditor`를 쓰며 deps 배열에 `sectionData.id`가 있어 섹션이 바뀔 때마다
TipTap 인스턴스를 재생성(destroy)한다 — 비동기 콜백 뒤 `editor.commands.*`를 호출하기 전에는
`editor.isDestroyed`를 확인해야 한다(`CLAUDE.md` 함정 2, `EditorPanel.tsx`의 여러 지점이 같은
가드를 쓴다).

원문 사료 패널(F-N03, `SourcePanel.tsx`)은 프리셋 목록(`PresetList`)과 프리뷰(`PreviewAttachment`)
중 어느 쪽을 보여줄지를 "실제로 무언가가 선택돼 프리뷰 대상이 됐는가"로 판정한다(빈 초안이거나
프리뷰 대상이 없으면 프리셋, 실제 프리뷰 아이템이 있으면 프리뷰).

### 2.6 첨부 — F-N04, `src/components/attachments/`

`AttachmentsBar.tsx`(에디터 하단 고정 스트립)가 조립부이고, 실제 로직은
`src/components/attachments/` 아래로 분리돼 있다: 훅(`useAttachmentActions.ts` CRUD,
`useAttachmentThumbs.ts` 썸네일, `useAttachmentsDragDrop.ts` OS 파일 드래그&드롭,
`useAutoRelated.ts`/`useManualRelated.ts`/`useRelatedTiles.ts` 관련 노트), 타일 컴포넌트
(`AttachmentTile.tsx`/`AttachmentTileItem.tsx`/`SourceTileItem.tsx`/`SheetTileItem.tsx`/
`RegionTileItem.tsx`/`FootnotesTileItem.tsx`/`RelatedTileItem.tsx`), 그 밖에 대화상자
(`AttachmentDialogs.tsx`), 드래그 고스트(`DropGhost.tsx`) 등.

첨부 종류(`kind`, `specs/db/schemas/content.sql`): `image`/`doc`/`link`/`audio`/`note`(직접 메모
.md)/`internal`(다른 노트 링크)/`footnote`(각주)/`chart`(시트 차트 **라이브 참조**, V88 —
`docs/SHEET.md` "차트 첨부"). `link`/`internal`/`chart`는 `url`만(chart 는
`"<section_id>#<chart_id>"`), `footnote`는 `rel_path`(본문 .md) + `url`(선택, 앵커 발췌 표시용),
그 외는 `rel_path`만 갖는다(테이블 CHECK로 강제).

**저장 모드 3종** — 설정 키 `attachment_storage_mode`(`src-tauri/src/repo/settings_schema.rs`,
허용값 `copy`|`link`|`reference`, 기본 `copy`)가 파일 첨부(`attachment_add_file`) 시 동작을 바꾼다
(`src-tauri/src/repo/attachments/mod.rs::add_file`):

| 모드 | 동작 |
|---|---|
| `copy`(기본) | 원본을 `data_dir/attachments/{note_id}/`로 복사(임시명 → 원자적 rename), SHA-256 해시 계산 |
| `link` | 하드링크(`std::fs::hard_link`) 시도 — 교차 디바이스 등으로 실패하면 `copy`와 동일한 복사로 폴백 |
| `reference` | 파일을 복사하지 않고 `file://` URL로 원본을 참조(`rel_path` NULL, `url`에 file URL), 해시만 계산 |

`copy`/`link` 결과는 `rel_path`를 갖고 `reference`는 `url`(file://)을 갖는다는 점에서, 저장상으로는
`link` 첨부(`kind='link'`, 외부 URL)와 다른 층위다 — `reference` 모드로 저장된 파일 첨부는 여전히
`kind`가 확장자 기반(image/doc/audio)이고 `url`에 로컬 file:// 경로가 들어갈 뿐이다.

**첨부 메타 자동 반영 — 사진 EXIF · 음성 업로드 메타** (S2-1, `docs/PLAN-2026-10-06-s2-input.md` §1·§3)
— 서버 훅 한 곳(`repo/attachments/exif_region.rs::auto_meta`, 진입 3곳이 `post_add::spawn_auto_meta` 로
수렴)이 한다. 폰 전용 구현을 두 번째로 만들지 않는다.

- **정책**: 설정 `photo_meta_mode`(`off`|`ask`|`auto`, 기본 `auto`, PC 공유 전역 키 — 폰 설정에서 변경 가능).
  `auto` = 묻지 않고 반영하고 되돌리기 토스트만(`attachment-meta-applied` → `lib/attachmentMetaToast.ts`),
  `ask` = 반영하지 않고 `attachment-meta-suggested {note_id, date?, region?}` 이벤트만, `off` = **EXIF 읽기·
  역지오코딩(외부 요청) 자체를 생략**한다. 음성은 키를 따로 두지 않고 같은 키를 따른다. (같은 모양의
  `voice_transcribe_mode`/`voice_cleanup_mode` 는 전사 웨이브가 쓴다.)
- **무엇을 읽나**: EXIF 를 **한 번만 열어** GPS + `DateTimeOriginal` 을 함께 뽑는다(카메라/렌즈/방향은 읽지도
  저장하지도 않는다). 오디오는 EXIF 가 없어 업로드 쿼리 `recorded_at`(RFC3339)·`lat`·`lng` 를 같은 규칙으로
  쓴다(`PhotoMeta::from_upload` — 깨진 값은 버리고 첨부는 받는다; 이미지는 EXIF 가 우선, 쿼리는 빈 곳만 채운다).
- **덮어쓰지 않는다**: 대표 날짜(`note_dates` position 0)는 **월도 기간도 없는 연 정밀도뿐일 때만** 채운다
  (월/일까지 정한 값은 사용자 데이터). 그 밖에는 관련 날짜(position>0, label "사진"/"음성")로 붙인다. 같은 날
  행이 이미 있으면 추가하지 않는다(연사 5장 → 1행). 지역은 비어 있으면 첫 지역, 아니면 경유지이고 100m 안
  기존 경유지가 있으면 건너뛴다. 날짜 진실은 `note_dates` — `anchor_date` 는 폐기됐다.
- **되돌리기**: 새 커맨드 없이 `note_date_remove`/`note_region_remove` 재사용. 대표를 채운 경우는 date_remove 가
  대표를 못 지우므로 이벤트가 싣는 `prev_year` 로 연 정밀도를 복원한다(`primary_date_id`+`prev_year`).
- **분류**: `heic`/`heif` = image(썸네일 디코더가 없어 플레이스홀더 — `thumbs::thumb_undecodable`, 변환은 하지
  않는다), `webm`/`weba`/`opus`/`oga` = audio(폰 녹음기 산출물이 대상 — `.webm` 동영상도 새 업로드부터는
  audio 로 분류된다). 서빙 mime 은 `sync_server::handlers::guess_mime`(한 쌍, 테스트가 강제).
  프런트 `lib/fileKinds.ts` 는 Rust `kind_from_ext` 를 소스 대조 테스트로 따라간다.
- **폰 UI**: `MobileAttachSheet` 의 사진은 **촬영**(`capture=environment`)·**갤러리**(capture 없음) 둘로
  쪼갠다. 갤러리 사진이 EXIF GPS 를 보존하는지는 브라우저·기기마다 달라 S22 실측 전에는 가정하지 않는다.

### 2.6b 날짜 — `note_dates` (SSOT: `docs/PLAN-2026-09-08-dates-rebuild.md`)

> 2026-09-08 재설계. 이전 모델(대표 = `notes.*`, 관련 날짜 = 얇은 `note_dates`)은
> `docs/GRILL-2026-09-07-schedule-and-links.md`(D1~D10)와
> `docs/PLAN-2026-09-07-reminder-2tier.md` 에 역사로 남아 있다.

노트의 날짜는 **행 목록 하나**다. 각 행이 **정밀도 사다리**(연 → 월 → 일 → 시:분)와 기간·알림·
반복을 전부 갖고, **`position 0` 행이 사건 축(대표)** 이다. 대표와 나머지 사이에 **능력 차이가
없다** — 반복도 시각도 어느 행에나 붙는다.

- **`notes.{year,month,day,end_*,remind,start_time,end_time,remind_offset_min,rrule}` 는 그
  행의 투영(mirror)** 이다. 진실은 `note_dates` 한 곳이고, 투영을 갱신하는 함수는
  `repo::notes::dates::project_primary` **하나뿐**이다 — 행을 만들거나 고치거나 지우거나
  position 을 바꾸는 모든 경로가 같은 트랜잭션에서 그걸 부른다. 컬럼을 남겨둔 이유는 루틴
  (`repo/routine.rs`)·달력(`calendar.rs`, 부분 인덱스 `idx_notes_rrule_span`)·검색·내보내기·
  ical 이 전부 그 컬럼을 읽기 때문이다. `notes.*` 를 직접 쓰면 다음 `project_primary` 가 그
  값을 조용히 되돌린다(실제로 AI 정리 두 경로가 그 상태였다).
- **발화는 시작일, 미처리는 종료일**(없으면 시작일). 서로 다른 두 질문이므로 규칙도 둘이다 —
  옛 `schedule::anchor_date`("시각 있으면 시작일, 없으면 종료일")는 **삭제됐다.** 그건 규칙이
  아니라 "기간의 어느 순간이냐"를 사용자에게 못 물어봐서 하던 추측이었고, 기간에 시각을 넣으면
  알림 날짜가 말없이 옮겨가는 놀라움이 거기서 나왔다. 기간의 끝에 알림을 받고 싶으면 **끝 날짜를
  행으로 하나 더 넣는다** — 추측 대신 데이터다.
  같은 규칙이 SQL 에도 한 벌 있었다(`notes.pin_anchor_sort_key` 생성 컬럼, 칸반 정렬이 그
  인덱스를 탄다) — V77 이 거기서도 `start_time` 분기를 걷어냈다.
- **완료는 그 행의 알림을 끄는 것**이다(어느 행이든). 노트를 `done` 으로 만드는 것은 상태
  컨트롤의 일이고, done 노트가 안 울리는 동작은 모든 행에 똑같이 적용된다.
- **커맨드는 행 커맨드 한 벌**: `note_date_add` · `note_date_update` · `note_date_remove` ·
  `note_date_reorder` · `note_date_make_primary` · `note_dates_list`(position ASC, **첫 항목이
  대표**). `note_date_update` 는 **전량 교체** 계약이다 — 코드젠이 "생략 가능"과 "명시적 null" 을
  입력에서 둘 다 `Option<T>` 로 접어버려 부분 갱신을 안전하게 표현할 수 없고, 정밀도·기간·시각·
  반복이 서로 교차 검증되는 값 뭉치라 부분 갱신은 불변식이 깨진 중간 상태를 만든다.
  옛 `note_set_schedule`/`note_set_remind`/`note_set_event_precision`/`note_set_event_end`/
  `note_date_set_remind`/`note_date_set_schedule` 여섯은 **삭제됐다.**
- **승격은 `position` 교환**이다. 옮길 값이 없으므로 흘릴 값도 없다. 대표는 자동으로 바뀌지
  않는다 — 관련 날짜 하나를 넣는 것만으로 사건 축(연대 필터·타임라인·그래프가 보는 축)이 조용히
  바뀌면 안 되기 때문이다.
- **`notes.year` 의 의미는 그대로**다. NOT NULL 이고 연대 필터·타임라인·그래프가 그 축만 본다.
- 툼스톤·번들 왕복·LWW 는 `note_regions` 와 같은 규율을 따른다(`docs/SYNC.md` §8.5).
- UI: **표면은 날짜 칩 팝오버 하나**다. 달력 + 입력 두 칸 + 추가 + 행 목록이 한 곳에 있고,
  행을 누르면 달력이 그 행을 편집하며, 행의 벨을 누르면 그 행 아래에 알림 설정이 인라인으로
  펼쳐진다. 제목줄 벨 아이콘과 별도 알림 모달은 없다(2026-09-08 제거).
  관련 날짜가 있는 날에는 점 표식이 남고, 대표 날짜의 선택 원과 다른 색이다.
- UI: **날짜 칩 하나**(`DateBadge`)가 대표 날짜와 관련 날짜를 함께 소유한다 — 닫힌 칩은 대표
  날짜 요약에 관련 날짜가 있을 때만 개수를 덧붙이고, 팝오버 하나에 날짜 고르기와
  `NoteDatesList` 가 함께 들어간다. 지역 칩이 대표+경유지를 한 칩으로 다루는 것과 같은 모양이고,
  메타 줄의 폭 압박(폴더 칩이 폭을 픽셀로 묶어 태그 자리를 지킨다)이 이유다. 칩이 다시 둘로
  갈라지는 것은 `dateChipMerge.contract.test.ts` 가 막는다.
- **팝오버 본체는 `titlebar/DatesPanel.tsx`로 뽑혀 있다**(2026-09-10,
  `docs/PLAN-2026-09-10-calendar-reminders.md` D1~D2) — 입력은 "노트 id 하나"뿐이고, 대표 행도
  그냥 `note_dates_list`의 position 0 행이라 `"primary"` 센티널이나 활성 노트 여부로 갈리던
  `canEditPrimary` 게이트는 삭제됐다. 대표든 관련이든 편집은 그 행의 `note_date_update` 한 길이다.
  달력에서도 **관련 날짜가 대표와 같은 경로(`CalRow`/`push_row`)를 타** 시각·기간·부분 정밀도·반복이
  전부 반영된다 — 예전엔 별도 SQL이 `year/month/day` 한 점만 읽고 시각을 하드코딩된 `None`으로
  돌려 넷 다 빠졌다. `kind="extra"`는 은퇴했고 관련 날짜인지는 `position !== 0`으로 판정한다.
- **같은 행 목록을 세 표면이 공유한다** — 노트 탭 날짜 칩 팝오버(`DatesPanel`), 달력 드래그 생성
  팝오버(제목·폴더 입력 뒤에 `DatesPanel`을 인라인으로 품는다), 달력 카드/시간축의 펼친 상세
  (`FocusedDetails`, `home/calendar/DayDetailPanel.tsx` — 시간축 항목도 카드와 같은 이 컴포넌트를
  쓴다). 한 곳에서 벨을 끄면 세 표면 모두 같은 결과를 본다(`bumpNoteQueryVersion` +
  `reloadActive`).

### 2.7 폴더 / 태그 / 컨텍스트 메뉴

- **폴더 트리**: `src/stores/notesTree.ts`(`NotesTreeSlice` — `loadTree`/`loadTreeForBoot`,
  태그 카운트 `refreshTagCounts`)가 폴더+노트 캐시를 소유. 폴더 CRUD 커맨드
  (`folder_create`/`folder_rename`/`folder_set_open`/`folder_set_color`/`folder_set_icon`/
  `folder_set_rules`)는 `specs/commands/notes.yaml`에, 트리 행 렌더는
  `src/components/leftpanel/notetree/`(`index.tsx`, `TreeListRow.tsx`) 담당.
- **태그**: 노트당 다대다(`note_tags`), `note_set_tags`로 전체 교체(없는 이름은 자동 생성, 고아
  태그는 정리). 태그 색상/병합/이름변경/삭제는 `tag_set_color`/`tag_merge`/`tag_rename`/`tag_delete`
  (모두 `specs/commands/notes.yaml`), 노트북별 집계는 `tag_counts`/`tag_colors`.
- **컨텍스트 메뉴**: `src/components/ContextMenu.tsx`가 노트/폴더 우클릭 메뉴 공통 구현
  (즐겨찾기·내보내기·복제·상태 변경·삭제·AI 정리 등). 트리 행(`TreeListRow.tsx`)이 열고,
  `ContextMenuDialogs.tsx`가 부가 대화상자(이동/내보내기/상태 변경)를 담당.

## 3. 데이터 모델

`specs/db/schemas/notes.sql` / `content.sql` 기준 (자세한 마이그레이션 이력은 두 파일의 주석
SSOT 참고):

### `notes`
| 컬럼 | 의미 |
|---|---|
| `id`, `folder_id`, `title` | 기본 |
| `year`(NOT NULL) / `month`/`day`(NULL) | 사건 축 시작일, 정밀도 단계적(연→연월→연월일) |
| `end_year`/`end_month`/`end_day`(NULL) | 사건 축 종료일(기간) — v28/v29, `due_at`은 v29에서 폐지·흡수됨 |
| `remind`(v30, `INTEGER NOT NULL DEFAULT 0`) | "알려줘" opt-in 플래그(칸반 핀/빨간점 필요조건) — position 0 행의 투영(§2.6b) |
| `is_favorite`, `region`, `status`, `icon`, `lat`/`lng` | 메타 |
| `start_time`/`end_time`/`remind_offset_min`/`rrule` | 일정(시각/알림/반복) — **`note_dates` position 0 행의 투영**(§2.6b), 쓰기는 `note_date_update` |
| `deleted_at`(v12) | 소프트 삭제(휴지통), NULL=정상 |
| `archived_at`(v36) | 아카이브(트리/대시보드에서 숨기되 FTS 유지), NULL=보임 |
| `exported_at` | 마지막 내보내기 시각 |
| `created_at`/`updated_at` | ISO8601 UTC |

### `sections` (`content.sql`)
| 컬럼 | 의미 |
|---|---|
| `id`, `note_id`, `name`, `position` | 기본 |
| `body_md`(NOT NULL DEFAULT '') | 저장 포맷은 항상 markdown(단, kind='diagram'/'sheet'는 각각 mermaid 소스/시트 JSON). 텍스트 섹션의 마크다운에는 마크다운이 못 쓰는 서식이 **HTML 조각**으로 섞인다: 글자색 `<span style>`, 정렬·들여쓰기 문단 `<p data-brise-align>`(양쪽 정렬 포함), 각주·날짜 `<span data-*>`, 그리고 병합·셀 배경·여러 블록 셀·서식 문단이 있는 표는 GFM 대신 **한 줄짜리 `<table>` 조각**(그 밖의 표는 GFM 그대로 — `tableColwidth.ts`, PLAN-2026-10-07-doc-import-export W0). 조각이 든 본문은 폰에서 읽기 전용(`canEditBodyOnMobile`) |
| `kind`(v26/v57, CHECK IN `('text','diagram','sheet')`, DEFAULT 'text') | 섹션 타입 |
| `updated_at`(v24, NULL 허용) | Sync LWW용 |

### `sources` (`content.sql`)
`id`/`note_id`/`name`/`ext`/`body`(원문 전문, read-only)/`position`/`created_at`(+`updated_at` v24).

### `attachments` (`content.sql`)
| 컬럼 | 의미 |
|---|---|
| `id`, `note_id`, `name` | 기본 |
| `kind`(CHECK) | `image`\|`doc`\|`link`\|`audio`\|`note`\|`internal`\|`footnote`\|`chart`(V88) |
| `rel_path` | `data_dir/attachments/{note_id}/` 하위 상대경로. link/internal/chart면 NULL |
| `url` | link URL · internal 대상 note id · chart `"<section_id>#<chart_id>"` · footnote anchor_text(선택) |
| `size_bytes`, `position`, `created_at` | |
| `content_hash`(v24) | SHA-256 hex, 파일 kind에만 채움(link/internal은 NULL). UPDATE 경로 없음(생성 후 불변) |

CHECK 제약(V88): `(kind IN ('link','internal','chart') AND url NOT NULL AND rel_path NULL) OR (kind='footnote' AND
rel_path NOT NULL) OR (그 외 kind AND rel_path NOT NULL AND url NULL)`.

### `tags` / `note_tags`
`tags(id, name COLLATE NOCASE UNIQUE, color_hue?, updated_at?)`, `note_tags(note_id, tag_id)` 복합 PK.

## 4. 핵심 코드 경로

| 영역 | 경로 |
|---|---|
| IPC 커맨드 계약 | `specs/commands/notes.yaml`, `specs/commands/sections.yaml`, `specs/commands/attachments.yaml` |
| DB 스키마 | `specs/db/schemas/notes.sql`, `specs/db/schemas/content.sql` |
| 노트 CRUD (Rust) | `src-tauri/src/repo/notes/mod.rs` |
| 섹션 CRUD (Rust) | `src-tauri/src/repo/sections.rs` |
| 첨부 CRUD (Rust) | `src-tauri/src/repo/attachments/mod.rs`(+ `exif_region.rs`) |
| 설정 키 검증 (attachment_storage_mode 등) | `src-tauri/src/repo/settings_schema.rs` |
| 에디터 패널 | `src/components/EditorPanel.tsx` |
| 섹션 탭 바 | `src/components/editor/SectionTabBar.tsx` |
| 다이어그램/시트 섹션 렌더 | `src/components/diagram/DiagramSection.tsx`, `src/components/sheet/SheetSection.tsx` |
| 활성 노트 스토어(캐럿 보존 규칙) | `src/stores/notesActive.ts` (`updateSectionBody`, `reloadActive`) |
| 트리 스토어(폴더/태그) | `src/stores/notesTree.ts` |
| 조립 스토어 | `src/stores/notes.ts` |
| 원문 사료 패널 | `src/components/SourcePanel.tsx` |
| 프리뷰 패널 | `src/components/preview/*.tsx` (`SectionPreview.tsx`가 섹션 프리뷰) |
| 첨부 UI | `src/components/AttachmentsBar.tsx` + `src/components/attachments/*` |
| 컨텍스트 메뉴 | `src/components/ContextMenu.tsx`, `src/components/ContextMenuDialogs.tsx` |
| 트리 행 | `src/components/leftpanel/notetree/index.tsx`, `TreeListRow.tsx` |
| 커맨드 타입 (생성됨) | `src/lib/commands.gen.ts` |

## 5. 알려진 한계/결정

- **`EditorPanel.tsx` 훅 순서**: 조기 반환(`if (!editor || !activeNote) return null`) 아래에는
  훅을 두지 않는다 — 과거 위반으로 앱 전체 백지 크래시 2회(§2.3, `CLAUDE.md` 함정 1).
- **TipTap 인스턴스 수명**: `useEditor`에 deps 배열이 있는 컴포넌트(`SectionPreview.tsx`)는 섹션
  전환 시 이전 인스턴스가 destroy된다 — 비동기 뒤 `.commands.*` 호출 전 `isDestroyed` 확인 필수
  (§2.5, `CLAUDE.md` 함정 2).
- **스토어 신선도**: `updateSectionBody`는 캐럿 튐 방지를 위해 `activeNote.sections`를 갱신하지
  않는다 — 최신 섹션 본문이 필요하면 `flushAll()` 후 `note_get`으로 DB에서 다시 읽어야 한다(§2.4).
  이 설계는 트레이드오프다: 단일 섹션 노트는 문제없지만, 멀티 섹션 노트를 한 탭씩 비워나가는 경우
  `activeBodyEmpty` 판정이 스토어의 stale 캐시 기준이라 정확한 "전체 빈 상태" 시점보다 늦게
  갱신될 수 있다(`notesActive.ts`의 `updateSectionBody` 안 ponytail 주석 참고 — 업그레이드
  경로는 `EditorPanel`의 `bodyCacheRef`를 스토어에 넘기는 것).
- **설정 키 allowlist**: `attachment_storage_mode`처럼 새 설정 키는
  `src-tauri/src/repo/settings_schema.rs::validate_setting`에 arm을 추가하지 않으면 저장이 조용히
  실패한다(`CLAUDE.md` 함정 3).
- **스냅샷/복원**, **통합 검색**은 이 문서 범위 밖 — 각각 `docs/ACTIVITY.md`, `docs/SEARCH.md` 참고.
