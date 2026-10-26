// AI 메타데이터 제안(ai_organize_note) 을 필드 단위 선택 UI 로 바꾸기 위한 순수 함수 모음.
// 배경: docs/PLAN-2026-09-05-ai-guardrails.md §0 A-0/A-1/A-2, §1. AiConfirmModal 과
// AiBatchOrganizeModal 이 이 모듈을 공유한다 — 두 번째 구현을 만들지 않는다([[similar-features-same-path]]).
//
// 핵심 계약(§1 A-2 표):
//   채움  — 현재 비어 있음, 제안 있음 → 기본 선택 ON  (잃을 게 없다)
//   덮어씀 — 현재 값 있고 제안과 다름 → 기본 선택 OFF (사용자 값을 지우는 일)
//   동일  — 현재 == 제안              → 행 자체를 만들지 않는다(호출자가 숨길 필요 없음)
//
// 태그는 `replace_note_tags`(notes/mod.rs)가 통째 교체이므로 3구역으로 쪼갠다:
//   유지(kept) — 현재∩제안, 체크박스 없음(항상 살아남는다)
//   추가(added) — 제안에만, 기본 ON(소프트캡 초과분만 기본 OFF)
//   제거(removed) — 현재에만, 기본 OFF(체크해야 지운다)
// 최종 집합 = kept ∪ selectedAdded ∪ (removed \ selectedRemoved) — kept 는 선택 여부와 무관하게
// 항상 포함되므로, "모델이 기존 태그를 그대로 돌려줬을 때 소프트캡 때문에 지워지는" A-0 손실이
// 구조적으로 불가능해진다.

import type { NoteSummary } from "./commands.gen";

/** Only the NoteSummary fields this module diffs against — callers (incl. fallback stubs when a
 *  note isn't in noteIndex yet) don't need to fabricate the rest of NoteSummary. */
export type CurrentNoteFields = Pick<NoteSummary, "title" | "year" | "region" | "lat" | "lng" | "folder_id" | "tag_names">;

/** All-empty stand-in for a note that isn't (yet) in noteIndex — same fallback both AiConfirmModal
 *  and AiBatchOrganizeModal need when a proposal/row targets a note the tree hasn't loaded. Single
 *  definition so the two modals can't drift on what "empty" means here. */
export const FALLBACK_CURRENT: CurrentNoteFields = {
  title: "",
  year: 0,
  region: null,
  lat: null,
  lng: null,
  folder_id: "",
  tag_names: [],
};

/** ai_organize_note 응답 중 이 모듈이 다루는 부분집합. AiOrganizeResult 는 이 형태를 만족한다. */
export interface OrganizeProposalLike {
  title?: string | null;
  year?: number | null;
  tag_names?: string[] | null;
  region?: string | null;
  folder_id?: string | null;
  folder_name?: string | null;
  lat?: number | null;
  lng?: number | null;
  source_urls?: string[] | null;
}

/** 배치 모달의 체크박스 미노출 태그 처리에도 쓰는 소프트캡 — AI 정리 적용 UI 공통 상수. */
export const TAG_APPLY_SOFT_CAP = 10;

export function isBlankText(value: string | null | undefined): boolean {
  return value == null || value.trim() === "";
}

export type FieldDiffState = "fill" | "overwrite" | "add";

export interface TitleFieldDiff {
  key: "title";
  state: "fill" | "overwrite";
  current: string;
  proposed: string;
  defaultSelected: boolean;
}
export interface YearFieldDiff {
  key: "year";
  state: "fill" | "overwrite";
  current: number;
  proposed: number;
  defaultSelected: boolean;
}
export interface RegionFieldDiff {
  key: "region";
  state: "fill" | "overwrite";
  current: string;
  proposed: string;
  defaultSelected: boolean;
}
export interface LocationFieldDiff {
  key: "location";
  state: "fill" | "overwrite";
  current: { lat: number; lng: number } | null;
  proposed: { lat: number; lng: number };
  defaultSelected: boolean;
}
export interface FolderFieldDiff {
  key: "folder_id";
  state: "overwrite";
  current: string;
  proposed: string;
  proposedName: string | null;
  defaultSelected: boolean;
}
export interface SourceUrlsFieldDiff {
  key: "source_urls";
  state: "add";
  proposed: string[];
  defaultSelected: boolean;
}

export type FieldDiff =
  | TitleFieldDiff
  | YearFieldDiff
  | RegionFieldDiff
  | LocationFieldDiff
  | FolderFieldDiff
  | SourceUrlsFieldDiff;

export type FieldDiffKey = FieldDiff["key"];

/** i18n label key per field — shared by AiConfirmModal's row labels and stores/ai.ts's revert-toast
 *  "can't undo: X" wording, so the two never name a field differently. */
export const FIELD_LABEL_KEYS: Record<FieldDiffKey, string> = {
  title: "ai.field_title",
  year: "ai.field_year",
  region: "ai.field_region",
  location: "ai.field_location",
  folder_id: "ai.field_folder",
  source_urls: "ai.field_sources",
};

/**
 * (current, proposal) → 보여줄 행 목록. "동일" 상태는 행을 만들지 않는다(§1 A-2 "행 숨김").
 * 순서는 모달이 그리는 순서(제목·연도·지역·위치·폴더·출처)와 같다.
 */
export function computeFieldDiffs(current: CurrentNoteFields, proposal: OrganizeProposalLike): FieldDiff[] {
  const diffs: FieldDiff[] = [];

  if (proposal.title != null && proposal.title !== current.title) {
    const empty = isBlankText(current.title);
    diffs.push({ key: "title", state: empty ? "fill" : "overwrite", current: current.title, proposed: proposal.title, defaultSelected: empty });
  }

  if (proposal.year != null && proposal.year !== current.year) {
    const empty = current.year === 0;
    diffs.push({ key: "year", state: empty ? "fill" : "overwrite", current: current.year, proposed: proposal.year, defaultSelected: empty });
  }

  if (proposal.region != null && proposal.region !== (current.region ?? "")) {
    const empty = isBlankText(current.region);
    diffs.push({ key: "region", state: empty ? "fill" : "overwrite", current: current.region ?? "", proposed: proposal.region, defaultSelected: empty });
  }

  // 위치는 lat/lng 한 쌍 — 백엔드(validate_metadata_apply)가 "둘 다 또는 둘 다 아님"을 강제하므로
  // 한 행·한 체크박스로 묶는다. region과는 별개 행(지역만 채우고 좌표는 안 받는 선택이 가능해야 함).
  if (proposal.lat != null && proposal.lng != null) {
    const currentEmpty = current.lat == null || current.lng == null;
    const same = !currentEmpty && current.lat === proposal.lat && current.lng === proposal.lng;
    if (!same) {
      diffs.push({
        key: "location",
        state: currentEmpty ? "fill" : "overwrite",
        current: currentEmpty ? null : { lat: current.lat as number, lng: current.lng as number },
        proposed: { lat: proposal.lat, lng: proposal.lng },
        defaultSelected: currentEmpty,
      });
    }
  }

  // 폴더는 모든 노트가 이미 어딘가에 속해 있어(root 포함) "비어 있음"이 없다 — 항상 덮어씀 취급,
  // 기본 미선택(§1 예시 다이어그램의 "미분류 → 조선 [덮어씀]"과 일치).
  if (proposal.folder_id != null && proposal.folder_id !== current.folder_id) {
    diffs.push({
      key: "folder_id",
      state: "overwrite",
      current: current.folder_id,
      proposed: proposal.folder_id,
      proposedName: proposal.folder_name ?? null,
      defaultSelected: false,
    });
  }

  // NoteSummary(A-2)는 source_urls를 안 들고 있어 diff할 "현재값"이 없다 — 항상 [추가] 배지,
  // 기본 선택(잃을 게 없다).
  if (proposal.source_urls && proposal.source_urls.length > 0) {
    diffs.push({ key: "source_urls", state: "add", proposed: proposal.source_urls, defaultSelected: true });
  }

  return diffs;
}

/** 기본으로 체크되는 필드 키 집합 — computeFieldDiffs 결과 전용. */
export function defaultSelectedFieldKeys(diffs: FieldDiff[]): Set<FieldDiffKey> {
  return new Set(diffs.filter((d) => d.defaultSelected).map((d) => d.key));
}

// ---- 태그 3구역 --------------------------------------------------------------

export interface TagZones {
  /** 현재∩제안 — 체크박스 없이 항상 살아남는다. */
  kept: string[];
  /** 제안에만 — 기본 선택(소프트캡 초과분 제외). */
  added: string[];
  /** 현재에만 — 기본 미선택(체크해야 지운다). */
  removed: string[];
  /** added 중 기본으로 체크된 부분집합(소프트캡). */
  defaultSelectedAdded: string[];
}

export function computeTagZones(
  currentTags: string[],
  proposedTags: string[] | null | undefined,
  softCap: number = TAG_APPLY_SOFT_CAP,
): TagZones {
  const proposed = proposedTags ?? [];
  const currentSet = new Set(currentTags);
  const proposedSet = new Set(proposed);
  const kept = currentTags.filter((tg) => proposedSet.has(tg));
  const added = proposed.filter((tg) => !currentSet.has(tg));
  const removed = currentTags.filter((tg) => !proposedSet.has(tg));
  return { kept, added, removed, defaultSelectedAdded: added.slice(0, softCap) };
}

/** 유지 ∪ 선택된 추가 ∪ (선택 안 된 제거) — §1 A-3의 최종 태그 집합 계산. */
export function computeFinalTagNames(
  currentTags: string[],
  selectedAdded: ReadonlySet<string>,
  selectedRemoved: ReadonlySet<string>,
): string[] {
  const result = new Set(currentTags);
  for (const tg of selectedRemoved) result.delete(tg);
  for (const tg of selectedAdded) result.add(tg);
  return Array.from(result);
}

/** Set-equality ignoring order — exported so buildRevertPayload can tell "tags were actually sent
 *  but happen to equal currentTags" (legacy no-selection callers send tag_names unconditionally,
 *  unlike the diffed fields) from a real tag change. */
export function sameTagSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const as = [...a].sort();
  const bs = [...b].sort();
  return as.every((tg, i) => tg === bs[i]);
}

/** finalTags가 currentTags와 같으면 undefined(백엔드로 안 보냄 = diff가 헛돌지 않게). */
export function tagNamesForApply(currentTags: string[], finalTags: string[]): string[] | undefined {
  return sameTagSet(currentTags, finalTags) ? undefined : finalTags;
}

// ---- 적용 페이로드 -------------------------------------------------------------

/** ai_apply_organize로 보낼 필드만 담은 부분 페이로드. 없는 키 = 건드리지 않음(Option::None).
 *  `clear_fields`/`remove_source_urls`는 순방향 적용(buildApplyPayload)에서는 절대 쓰이지 않고
 *  되돌리기(buildRevertPayload) 전용이다 — commands/ai.rs의 CLEARABLE_FIELDS와 짝. */
export interface AiApplySelectionPayload {
  title?: string;
  year?: number;
  region?: string;
  lat?: number;
  lng?: number;
  source_urls?: string[];
  folder_id?: string;
  tag_names?: string[];
  clear_fields?: string[];
  remove_source_urls?: string[];
}

/**
 * 선택된 필드만 골라 apply 페이로드로 변환한다. tagNames는 이미 tagNamesForApply를 거친
 * 값(undefined = 태그 변경 없음)을 그대로 전달한다.
 */
export function buildApplyPayload(
  diffs: FieldDiff[],
  selectedKeys: ReadonlySet<FieldDiffKey>,
  tagNames: string[] | undefined,
): AiApplySelectionPayload {
  const payload: AiApplySelectionPayload = {};
  for (const diff of diffs) {
    if (!selectedKeys.has(diff.key)) continue;
    switch (diff.key) {
      case "title":
        payload.title = diff.proposed;
        break;
      case "year":
        payload.year = diff.proposed;
        break;
      case "region":
        payload.region = diff.proposed;
        break;
      case "location":
        payload.lat = diff.proposed.lat;
        payload.lng = diff.proposed.lng;
        break;
      case "folder_id":
        payload.folder_id = diff.proposed;
        break;
      case "source_urls":
        payload.source_urls = diff.proposed;
        break;
    }
  }
  if (tagNames !== undefined) payload.tag_names = tagNames;
  return payload;
}

// ---- 되돌리기 페이로드 (A2) -----------------------------------------------------------

export interface RevertPayloadResult {
  /** ai_apply_organize로 보낼 역방향 페이로드 — 되돌릴 수 있는 필드만 담는다. */
  payload: AiApplySelectionPayload;
  /** 실제로 적용됐지만 이 함수가 되돌릴 방법이 없어 payload에서 뺀 필드 키(호출자가 토스트
   *  문구에 정직하게 반영). */
  unrevertableKeys: FieldDiffKey[];
}

/**
 * (적용 직전 diffs, 실제로 보낸 페이로드, 적용 전 태그 집합) → 역방향 ai_apply_organize 페이로드.
 * `diffs`는 적용 시점에 쓴 것과 같은 (current, proposal) 쌍으로 계산돼야 한다 — "current"가 곧
 * 되돌릴 목표값이다.
 *
 * ai_apply_organize의 값 인자(Option<T>)는 "손대지 않음"이지 "지움"이 아니다(§0 A-1) — 그래서
 * 원래 비어 있던 값으로 "되돌리는" 건 값을 보내는 것만으로는 표현 못 하는 필드가 있었다. J3
 * (commands/ai.rs의 `clear_fields`/`remove_source_urls`, CLEARABLE_FIELDS = location/region/year)
 * 가 그 간극을 메웠다 — 이제 전부 되돌릴 수 있다(unrevertableKeys는 항상 빈 배열):
 *   - location(채움 상태) — lat/lng는 둘 다 있거나 둘 다 없어야 하고 값으로 "지움"을 표현할
 *     방법이 없으므로 `clear_fields: ["location"]`을 쓴다. 덮어씀 상태(기존에 값이 있었음)는
 *     그 값으로 그대로 되돌린다(값 경로, clear_fields 아님).
 *   - source_urls — ai_apply_organize의 `source_urls` 입력은 추가 전용(add_link_if_absent_tx)
 *     이라 `remove_source_urls: [적용했던 URL들]`로 되돌린다.
 *   - region/year(채움 상태)는 그대로 값 경로를 쓴다(변경 안 함) — region의 빈 문자열은
 *     normalize_blank가 NULL로, year 0은 YEAR_MIN..YEAR_MAX 안이라 그대로 저장돼 clear_fields
 *     없이도 이미 정확히 되돌아간다. clear_fields로 바꿔도 결과는 같지만(백엔드가 같은 컬럼을
 *     같은 값으로 쓴다) 이미 맞는 경로를 바꿀 이유가 없다 — location처럼 값으로 "지움"을 표현할
 *     방법이 없는 필드에만 clear_fields를 쓴다.
 *
 * title/year/region/folder_id는 채움 상태여도 값 경로로 되돌릴 수 있다 — apply_ai_organize_in_tx는
 * title을 그대로 저장하고(정규화 없음), year 0은 YEAR_MIN..YEAR_MAX 안이고, region은 빈 문자열을
 * normalize_blank로 정상적으로 NULL로 되돌리고, folder_id는 애초에 "비어 있음"이 없다(모든
 * 노트가 폴더에 속함).
 */
export function buildRevertPayload(
  diffs: FieldDiff[],
  appliedPayload: AiApplySelectionPayload,
  currentTags: string[],
): RevertPayloadResult {
  const payload: AiApplySelectionPayload = {};
  const unrevertableKeys: FieldDiffKey[] = [];
  for (const diff of diffs) {
    switch (diff.key) {
      case "title":
        if (appliedPayload.title !== undefined) payload.title = diff.current;
        break;
      case "year":
        if (appliedPayload.year !== undefined) payload.year = diff.current;
        break;
      case "region":
        if (appliedPayload.region !== undefined) payload.region = diff.current;
        break;
      case "location":
        if (appliedPayload.lat !== undefined && appliedPayload.lng !== undefined) {
          if (diff.state === "overwrite" && diff.current) {
            payload.lat = diff.current.lat;
            payload.lng = diff.current.lng;
          } else {
            // Fill state: target is "empty", which no lat/lng value can express (Option::None
            // reads as "don't touch") — clear_fields is the only way to actually erase it.
            payload.clear_fields = [...(payload.clear_fields ?? []), "location"];
          }
        }
        break;
      case "folder_id":
        if (appliedPayload.folder_id !== undefined) payload.folder_id = diff.current;
        break;
      case "source_urls":
        // add_link_if_absent_tx only ever adds — removing what this apply added needs the
        // dedicated remove_source_urls input (its delete-path counterpart).
        if (appliedPayload.source_urls !== undefined) payload.remove_source_urls = appliedPayload.source_urls;
        break;
    }
  }
  // Unlike the diffed fields above (computeFieldDiffs already drops a "same" row), the legacy
  // no-selection apply path sends tag_names unconditionally whenever the proposal has any —
  // even when it's identical to currentTags. Only offer a tag revert when applying it actually
  // changed something.
  if (appliedPayload.tag_names !== undefined && !sameTagSet(appliedPayload.tag_names, currentTags)) {
    payload.tag_names = currentTags;
  }
  return { payload, unrevertableKeys };
}

// ---- 되돌리기 직전 편집 경합 확인 (WF F2) ---------------------------------------------

/**
 * 되돌리기를 실행하기 전, 노트의 CURRENT 값이 아직 "이 apply가 써넣은 값"과 같은지 확인한다.
 * 15초 되돌리기 창 안에서 사용자가 제목 등을 직접 고쳤다면, 그 편집을 되돌리기가 덮어써서는 안
 * 된다 — false를 반환하면 호출자는 되돌리기를 건너뛰고 안내만 띄운다.
 *
 * `applied`에 없는 키(undefined)는 애초에 이 apply가 손대지 않은 필드이므로 비교 대상이 아니다.
 * source_urls는 비교하지 않는다 — NoteSummary가 현재값을 들고 있지 않고(A-2), 애초에
 * buildRevertPayload가 항상 unrevertable로 빼서 revertPayload에 실리지 않는다.
 * 필드 단위 부분 되돌리기는 하지 않는다(ponytail) — 하나라도 어긋나면 전체를 건너뛴다.
 */
export function appliedValuesStillMatch(applied: AiApplySelectionPayload, current: CurrentNoteFields): boolean {
  if (applied.title !== undefined && current.title !== applied.title) return false;
  if (applied.year !== undefined && current.year !== applied.year) return false;
  if (applied.region !== undefined && (current.region ?? "") !== applied.region) return false;
  if (applied.lat !== undefined && applied.lng !== undefined) {
    if (current.lat !== applied.lat || current.lng !== applied.lng) return false;
  }
  if (applied.folder_id !== undefined && current.folder_id !== applied.folder_id) return false;
  if (applied.tag_names !== undefined && !sameTagSet(current.tag_names ?? [], applied.tag_names)) return false;
  return true;
}
