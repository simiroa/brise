// repo::ai::prompts — 프롬프트 합성(태그 어휘 랭킹/organize 계약/번역·정리·생성 시스템 프롬프트)
// + 모델 응답 파싱(extract_json). mod.rs의 propose_inner/translate_inner류가 여기 함수들을
// 호출하고, resolve_folder_name/tag_vocabulary_top/extract_json은 commands 계층까지 그대로
// 재수출된다(ai/mod.rs의 `pub use prompts::...`).
use crate::error::{AppError, AppResult};

/// Cap on notebook(=workspace) tag names injected into the organize system prompt as candidate
/// vocabulary. Bounds prompt size while covering the common long-tail of tags; the model may still
/// invent up to 3 new tags when none of these fit (see `organize_format_contract`).
pub const AI_TAG_VOCAB_CAP: usize = 50;

/// Pure rank of `(name, frequency)` pairs for the AI tag vocabulary: frequency descending, then
/// name ascending for deterministic ties. Takes at most `cap` names. Callers pass
/// [`crate::repo::notes::tag_counts`] output (or any equivalent).
pub fn tag_vocabulary_top(counts: &[(String, i64)], cap: usize) -> Vec<String> {
    let mut items: Vec<(&str, i64)> = counts.iter().map(|(n, c)| (n.as_str(), *c)).collect();
    items.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    items.into_iter().take(cap).map(|(n, _)| n.to_string()).collect()
}

/// OUTPUT CONTRACT — apply 경로(ai_apply_organize)가 그대로 기대하는 JSON 필드 이름/형식.
/// **사용자가 절대 편집할 수 없는 부분**(settings의 "메타데이터" 프리셋 프롬프트는 여기 아래
/// compose_organize_system_prompt의 custom_guidance로만 들어간다 — 이 계약 문자열 자체는 항상
/// 그대로 전송된다). candidate_folders / candidate_tags는 워크스페이스마다/호출마다 달라지므로
/// 상수가 아니라 함수로 만든다 — folder·tags 필드 규칙을 실제 후보 이름으로 채워 넣어야 모델이
/// 없는 폴더를 지어내지 않고, 태그는 노트북 어휘를 우선한다.
fn organize_format_contract(candidate_folders: &[String], candidate_tags: &[String]) -> String {
    let folder_rule = if candidate_folders.is_empty() {
        "- folder: no folders exist in this workspace (or none were requested) — omit this field.".to_string()
    } else {
        let names = candidate_folders
            .iter()
            .map(|f| format!("\"{f}\""))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "- folder: choose EXACTLY ONE name from this list if the note clearly belongs there: {names}. \
             Never invent a folder name that isn't in this list. If no folder clearly fits, omit this field \
             entirely — proposing no folder is a valid and expected outcome for ambiguous notes."
        )
    };
    let tag_rule = if candidate_tags.is_empty() {
        "- tags: 1..6 short tokens (no spaces; use hyphens), lowercase, deduplicated. \
         No existing notebook tags yet — invent only what clearly fits the note (still ≤6 total)."
            .to_string()
    } else {
        let names = candidate_tags
            .iter()
            .map(|t| format!("\"{t}\""))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "- tags: 1..6 short tokens (no spaces; use hyphens), lowercase, deduplicated. \
             Prefer tags from this notebook vocabulary: {names}. \
             Only invent NEW tags when none of the vocabulary entries fit — at most 3 new tags. \
             Final total must not exceed 6 tags."
        )
    };
    format!(
        r#"You organize notes into metadata. Output STRICT JSON:
{{"title": string (optional), "year": integer (optional, between -9999 and 9999), "tags": string[] (optional), "region": string (optional), "folder": string (optional), "confidence": number 0..1}}
Rules:
- title: concise (<=80 chars), no quotes, no trailing period.
- year: relevant year explicitly stated or directly inferred from the note's subject.
{tag_rule}
- region: geographical region or place name relevant to the note.
{folder_rule}
- confidence: 0.0~1.0 reflecting how confident the model is in the proposal.
  Only output fields requested or relevant."#
    )
}

/// backend 고정 계약(organize_format_contract) + 사용자 guidance를 합성한다. 이 합성 순서 자체가
/// "무엇을 사용자가 바꿀 수 있는지"의 실제 구현이다 — custom_guidance는 계약 뒤에 별도 섹션으로만
/// 덧붙기 때문에, 우선순위/톤/도메인 힌트 같은 지시는 더할 수 있어도 JSON 스키마(필드 이름·형식)
/// 자체를 재정의할 수 없다(모델이 그 구분을 완벽히 지킨다는 보장은 없지만, 최소한 백엔드가
/// 실제로 전송하는 문자열에는 계약 부분이 항상 그대로 포함된다 — 사용자가 프롬프트를 통째로
/// 비워도 계약은 남는다). settings.AiActionsSection의 "메타데이터" 프리셋 프롬프트가 여기
/// custom_guidance로 들어온다(commands::ai::ai_organize_note_inner의 custom_prompt 파라미터).
/// Global metadata prompt + folder rules. Folder rules come last so they override/extend
/// the notebook-wide guidance for notes that live in that folder.
pub fn merge_organize_guidance(global: Option<&str>, folder_rules: Option<&str>) -> Option<String> {
    let global = global.map(str::trim).filter(|s| !s.is_empty());
    let folder = folder_rules.map(str::trim).filter(|s| !s.is_empty());
    match (global, folder) {
        (Some(g), Some(f)) => Some(format!(
            "{g}\n\n--- Folder rules (override / extend the guidance above for notes in this folder) ---\n{f}"
        )),
        (Some(g), None) => Some(g.to_string()),
        (None, Some(f)) => Some(f.to_string()),
        (None, None) => None,
    }
}

pub fn compose_organize_system_prompt(
    candidate_folders: &[String],
    candidate_tags: &[String],
    custom_guidance: Option<&str>,
) -> String {
    let contract = organize_format_contract(candidate_folders, candidate_tags);
    match custom_guidance.map(|g| g.trim()).filter(|g| !g.is_empty()) {
        Some(guidance) => format!(
            "{contract}\n\n--- Additional guidance from the user (what to prioritize / tone / domain hints — does NOT change the JSON schema above) ---\n{guidance}"
        ),
        None => contract,
    }
}

/// 모델이 고른 폴더 이름(raw)을 워크스페이스 후보 목록((id, name) 쌍)과 대조해 id로 바꾼다.
/// 정확히 일치하는 이름을 우선 찾고, 없으면 대소문자·양끝 공백을 무시한 일치를 시도한다. 그래도
/// 없으면(모델이 지어냈거나 철자가 다름) None — 폴더 제안을 아예 뺀다. "제안 없음"이 fallback이
/// 아니라 valid outcome이므로 여기서 억지로 가장 비슷한 것을 고르지 않는다.
pub fn resolve_folder_name(chosen: &str, candidates: &[(String, String)]) -> Option<(String, String)> {
    let trimmed = chosen.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some((id, name)) = candidates.iter().find(|(_, name)| name == trimmed) {
        return Some((id.clone(), name.clone()));
    }
    let lower = trimmed.to_lowercase();
    candidates
        .iter()
        .find(|(_, name)| name.trim().to_lowercase() == lower)
        .map(|(id, name)| (id.clone(), name.clone()))
}

/// 펜스(```json … ```)를 벗겨 JSON 으로 파싱한다. 원래 AiProposal 전용이었으나 펫 채팅의
/// 액션 봉투(repo::pet::PetAction)도 "모델이 낸 JSON 한 덩이"라는 점에서 완전히 같아 제네릭으로
/// 열었다 — 호출부의 반환 타입에서 T 가 추론된다(기존 organize 경로는 그대로 AiProposal).
/// 모델이 앞뒤에 짧은 인사말이나 부연 설명을 붙여도 첫 '{'부터 마지막 '}' 구간을 잘라 파싱한다.
pub fn extract_json<T: serde::de::DeserializeOwned>(text: &str) -> AppResult<T> {
    let mut s = text.trim();
    if let Some(rest) = s.strip_prefix("```json") {
        s = rest;
    } else if let Some(rest) = s.strip_prefix("```") {
        s = rest;
    }
    if let Some(rest) = s.strip_suffix("```") {
        s = rest;
    }
    s = s.trim();

    let slice = match (s.find('{'), s.rfind('}')) {
        (Some(start), Some(end)) if start <= end => &s[start..=end],
        _ => s,
    };

    serde_json::from_str(slice).map_err(|e| AppError::Validation(format!("failed to parse JSON from AI: {e}")))
}

pub(super) fn translate_system_prompt(target_lang: &str) -> String {
    format!(
        "You are a translation engine. Translate the user's text into {target_lang}. \
         Respond with ONLY the translated text in {target_lang} — no explanations, no quotes, \
         no markdown code fences, no commentary. Preserve the original paragraph breaks."
    )
}

pub(super) fn cleanup_system_prompt() -> String {
    "You clean up and lightly restructure the user's note text. Keep the SAME language as the \
     input. Fix grammar/typos/awkward phrasing, organize into clear paragraphs or lists where it \
     helps readability, remove filler — but preserve all factual content and meaning. Never invent \
     new information that isn't in the input. Respond with ONLY the cleaned text (markdown allowed) \
     — no explanations, no commentary, no code fences.".to_string()
}

/// 펫 "화면 저장"의 비전 요약(docs/PLAN-2026-08-09-pet-capture.md Phase 1). 노트에 그대로
/// 들어갈 본문이라 "이미지에는/스크린샷에는" 같은 메타 서술이 아니라 **내용 자체**를 쓰게 한다.
pub(super) fn screenshot_system_prompt() -> String {
    "You summarize a screenshot of one application window so it can be saved as a note. Write 2-4 \
     sentences describing what the window actually shows: the topic, the key facts, names, numbers \
     or code visible in it. Write in the same language as the text in the screenshot (default to \
     Korean if there is no text). Do NOT describe the user interface itself (buttons, tabs, window \
     chrome) unless that IS the content, and never start with phrases like \"This screenshot \
     shows\" — write the content directly. Respond with ONLY the summary, no markdown fences, no \
     commentary."
        .to_string()
}

pub fn generate_system_prompt(purpose: Option<&str>) -> String {
    match purpose {
        Some("transform") => {
            "You transform the provided note content according to instructions. The provided note context \
             is the PRIMARY INPUT, not optional background. Output ONLY the transformed result (markdown allowed) \
             — no explanations, no commentary, no code fences."
                .to_string()
        }
        Some("json") => {
            "You produce structured data in valid JSON format. Output ONLY a single JSON object. \
             No explanations, no markdown formatting, no code fences."
                .to_string()
        }
        _ => {
            "You write new content based on the user's request. If existing note context is provided \
             below, use it as optional background ONLY where relevant to the request — you may ignore it \
             entirely if it doesn't help, and you may write content that goes beyond it. Respond with ONLY \
             the generated content (markdown allowed) — no explanations, no commentary, no code fences."
                .to_string()
        }
    }
}

#[cfg(test)]
mod folder_and_prompt_composition_tests {
    use super::*;
    use crate::repo::ai::AiProposal;

    fn candidates() -> Vec<(String, String)> {
        vec![
            ("id-1".to_string(), "여행".to_string()),
            ("id-2".to_string(), "Work Notes".to_string()),
        ]
    }

    #[test]
    fn resolve_folder_name_exact_match() {
        let resolved = resolve_folder_name("Work Notes", &candidates());
        assert_eq!(resolved, Some(("id-2".to_string(), "Work Notes".to_string())));
    }

    #[test]
    fn resolve_folder_name_case_insensitive_trim_match() {
        let resolved = resolve_folder_name("  work notes  ", &candidates());
        assert_eq!(resolved, Some(("id-2".to_string(), "Work Notes".to_string())));
    }

    #[test]
    fn resolve_folder_name_unresolved_is_omitted_not_guessed() {
        // 모델이 지어낸/철자가 다른 이름 — 가장 비슷한 후보를 억지로 고르지 않고 None.
        assert_eq!(resolve_folder_name("Work Note", &candidates()), None);
        assert_eq!(resolve_folder_name("존재하지않는폴더", &candidates()), None);
        assert_eq!(resolve_folder_name("", &candidates()), None);
        assert_eq!(resolve_folder_name("   ", &candidates()), None);
    }

    #[test]
    fn resolve_folder_name_empty_candidates_always_none() {
        assert_eq!(resolve_folder_name("Work Notes", &[]), None);
    }

    #[test]
    fn format_contract_lists_candidate_names_and_forbids_inventing() {
        let names = vec!["여행".to_string(), "Work Notes".to_string()];
        let contract = organize_format_contract(&names, &[]);
        assert!(contract.contains("\"여행\""));
        assert!(contract.contains("\"Work Notes\""));
        assert!(contract.contains("Never invent a folder name"));
    }

    #[test]
    fn format_contract_empty_candidates_tells_model_to_omit() {
        let contract = organize_format_contract(&[], &[]);
        assert!(contract.contains("omit this field"));
        assert!(!contract.contains("Never invent"));
    }

    #[test]
    fn format_contract_lists_tag_vocabulary_and_new_tag_cap() {
        let tags = vec!["history".to_string(), "france".to_string()];
        let contract = organize_format_contract(&[], &tags);
        assert!(contract.contains("notebook vocabulary"));
        assert!(contract.contains("\"history\""));
        assert!(contract.contains("\"france\""));
        assert!(contract.contains("at most 3 new tags"));
        assert!(contract.contains("not exceed 6 tags"));
    }

    #[test]
    fn format_contract_empty_tag_vocab_still_builds_without_list() {
        // Fresh notebook — no vocabulary yet; prompt must still be valid and not claim a list.
        let contract = organize_format_contract(&[], &[]);
        assert!(contract.contains("No existing notebook tags yet"));
        assert!(!contract.contains("notebook vocabulary:"));
        assert!(contract.contains("1..6 short tokens"));
    }

    #[test]
    fn compose_without_custom_guidance_is_just_the_contract() {
        let names = vec!["A".to_string()];
        let tags = vec!["t1".to_string()];
        let composed = compose_organize_system_prompt(&names, &tags, None);
        assert_eq!(composed, organize_format_contract(&names, &tags));
    }

    #[test]
    fn compose_with_custom_guidance_keeps_format_contract_and_appends_guidance() {
        let names = vec!["A".to_string()];
        let tags: Vec<String> = vec![];
        let contract = organize_format_contract(&names, &tags);
        let composed =
            compose_organize_system_prompt(&names, &tags, Some("역사적 사실 위주로 우선 판단해줘"));
        // 계약(JSON 스키마)은 그대로 앞부분에 항상 포함된다 — 사용자 guidance가 이를 대체하지 않는다.
        assert!(composed.starts_with(&contract));
        assert!(composed.contains("역사적 사실 위주로 우선 판단해줘"));
    }

    #[test]
    fn compose_blank_custom_guidance_falls_back_to_contract_only() {
        let names: Vec<String> = vec![];
        let tags: Vec<String> = vec![];
        let composed = compose_organize_system_prompt(&names, &tags, Some("   "));
        assert_eq!(composed, organize_format_contract(&names, &tags));
    }

    #[test]
    fn merge_organize_guidance_folder_rules_follow_and_override_global() {
        let merged = merge_organize_guidance(Some("keep titles short"), Some("prefer year from the title"));
        let text = merged.expect("both sides present");
        assert!(text.starts_with("keep titles short"));
        assert!(text.contains("Folder rules"));
        assert!(text.contains("prefer year from the title"));
        assert_eq!(merge_organize_guidance(None, Some("  folder only  ")).as_deref(), Some("folder only"));
        assert_eq!(merge_organize_guidance(Some("  global  "), None).as_deref(), Some("global"));
        assert_eq!(merge_organize_guidance(Some("   "), Some("")), None);
    }

    #[test]
    fn tag_vocabulary_top_orders_by_freq_desc_then_name_asc_and_caps() {
        let counts = vec![
            ("zebra".to_string(), 5),
            ("alpha".to_string(), 10),
            ("beta".to_string(), 10), // tie with alpha → name asc: alpha before beta
            ("gamma".to_string(), 1),
            ("delta".to_string(), 3),
        ];
        let top = tag_vocabulary_top(&counts, 3);
        assert_eq!(top, vec!["alpha", "beta", "zebra"]);
        let capped = tag_vocabulary_top(&counts, 2);
        assert_eq!(capped, vec!["alpha", "beta"]);
        assert_eq!(tag_vocabulary_top(&[], AI_TAG_VOCAB_CAP), Vec::<String>::new());
        // Cap constant is 50 — verify named const is what callers should pass.
        assert_eq!(AI_TAG_VOCAB_CAP, 50);
    }

    /// A6: fenced model output still parses to AiProposal.
    #[test]
    fn extract_json_strips_markdown_fences() {
        let raw = "```json\n{\"title\":\"T\",\"year\":1443,\"confidence\":0.5}\n```";
        let p = extract_json::<AiProposal>(raw).unwrap();
        assert_eq!(p.title.as_deref(), Some("T"));
        assert_eq!(p.year, Some(1443));

        let raw2 = "```\n{\"confidence\":0.2}\n```";
        let p2 = extract_json::<AiProposal>(raw2).unwrap();
        assert!((p2.confidence - 0.2).abs() < f32::EPSILON);
    }

    #[test]
    fn extract_json_slices_first_to_last_brace_with_commentary() {
        let raw = "Here is your metadata:\n```json\n{\"title\":\"Joseon\",\"year\":1392,\"confidence\":0.9}\n```\nHope this helps!";
        let p = extract_json::<AiProposal>(raw).unwrap();
        assert_eq!(p.title.as_deref(), Some("Joseon"));
        assert_eq!(p.year, Some(1392));

        let raw_no_fence = "Sure! {\"title\":\"Goryeo\",\"year\":918,\"confidence\":0.8} Have a nice day.";
        let p2 = extract_json::<AiProposal>(raw_no_fence).unwrap();
        assert_eq!(p2.title.as_deref(), Some("Goryeo"));
        assert_eq!(p2.year, Some(918));
    }

    #[test]
    fn generate_system_prompt_branches_by_purpose() {
        let transform_prompt = generate_system_prompt(Some("transform"));
        assert!(transform_prompt.contains("PRIMARY INPUT"));
        assert!(transform_prompt.contains("Output ONLY the transformed result"));

        let json_prompt = generate_system_prompt(Some("json"));
        assert!(json_prompt.contains("structured data in valid JSON format"));
        assert!(json_prompt.contains("Output ONLY a single JSON object"));

        let generate_prompt = generate_system_prompt(Some("generate"));
        assert!(generate_prompt.contains("PRIMARY INPUT") == false);
        assert!(generate_prompt.contains("optional background ONLY"));

        let default_prompt = generate_system_prompt(None);
        assert_eq!(default_prompt, generate_prompt);
    }
}
