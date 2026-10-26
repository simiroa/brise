// 임시 개발용 테스트 DB 시더 — 설정 최하단 "테스트 DB" 토글(TestDataSection)이 유일한 호출자.
// 기능 QA 를 위해 다양한 타입(텍스트/할일/관계도/시트/일정/지역/타임라인/태그/상태/즐겨찾기/
// 내부링크(그래프)/외부링크/공간)이 든 노트북 하나를 통째로 만든다. 실제 데이터는 건드리지
// 않는다: 켜기 = 새 노트북 생성+시드, 끄기 = 그 노트북 삭제(workspace_delete CASCADE).
// ponytail: 진행률/부분 실패 복구 없음 — 실패하면 노트북을 지우고 다시 켜면 된다.
import { call, callSilent } from "./invoke";
import type { Folder, NoteDetail, Workspace } from "./commands.gen";
import { replacePrimaryDate } from "./primaryDate";

/** 토글의 온오프 판정 기준 — 이 이름의 노트북이 존재하면 "켜짐". 별도 설정 키를 만들지 않는다
 *  (설정 키는 Rust allowlist 왕복이 필요한데, 임시 도구가 그 비용을 질 이유가 없다). */
export const TEST_DB_NAME = "테스트 DB";

const RICH_BODY = `# 브리즈 출시 계획

**목표**: 9월 말 공개 베타.

## 남은 일
- 온보딩 다듬기
- ~~아이콘 교체~~
- 성능 측정

> 범위를 늘리지 말 것 — 지금 있는 걸 끝내는 게 먼저.

| 단계 | 기한 |
| --- | --- |
| 내부 테스트 | 9/5 |
| 공개 베타 | 9/28 |
`;

const TODO_BODY = `- [ ] 장보기 — 우유, 달걀
- [x] 보고서 초안 보내기
- [ ] 치과 예약
- [ ] 서버 백업 확인
`;

const DIAGRAM_BODY = `flowchart TD
  n1["기획"] -->|"확정"| n2["디자인"]
  n2 -->|"검수"| n3["개발"]
  n3 -->|"배포"| n4["운영"]`;

async function newNote(
  folderId: string,
  title: string,
  opts: { year?: number; month?: number; day?: number; body?: string } = {},
): Promise<NoteDetail> {
  const detail = await call<NoteDetail>("note_create", {
    folder_id: folderId,
    title,
    ...(opts.year != null ? { year: opts.year } : {}),
    ...(opts.month != null ? { month: opts.month } : {}),
    ...(opts.day != null ? { day: opts.day } : {}),
  });
  if (opts.body) {
    const first = detail.sections[0]; // 방금 만든 섹션 — note_create 응답 토큰(D2②)
    await call("section_update", {
      id: first.id,
      body_md: opts.body,
      ...(first.updated_at ? { expected_updated_at: first.updated_at } : {}),
    });
  }
  return detail;
}

const link = (from: NoteDetail, to: NoteDetail) =>
  call("attachment_add_internal", {
    note_id: from.note.id,
    target_note_id: to.note.id,
    name: to.note.title,
  });

/** 테스트 노트북을 만들고 채운다. 이미 있으면 그대로 반환(중복 생성 방지). */
export async function seedTestDb(): Promise<Workspace> {
  const { workspaces } = await call<{ workspaces: Workspace[] }>("workspace_list", {});
  const existing = workspaces.find((w) => w.name === TEST_DB_NAME);
  if (existing) return existing;

  const ws = await callSilent<Workspace>("workspace_create", { name: TEST_DB_NAME });

  // 분류 체계 — 상태/지역/시대 (지역·상태는 노트에 실제로 붙여서 필터/보드/지도까지 검증 가능하게)
  await callSilent("workspace_status_add", { workspace_id: ws.id, name: "검토중" }).catch(() => {});
  await callSilent("workspace_region_add", { workspace_id: ws.id, name: "서울" }).catch(() => {});
  await callSilent("workspace_region_add", { workspace_id: ws.id, name: "파리" }).catch(() => {});
  await callSilent("workspace_era_add", { workspace_id: ws.id, name: "준비기", from_year: 2020, to_year: 2023 }).catch(() => {});
  await callSilent("workspace_era_add", { workspace_id: ws.id, name: "성장기", from_year: 2023, to_year: 2026 }).catch(() => {});

  // 폴더 — workspace_create 가 시드한 기본 "Notes" + 색 있는 폴더 2개
  const { folders } = await call<{ folders: Folder[] }>("folder_list", { workspace_id: ws.id });
  const defaultFolder = folders[0];
  const people = await call<Folder>("folder_create", { name: "인물", workspace_id: ws.id, color_hue: 210 });
  const project = await call<Folder>("folder_create", { name: "프로젝트", workspace_id: ws.id, color_hue: 30 });

  // 인물 — 그래프에서 서로 연결될 노드들
  const kim = await newNote(people.id, "김민준", { body: "팀장. 제품 방향을 잡는다." });
  const lee = await newNote(people.id, "이서연", { body: "디자이너. 화면 전반을 맡는다." });
  const park = await newNote(people.id, "박도현", { body: "개발자. 백엔드 담당." });
  await call("note_set_tags", { id: kim.note.id, tag_names: ["인물", "팀장"] });
  await call("note_set_tags", { id: lee.note.id, tag_names: ["인물", "디자인"] });
  await call("note_set_tags", { id: park.note.id, tag_names: ["인물", "개발"] });
  await call("note_set_region", { id: kim.note.id, region: "서울" });
  await call("note_toggle_favorite", { id: kim.note.id });

  // 프로젝트 — 섹션 타입 3종(텍스트+관계도, 시트), 일정, 상태
  const plan = await newNote(project.id, "브리즈 출시 계획", { body: RICH_BODY });
  await call("section_create_with_body", {
    note_id: plan.note.id, name: "관계도", body_md: DIAGRAM_BODY, kind: "diagram",
  });
  await call("note_set_status", { id: plan.note.id, status: "in_progress" });
  await call("note_toggle_favorite", { id: plan.note.id });

  const budget = await newNote(project.id, "예산 정리");
  const { createBudgetSheetJson } = await import("../components/sheet/sheetStarter");
  await call("section_create_with_body", {
    note_id: budget.note.id, name: "가계부", body_md: createBudgetSheetJson(), kind: "sheet",
  });

  const meeting = await newNote(project.id, "주간 회의", { body: "매주 진행 상황 공유." });
  // PLAN-2026-09-08-dates-rebuild.md W4: note_set_schedule was deleted — replacePrimaryDate is
  // the id-free replacement (meeting was just created above, so no pre-existing related dates).
  await replacePrimaryDate(meeting.note.id, {
    start_time: "10:00", end_time: "11:00", remind_offset_min: 10, rrule: "FREQ=WEEKLY",
  });

  const todo = await newNote(project.id, "할 일 모음", { body: TODO_BODY });
  await call("note_set_status", { id: todo.note.id, status: "in_progress" });

  const travel = await newNote(project.id, "파리 여행 기록", { year: 2024, month: 5, day: 12, body: "5월의 파리. 몽마르트르 언덕." });
  await call("note_set_tags", { id: travel.note.id, tag_names: ["여행"] });
  await call("note_set_region", { id: travel.note.id, region: "파리" });
  await call("note_set_location", { id: travel.note.id, lat: 48.8566, lng: 2.3522 });

  const research = await newNote(project.id, "리서치 링크", { body: "참고 자료 모음." });
  await call("attachment_add_link", { note_id: research.note.id, name: "Tauri 문서", url: "https://tauri.app/" });
  await call("attachment_add_link", { note_id: research.note.id, name: "SQLite WAL", url: "https://sqlite.org/wal.html" });

  // 타임라인용 과거 노트 + 상태 done
  const retro2020 = await newNote(defaultFolder.id, "2020 회고", { year: 2020, body: "시작한 해." });
  await call("note_set_status", { id: retro2020.note.id, status: "done" });
  await newNote(defaultFolder.id, "2022 중간 점검", { year: 2022, body: "방향 조정." });
  const idea = await newNote(defaultFolder.id, "아이디어 메모", { body: "떠오르는 것들." });

  // 그래프 — 내부 링크(backlink) 망
  await link(kim, lee);
  await link(kim, park);
  await link(plan, kim);
  await link(plan, budget);
  await link(idea, research);

  return ws;
}
