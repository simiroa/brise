use std::fs;
use std::path::PathBuf;

#[test]
fn test_all_commands_have_snake_case_rename() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let commands_dir = PathBuf::from(manifest_dir).join("src").join("commands");

    let entries = fs::read_dir(commands_dir).expect("Failed to read commands directory");

    for entry in entries {
        let entry = entry.expect("Failed to read entry");
        let path = entry.path();
        if path.is_file() && path.extension().map_or(false, |ext| ext == "rs") {
            let content = fs::read_to_string(&path).expect("Failed to read file");
            let mut command_count = 0;
            let mut snake_case_count = 0;

            for (i, line) in content.lines().enumerate() {
                // 주석 줄은 세지 않는다 — 문서 주석이 `#[tauri::command]` 를 **설명하려고**
                // 인용하는 자리가 실재한다(commands/collect.rs 의 rename_all 설명 주석). 그걸
                // 속성으로 세면 "속성 15개 중 14개만 rename_all" 같은 오탐이 나고, 그 오탐이
                // 진짜 위반을 덮는다(실제로 덮고 있었다 — 2026-09-07).
                if line.trim_start().starts_with("//") {
                    continue;
                }
                if line.contains("#[tauri::command") {
                    command_count += 1;
                    if line.contains("rename_all = \"snake_case\"") {
                        snake_case_count += 1;
                    } else {
                        eprintln!("{}:{}: Missing rename_all=\"snake_case\"", path.display(), i + 1);
                    }
                }
            }

            assert_eq!(
                command_count, snake_case_count,
                "File {} has {} tauri::command attributes but only {} have rename_all=\"snake_case\"",
                path.display(), command_count, snake_case_count
            );
        }
    }
}
