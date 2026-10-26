// 불변성: 구현된 #[tauri::command] 는 모두 lib.rs 의 invoke_handler! 에 등록된다.
// specs/tests/invariant-command-registry.yaml 시나리오 1:1
//
// 왜 필요한가: folder_files 와 export_folder 는 구현·스펙·프론트 호출이 전부 존재했는데
// lib.rs 등록만 빠져 있어서, 컨텍스트 메뉴의 "폴더 파일 보기"/"폴더 내보내기"가 런타임에
// 조용히 실패하고 있었다. 컴파일도 테스트도 통과하는 종류의 누락이라 사람이 못 잡는다.
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// commands/*.rs 에서 `#[tauri::command...]` 바로 다음에 오는 `pub fn NAME` 을 수집.
fn implemented_commands() -> BTreeSet<String> {
    let dir = manifest_dir().join("src").join("commands");
    let mut out = BTreeSet::new();
    for entry in fs::read_dir(dir).expect("read commands dir") {
        let path = entry.expect("dir entry").path();
        if path.extension().map_or(true, |e| e != "rs") {
            continue;
        }
        let text = fs::read_to_string(&path).expect("read command file");
        let lines: Vec<&str> = text.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if !line.trim_start().starts_with("#[tauri::command") {
                continue;
            }
            // attribute 다음의 첫 `pub fn` 을 찾는다 (사이에 다른 attribute 가 올 수 있다).
            for next in lines.iter().skip(i + 1).take(5) {
                let t = next.trim_start();
                if let Some(rest) = t.strip_prefix("pub fn ") {
                    let name: String = rest
                        .chars()
                        .take_while(|c| c.is_alphanumeric() || *c == '_')
                        .collect();
                    if !name.is_empty() {
                        out.insert(name);
                    }
                    break;
                }
                if t.starts_with("pub async fn ") {
                    let rest = t.trim_start_matches("pub async fn ");
                    let name: String = rest
                        .chars()
                        .take_while(|c| c.is_alphanumeric() || *c == '_')
                        .collect();
                    if !name.is_empty() {
                        out.insert(name);
                    }
                    break;
                }
            }
        }
    }
    out
}

/// lib.rs 의 generate_handler![...] 안에 나열된 `commands::module::name` 의 name 을 수집.
fn registered_commands() -> BTreeSet<String> {
    let text = fs::read_to_string(manifest_dir().join("src").join("lib.rs")).expect("read lib.rs");
    let start = text.find("generate_handler!").expect("generate_handler! not found");
    let end = text[start..].find(']').expect("handler list not closed") + start;
    let mut out = BTreeSet::new();
    for seg in text[start..end].split(',') {
        let seg = seg.trim();
        if let Some(name) = seg.rsplit("::").next() {
            let name = name.trim();
            if !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_') {
                out.insert(name.to_string());
            }
        }
    }
    out
}

#[test]
fn every_implemented_command_is_registered() {
    let implemented = implemented_commands();
    let registered = registered_commands();
    assert!(
        !implemented.is_empty() && !registered.is_empty(),
        "parser found nothing — implemented={}, registered={}",
        implemented.len(),
        registered.len()
    );

    let missing: Vec<&String> = implemented.difference(&registered).collect();
    assert!(
        missing.is_empty(),
        "이 커맨드들은 구현되어 있지만 lib.rs 의 invoke_handler! 에 등록되지 않았다 \
         (호출 시 런타임 실패): {missing:?}"
    );
}

/// dispatch.gen.rs 의 `"cmd_name" => {` match arm 헤더를 그대로 스캔(implemented_commands() 와
/// 같은 텍스트 파싱 방식) — sync_server::dispatch::dispatch() 가 실제로 호출하는 커맨드 이름 목록.
fn dispatch_gen_commands() -> BTreeSet<String> {
    let text = fs::read_to_string(
        manifest_dir().join("src").join("sync_server").join("dispatch.gen.rs"),
    )
    .expect("read dispatch.gen.rs — run `node scripts/gen-commands.mjs` first");
    let mut out = BTreeSet::new();
    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix('"') {
            if let Some(end) = rest.find('"') {
                if rest[end..].trim_start_matches('"').trim_start().starts_with("=>") {
                    out.insert(rest[..end].to_string());
                }
            }
        }
    }
    out
}

/// 불변성: dispatch.gen.rs 의 모든 match arm 은 실제로 구현된(#[tauri::command]) 커맨드를
/// 가리킨다 — 이름이 바뀌었는데 스펙이 안 따라온 드리프트를 잡는다. dispatch.gen.rs가 완전한지
/// (즉, http:true 스펙 커맨드가 전부 arm을 갖는지)는 이 테스트가 아니라 생성기 자체가 강제한다:
/// scripts/gen-commands.mjs::parseRustField 는 매핑할 수 없는 input 필드를 만나면 예외를 던져
/// node 스크립트가 실패하고(빌드 게이트: `node scripts/gen-commands.mjs` 를 CI에서 매번 재실행 +
/// diff 확인), dispatch.gen.rs는 커밋된 산출물이라 실제로 컴파일되는 코드 자체가 시그니처
/// exhaustiveness의 증거다(타입이 안 맞으면 cargo build가 실패한다) — 별도의 YAML 파서를
/// Rust 쪽에 또 두지 않는다.
#[test]
fn every_dispatch_gen_arm_points_at_an_implemented_command() {
    let implemented = implemented_commands();
    let dispatched = dispatch_gen_commands();
    assert!(
        !dispatched.is_empty(),
        "parser found no match arms in dispatch.gen.rs — did the file format change?"
    );

    let missing: Vec<&String> = dispatched.difference(&implemented).collect();
    assert!(
        missing.is_empty(),
        "dispatch.gen.rs 가 구현되지 않은(또는 이름이 바뀐) 커맨드를 가리키고 있다 — \
         `node scripts/gen-commands.mjs` 를 다시 실행했는지 확인: {missing:?}"
    );
}
