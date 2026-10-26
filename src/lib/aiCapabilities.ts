import type { SimplePrefKey } from "../stores/settings";
import { BUILTIN_DEFS, isAgentPlanPreset } from "../stores/aiPrompts";

/**
 * AI 기능 카탈로그 SSOT (docs/PLAN-2026-08-30-ai-surface-and-clients.md §2-3, §3 W2).
 *
 * 오너 요구: "AI 기능 on/off 리스트를 제공하자. 사용자가 명시적으로 '아 이런 게 되네/안 되네'를
 * 알도록 하자." — 이 파일이 그 목록의 유일한 데이터 소스다. AiCapabilityCatalog.tsx 가 이 배열을
 * 그대로 그리고, aiCapabilities.test.ts 가 이 배열이 실제 코드(BUILTIN_DEFS/SimplePrefKey)와
 * 어긋나지 않는지 양방향으로 검사한다.
 *
 * 3계층(§2):
 *   refine   (L1 손질) — 내가 쓴 것을 읽고 다듬는다. 원본 보존, 결과는 새 섹션.
 *   organize (L2 정돈) — 구조·메타데이터를 붙인다. 제안 → 확인 → 적용.
 *   gather   (L3 수집) — 바깥의 것을 들여온다. 원문은 사료 패널에 보존.
 *
 * i18n 키는 전부 **리터럴 문자열**로 쓴다(`aiCapabilities.${id}_name` 처럼 조립하지 않는다) —
 * check-i18n.mjs 의 "미사용 키" 검사는 소스에 리터럴로 등장하는 문자열만 "쓰였다"고 인정한다.
 * 조립식 키를 썼다면 scripts/i18n-dynamic-prefixes.json 에 통째 예외를 등록해야 했을 텐데, 그러면
 * 이 네임스페이스 전체가 "미사용 키" 검사의 사각지대가 된다 — 항목이 빠지면 조용히 안 잡힌다.
 */
export type AiCapabilityTier = "refine" | "organize" | "gather";

/**
 * AI가 건드리는 대상 — "어떻게 돕는가"(tier)와 직교하는 "무엇을 건드리는가" 축(W10, 오너 요구
 * 2026-08-30). editor 와 note 의 구분이 이 체계의 핵심이다: editor = 지금 열려 있는 섹션 본문만
 * (`lib/aiSectionBridge.ts::getActiveSection`), note = 노트 전체(메타데이터·분리·병합, `note_get`
 * 또는 노트 단위 작업). 둘을 섞으면 "본문을 손질하나 vs 노트 자체를 바꾸나"가 다시 흐려진다.
 */
export type AiCapabilityTarget =
  | "editor"
  | "note"
  | "folder"
  | "notebook"
  | "sheet"
  | "diagram"
  | "chat"
  | "link"
  | "collect";

export type AiCapabilityControl =
  | { kind: "setting"; key: SimplePrefKey } // 진짜 킬스위치 — settings_schema.rs validate_setting 대상
  | { kind: "preset"; presetId: string } // ai_action_presets[].hidden 재사용 — 메뉴 노출 토글
  | { kind: "link"; page: string }; // 다른 설정 페이지로 위임(그 페이지가 이미 토글을 갖고 있음)

export interface AiCapability {
  id: string;
  tier: AiCapabilityTier;
  /** 무엇을 건드리는가 — 필수(옵셔널이면 새 항목에서 조용히 빠질 수 있다). */
  target: AiCapabilityTarget;
  /** i18n 키 3종 — 이름 / "무엇을 읽는가" 한 줄 / 자세히 보기 본문. 전부 aiCapabilities 네임스페이스. */
  nameKey: string;
  readsKey: string;
  detailKey: string;
  /**
   * 사용자가 쓴 콘텐츠(노트 본문·챗 내용·붙여넣은 문서)가 프로바이더로 나가는가 — "AI를 호출하나?"
   * (이 카탈로그의 24항목은 전부 그렇다 — 그 질문은 무의미) 가 아니라 "**내 글이 나가나?**"를 묻는다.
   * 제목·태그·id 같은 메타데이터만 나가면 false, 본문/챗 텍스트/외부 문서가 실려 나가면 true.
   * readsKey 문구가 말하는 것과 같은 사실의 시각적 축약이므로 항목을 추가할 때 둘이 모순되지
   * 않는지 대조할 것 — 판단 근거는 아래 각 항목 옆 주석에 코드 경로로 남긴다(추측 금지).
   *
   * 프로바이더가 로컬 Ollama 면 external=true 여도 AiCapabilityCatalog 가 런타임에 배지를 꺼서
   * 보여준다(settings/shared.ts::isExternalProvider, privacy_gate_ok 와 같은 판정) — 그 판정과
   * 이 필드는 서로 다른 축이다: 이 필드는 "무엇이 나가는가"(항목별 고정값), 그 판정은 "지금 나갈
   * 수 있는 채널이 열려 있는가"(런타임).
   */
  external: boolean;
  control: AiCapabilityControl;
}

interface BuiltinCatalogMeta {
  tier: AiCapabilityTier;
  target: AiCapabilityTarget;
  nameKey: string;
  readsKey: string;
  detailKey: string;
  external: boolean;
}

// ── 온디맨드 (BUILTIN_DEFS 전부 — 새 액션이 생기면 builtinCapability() 가 즉시 throw 하고,
//    aiCapabilities.test.ts (d) 케이스도 같은 사실을 테스트로 잡는다) ─────────────────────────
//
// 계층 판단 근거 (docs/AI.md §2, §4):
//   refine   — list/organize/summarize/proofread: 현재 섹션 본문을 읽어 새 섹션으로 다듬는다.
//              sheet/sheet_edit: plan §2-2 에 명시가 없어 판단함 — 표 데이터를 새 섹션에 넣거나
//              그 섹션 자체를 다시 쓸 뿐 노트의 메타데이터·구조는 건드리지 않는다(diagram 과 달리
//              "개체 사이의 관계"를 추출하는 게 아니다), 그래서 refine.
//              fill_note: 사이드바 챗이 초안을 새 섹션으로 넣는다 — 결과물의 모양이 L1과 같다.
//   organize — metadata/diagram/diagram_edit: 구조·관계·메타데이터를 붙인다(plan §2-2 명시).
//              agent_split/agent_folder/agent_workspace/agent_merge: 계획 지침(propose-only),
//              메뉴에서 직접 실행되지 않는다 — isAgentPlanPreset 가드(아래 detailKey 문구에 명시).
//              rename_plan/prune_plan: *_plan 명명 그대로 propose-only 계획(챗이 트리거지만
//              결과는 제목/삭제/병합 "제안" — organize 의 "제안→확인→적용" 계약과 같은 모양).
//   gather   — ask_note/find_related: 사이드바 비서가 노트북 안을 검색·설명해 대화로 가져온다
//              (§2-1 "펫/사이드바 비서 챗" 항목과 같은 계층으로 묶는다).
const BUILTIN_META: Record<string, BuiltinCatalogMeta> = {
  // external 판단 근거는 항목별 코드 경로 — 표는 최종 보고에, 여기는 한 줄 근거만.
  list: {
    tier: "refine",
    target: "editor", // runAiAction.ts:284 getActiveSection()?.body_md — 지금 보고 있는 섹션만.
    nameKey: "aiCapabilities.list_name",
    readsKey: "aiCapabilities.list_reads",
    detailKey: "aiCapabilities.list_detail",
    // 현재 섹션 본문 전체가 ai_generate_from_prompt 의 context_text 로 전송된다(LIST_PROMPT).
    external: true,
  },
  organize: {
    tier: "refine",
    target: "editor", // 같은 runAiAction.ts 텍스트 분기 — getActiveSection() 뿐, 노트 전체 아님.
    nameKey: "aiCapabilities.organize_name",
    readsKey: "aiCapabilities.organize_reads",
    detailKey: "aiCapabilities.organize_detail",
    external: true, // ORGANIZE_PROMPT — 같은 메커니즘, 현재 섹션 본문 전체 전송.
  },
  summarize: {
    tier: "refine",
    target: "editor", // 같은 runAiAction.ts 텍스트 분기 — getActiveSection() 뿐, 노트 전체 아님.
    nameKey: "aiCapabilities.summarize_name",
    readsKey: "aiCapabilities.summarize_reads",
    detailKey: "aiCapabilities.summarize_detail",
    external: true, // SUMMARIZE_PROMPT — 같은 메커니즘, 현재 섹션 본문 전체 전송.
  },
  proofread: {
    tier: "refine",
    target: "editor", // 같은 runAiAction.ts 텍스트 분기 — getActiveSection() 뿐, 노트 전체 아님.
    nameKey: "aiCapabilities.proofread_name",
    readsKey: "aiCapabilities.proofread_reads",
    detailKey: "aiCapabilities.proofread_detail",
    external: true, // PROOFREAD_PROMPT — 같은 메커니즘, 현재 섹션 본문 전체 전송.
  },
  metadata: {
    tier: "organize",
    target: "note", // 입력은 섹션 본문이지만 출력은 노트 단위 필드(제목·태그·연도·지역·폴더).
    nameKey: "aiCapabilities.metadata_name",
    readsKey: "aiCapabilities.metadata_reads",
    detailKey: "aiCapabilities.metadata_detail",
    // repo/ai.rs::ai_organize_note_inner 가 현재 노트 첫 섹션의 &sec.body_md(본문 전체)를 컨텍스트로
    // 실어 보낸다 — 출력은 메타데이터지만 입력은 본문 전체다. agent_folder(스캔, 본문 미전송)와
    // 다르다.
    external: true,
  },
  diagram: {
    tier: "organize",
    target: "diagram",
    nameKey: "aiCapabilities.diagram_name",
    readsKey: "aiCapabilities.diagram_reads",
    detailKey: "aiCapabilities.diagram_detail",
    external: true, // DIAGRAM_PROMPT — 현재 노트 본문 전체에서 개체·관계를 추출해야 하므로 전송.
  },
  diagram_edit: {
    tier: "organize",
    target: "diagram",
    nameKey: "aiCapabilities.diagram_edit_name",
    readsKey: "aiCapabilities.diagram_edit_reads",
    detailKey: "aiCapabilities.diagram_edit_detail",
    // buildDiagramEditPrompt(rules, source, instruction) — 현재 관계도 섹션 소스 전문을 프롬프트에 싣는다.
    external: true,
  },
  diagram_progress: {
    tier: "organize",
    target: "diagram",
    nameKey: "aiCapabilities.diagram_progress_name",
    readsKey: "aiCapabilities.diagram_progress_reads",
    detailKey: "aiCapabilities.diagram_progress_detail",
    // buildDiagramProgressPrompt(rules, source, noteBody) — 현재 관계도 섹션 소스와 노트 본문을 프롬프트에 싣는다.
    external: true,
  },
  diagram_expand_branch: {
    tier: "organize",
    target: "diagram",
    nameKey: "aiCapabilities.diagram_expand_branch_name",
    readsKey: "aiCapabilities.diagram_expand_branch_reads",
    detailKey: "aiCapabilities.diagram_expand_branch_detail",
    // buildDiagramExpandBranchPrompt(rules, source, targetNodeId, targetNodeLabel) — 현재 관계도 섹션 소스와 선택 노드 정보를 프롬프트에 싣는다.
    external: true,
  },
  sheet: {
    tier: "refine",
    target: "sheet",
    nameKey: "aiCapabilities.sheet_name",
    readsKey: "aiCapabilities.sheet_reads",
    detailKey: "aiCapabilities.sheet_detail",
    external: true, // SHEET_CREATE_PROMPT — "제공된 배경 내용" = 현재 섹션 본문 전체가 컨텍스트.
  },
  sheet_edit: {
    tier: "refine",
    target: "sheet",
    nameKey: "aiCapabilities.sheet_edit_name",
    readsKey: "aiCapabilities.sheet_edit_reads",
    detailKey: "aiCapabilities.sheet_edit_detail",
    // buildSheetEditPrompt(currentJson, instruction) — 기존 시트의 셀 데이터 전체(JSON)를 그대로
    // 프롬프트에 싣는다(aiPrompts.ts:354-356). 셀 값은 사용자가 입력한 데이터.
    external: true,
  },
  agent_split: {
    tier: "organize",
    target: "note", // 노트 하나를 여러 노트로 쪼개는 노트 단위 작업.
    nameKey: "aiCapabilities.agent_split_name",
    readsKey: "aiCapabilities.agent_split_reads",
    detailKey: "aiCapabilities.agent_split_detail",
    // docs/AI.md §4 Scope 1 — "Full note text body of the active note". 본문 전체 전송, 명시적으로
    // 확인됨(오너 검토 코멘트에서도 true로 확정).
    external: true,
  },
  agent_folder: {
    tier: "organize",
    target: "folder",
    nameKey: "aiCapabilities.agent_folder_name",
    readsKey: "aiCapabilities.agent_folder_reads",
    detailKey: "aiCapabilities.agent_folder_detail",
    // docs/AI.md §4 Scope 2 — note_query(folder_ids) 로 얻은 title/tags/id 만 전송(FOLDER_AI_SCAN_CAP
    // 500, body 미포함). 이 카탈로그에서 유일하게 본문이 아예 전송되지 않는 스캔형 두 항목 중 하나.
    external: false,
  },
  agent_workspace: {
    tier: "organize",
    target: "notebook",
    nameKey: "aiCapabilities.agent_workspace_name",
    readsKey: "aiCapabilities.agent_workspace_reads",
    detailKey: "aiCapabilities.agent_workspace_detail",
    // docs/AI.md §4 Scope 3 — Pass 1(workspaceAiFilter.ts, 로컬)이 title/tag_names/날짜 신호만으로
    // 최대 30건 후보를 압축하고, Pass 2 에도 그 압축 후보(제목·태그)만 전송된다. 본문 미전송.
    external: false,
  },
  agent_merge: {
    tier: "organize",
    target: "note", // 대상은 항상 노트 두 건 — 폴더·노트북 범위 스캔이 아니라 노트 단위 병합.
    nameKey: "aiCapabilities.agent_merge_name",
    readsKey: "aiCapabilities.agent_merge_reads",
    detailKey: "aiCapabilities.agent_merge_detail",
    // aiAgentActions.ts:387-395 buildMergeDraftPrompt — hydrateMergeSources 로 가져온 두 노트의
    // source.bodyMd(본문 전체)를 그대로 프롬프트에 싣는다. agent_folder 의 스캔 단계와 달리, 병합
    // "초안" 단계는 정확히 두 노트로 좁혀진 뒤 본문까지 읽는다.
    external: true,
  },
  ask_note: {
    tier: "gather",
    target: "chat",
    nameKey: "aiCapabilities.ask_note_name",
    readsKey: "aiCapabilities.ask_note_reads",
    detailKey: "aiCapabilities.ask_note_detail",
    // 프리셋 클릭 → SidebarChat.tsx::runPreset → send() → excerptFromActiveNote(active)
    // (petChatContext.ts:18-29, 열린 노트의 모든 섹션 body_md 를 합쳐 최대 4000자) 를
    // ctx 로 pet_chat IPC 에 실어 보낸다(chatPipeline.ts:72-77 `...(ctx ?? {})`). ASK_NOTE_PROMPT
    // 자체가 "지금 보고 있는 노트를 읽고" 이므로 본문이 필요하고 실제로 전송된다.
    external: true,
  },
  find_related: {
    tier: "gather",
    target: "chat",
    nameKey: "aiCapabilities.find_related_name",
    readsKey: "aiCapabilities.find_related_reads",
    detailKey: "aiCapabilities.find_related_detail",
    // ask_note 와 같은 send() 경로 — 열린 노트가 있으면 같은 4000자 본문 발췌가 동봉된다. FIND_
    // RELATED_PROMPT 도 "제목·태그·내용이 겹치는 것을 우선"이라 본문 비교를 전제로 한다.
    external: true,
  },
  fill_note: {
    tier: "refine",
    target: "chat", // 트리거는 챗(사이드바 send()) — 결과가 노트에 삽입되지만 진입 경로는 챗.
    nameKey: "aiCapabilities.fill_note_name",
    readsKey: "aiCapabilities.fill_note_reads",
    detailKey: "aiCapabilities.fill_note_detail",
    // 챗 대화 내용 자체(사용자가 쓴 지시문) + 같은 send() 경로의 노트 본문 발췌가 함께 전송된다.
    external: true,
  },
  rename_plan: {
    tier: "organize",
    // petChatPlan.ts:42-50 folderForActive() — 활성 노트에 폴더가 있으면 그 폴더만 스캔하고,
    // 없을 때만 노트북 전체로 떨어진다(generateWorkspaceRefactorPlan). 폴더 분기가 먼저 검사되는
    // 주 경로이므로 folder 로 판정 — notebook 은 예외 폴백이며 그 사실은 reads/detail 문구가 말한다.
    target: "folder",
    nameKey: "aiCapabilities.rename_plan_name",
    readsKey: "aiCapabilities.rename_plan_reads",
    detailKey: "aiCapabilities.rename_plan_detail",
    // 실제 계획 생성(petChatPlan.ts::generatePetChatPlan → generateFolderOrganizePlan /
    // generateWorkspaceRefactorPlan)은 agent_folder/agent_workspace와 같은 title/tags-only 스캔이라
    // 본문을 보내지 않는다. 그런데 그 계획을 트리거하는 최초 챗 전송이 ask_note 와 **같은**
    // runPreset → send() 경로를 그대로 타므로(SidebarChat.tsx:678-694), 열린 노트가 있으면 그
    // 본문 발췌(최대 4000자)가 RENAME_PLAN_PROMPT 와 함께 pet_chat 으로 나간다 — 모델이 그 발췌를
    // 실제로 쓰는지와 무관하게 전송 자체는 일어난다. 전송 여부를 기준으로 하므로 true.
    external: true,
  },
  prune_plan: {
    tier: "organize",
    target: "notebook", // 항상 노트북 전체(폴더 분기 없음) — agent_workspace 와 같은 스캔 대상.
    nameKey: "aiCapabilities.prune_plan_name",
    readsKey: "aiCapabilities.prune_plan_reads",
    detailKey: "aiCapabilities.prune_plan_detail",
    // rename_plan 과 정확히 같은 이유 — 계획 생성 자체는 title/tags-only 지만, 이를 트리거하는
    // 최초 챗 전송(runPreset → send())이 열린 노트의 본문 발췌를 동봉한다.
    external: true,
  },
};

function builtinCapability(id: string): AiCapability {
  const meta = BUILTIN_META[id];
  if (!meta) {
    // 새 BUILTIN_DEFS 항목이 추가됐는데 이 파일이 아직 모른다 — 조용히 누락시키지 않고 바로
    // 터뜨린다. aiCapabilities.test.ts (d) 케이스가 같은 사실을 테스트로도 잡는다.
    throw new Error(
      `aiCapabilities.ts: BUILTIN_DEFS id "${id}" has no catalog entry — add it to BUILTIN_META.`,
    );
  }
  return {
    id,
    tier: meta.tier,
    target: meta.target,
    nameKey: meta.nameKey,
    readsKey: meta.readsKey,
    detailKey: meta.detailKey,
    external: meta.external,
    control: { kind: "preset", presetId: id },
  };
}

// ── 자동 (§2-1 — 사용자가 부르지 않아도 도는 것. 진짜 킬스위치 또는 다른 설정 페이지로 링크) ──
// external 판단 근거는 각 항목 옆 주석 참고 — 전부 true 로 나온다(자동 6개는 전부 실제 사용자
// 콘텐츠·외부 문서를 실어 보내는 종류라서다). 이 카탈로그 전체에서 false 인 것은 온디맨드의
// agent_folder/agent_workspace(위 BUILTIN_META) 둘뿐 — 스캔형 title/tags-only 메커니즘이라
// 성격이 다르다.
const AUTO_CAPABILITIES: AiCapability[] = [
  {
    id: "ai_post_process",
    tier: "organize",
    target: "note", // metadata 와 같은 계약 재사용 — 노트 단위 메타데이터 제안.
    nameKey: "aiCapabilities.ai_post_process_name",
    readsKey: "aiCapabilities.ai_post_process_reads",
    detailKey: "aiCapabilities.ai_post_process_detail",
    // lib/aiPostProcess.ts — metadata 액션과 똑같은 ai_organize_note 계약을 재사용한다(docs/AI.md
    // §2.1). 즉 metadata 와 같은 이유로 현재 노트 본문 전체가 전송된다.
    external: true,
    control: { kind: "setting", key: "aiPostProcess" },
  },
  {
    id: "link_suggestions",
    tier: "gather",
    target: "link",
    nameKey: "aiCapabilities.link_suggestions_name",
    readsKey: "aiCapabilities.link_suggestions_reads",
    detailKey: "aiCapabilities.link_suggestions_detail",
    // commands/suggestions.rs:270,287 — fetch 한 page_text(외부 페이지 본문, LINK_SUMMARY_MAX_CHARS
    // 까지)를 프롬프트에 그대로 싣는다("Page text:\n{page_text}"). 붙여넣은 링크가 가리키는
    // 문서 자체가 나간다.
    external: true,
    control: { kind: "setting", key: "linkSuggestions" },
  },
  {
    id: "ai_chat_memory",
    tier: "gather",
    target: "chat",
    nameKey: "aiCapabilities.ai_chat_memory_name",
    readsKey: "aiCapabilities.ai_chat_memory_reads",
    detailKey: "aiCapabilities.ai_chat_memory_detail",
    // chatMemoryExtractor.ts:47 — 사용자가 그 턴에 쓴 문장 전체(trimmedUser, 캡 없음) + 답변 앞
    // 500자를 context 로 묶어 ai_generate_from_prompt 에 보낸다. 챗 내용 그 자체.
    external: true,
    // PLAN-2026-09-01 W0 — 실 스위치가 "AI 채팅" 페이지(기억 카드 옆)로 내려갔다. 카탈로그는
    // 발견 표면으로 남고 제어는 그 페이지 하나가 갖는다("스위치는 한 곳").
    control: { kind: "link", page: "ai_chat" },
  },
  {
    id: "collect_nl_source",
    tier: "gather",
    target: "collect",
    nameKey: "aiCapabilities.collect_nl_source_name",
    readsKey: "aiCapabilities.collect_nl_source_reads",
    detailKey: "aiCapabilities.collect_nl_source_detail",
    // commands/collect.rs::resolve_source_draft — 사용자가 입력한 자연어 문장 자체가 모델 입력이다
    // (추출 대상이 곧 사용자가 쓴 문장). 메타데이터를 뽑는 게 아니라 사용자 문장을 해석한다.
    external: true,
    control: { kind: "link", page: "collect" },
  },
  {
    id: "ledger_capture",
    tier: "gather",
    target: "collect",
    nameKey: "aiCapabilities.ledger_capture_name",
    readsKey: "aiCapabilities.ledger_capture_reads",
    detailKey: "aiCapabilities.ledger_capture_detail",
    // sync_server/ingest.rs:386(POST /ledger 본문 = 알림/문자 원문 그대로),:540
    // ai::parse_ledger_text_with_transport(...) 로 그 원문 텍스트를 그대로 전송한다.
    external: true,
    control: { kind: "link", page: "collect" },
  },
  {
    id: "pet_assistant",
    tier: "gather",
    target: "chat",
    nameKey: "aiCapabilities.pet_assistant_name",
    readsKey: "aiCapabilities.pet_assistant_reads",
    detailKey: "aiCapabilities.pet_assistant_detail",
    // 일반 펫/사이드바 챗 = ask_note 등과 같은 send() 경로 그 자체(대화 내용 + 열린 노트 본문
    // 발췌가 매 전송마다 동봉). 이 항목은 그 상위 우산이므로 같은 판정.
    external: true,
    control: { kind: "link", page: "pet" },
  },
];

/**
 * 카탈로그 전체 — BUILTIN_DEFS 의 온디맨드 액션 전부(계획 지침 포함, agent_* 는 organize 계층에
 * 들어가되 "메뉴에서 실행되지 않는다"는 사실이 detailKey 문구에 드러난다) + 자동 항목 6개.
 * 표시 순서: BUILTIN_DEFS 선언 순서 그대로 → 자동 항목. AiCapabilityCatalog 가 tier 로 재그룹한다.
 */
export const AI_CAPABILITIES: AiCapability[] = [
  ...BUILTIN_DEFS.map((def) => builtinCapability(def.id)),
  ...AUTO_CAPABILITIES,
];

/** 계획-전용(propose-only, 직접 실행되지 않는) 빌트인인가 — 카탈로그 UI가 "메뉴에 없음" 표식을
 *  붙일 때 쓴다. agent_* 4종 + *_plan 명명인 rename_plan/prune_plan. */
export function isPlanOnlyCapability(id: string): boolean {
  return isAgentPlanPreset({ id }) || id === "rename_plan" || id === "prune_plan";
}

export function capabilitiesByTier(tier: AiCapabilityTier): AiCapability[] {
  return AI_CAPABILITIES.filter((c) => c.tier === tier);
}

/**
 * 전역 AI 정책 레벨(W11, docs/PLAN-2026-08-30-ai-surface-and-clients.md §6-A) — 오너의 사다리
 * 예시("새 입력에만 사용" < "내용 요약만" < "폴더 관리까지")가 그대로 §2 의 3계층 순서다. 값
 * 집합이 AiCapabilityTier 와 완전히 같다("gather"|"refine"|"organize") — 정책 레벨이 "이 계층
 * 까지 허용"을 뜻하고, 각 기능의 tier 가 "이 계층에 속함"을 뜻하는 같은 축이기 때문이다. 별도
 * 유니온을 새로 만들지 않고 alias 로 둔다(두 타입이 갈라지면 isTierAllowed 비교 자체가 무의미).
 */
export type AiPolicyLevel = AiCapabilityTier;

/**
 * 사다리 순서 — 이 배열 하나가 랭크의 유일한 SSOT다(오너 요구: "tier 순서를 하드코딩된 배열 한
 * 곳에만 두고 UI/테스트가 그걸 공유하게"). 세그먼트 컨트롤의 표시 순서, isTierAllowed 의 랭크
 * 계산, aiCapabilities.test.ts 의 사다리 검증이 전부 이 배열만 읽는다.
 * (주의: AiCapabilityCatalog.tsx 의 TIER_ORDER 는 카탈로그 섹션 "표시 순서"(손질→정돈→수집)라
 * 목적이 다르다 — 그건 그대로 둔다.)
 */
export const AI_POLICY_LEVELS: AiPolicyLevel[] = ["gather", "refine", "organize"];

/** 이 정책 레벨에서 저 tier 의 기능이 허용되는가 — Rust 쪽
 *  commands::ai::AiPolicyLevel::parse/require_ai_policy_level 과 같은 판정(사다리는 누적:
 *  "organize" 정책은 "refine"·"gather" tier 를 전부 포함한다). */
export function isTierAllowed(tier: AiCapabilityTier, level: AiPolicyLevel): boolean {
  return AI_POLICY_LEVELS.indexOf(tier) <= AI_POLICY_LEVELS.indexOf(level);
}
